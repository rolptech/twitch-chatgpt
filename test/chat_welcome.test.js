// test/chat_welcome.test.js
//
// Run with: node --test
//
// first-msg=1 is Twitch's "First Time Chat" tag — first message on the CHANNEL
// ever, not first this stream [dev.twitch.tv/docs/irc/tags, confirmed 15 Aug
// 2026]. There is no per-stream tag, which is why this module tracks it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatWelcome } from '../chat_welcome.js';
import { sayChunked } from '../chunk_text.js';

function makeHarness(opts = {}) {
    const sayCalls = [];
    const claudeCalls = [];
    const logs = [];
    const instance = createChatWelcome({
        say: (channel, message) => sayCalls.push({ channel, message }),
        claudeCall: async (prompt) => {
            claudeCalls.push(prompt);
            if (opts.claudeThrows) throw new Error('claude exploded');
            return opts.claudeReply !== undefined ? opts.claudeReply : 'Welcome in!';
        },
        broadcaster: 'mind_prime',
        sayChunkedFn: sayChunked,
        delaySec: 0,                      // instant in tests unless overridden
        log: (...a) => logs.push(a.join(' ')),
        ...opts.overrides,
    });
    return { instance, sayCalls, claudeCalls, logs };
}

const viewer = (name, extra = {}) => ({ username: name.toLowerCase(), 'display-name': name, ...extra });
const settle = () => new Promise((r) => setTimeout(r, 20));

// --- first-per-stream ---------------------------------------------------

test('welcomes a viewer on their first message', async () => {
    const h = makeHarness({ claudeReply: 'Good to see you @Hpac13!' });
    assert.equal(h.instance.onMessage('#chan', viewer('Hpac13'), 'hi'), true);
    await settle();
    assert.deepEqual(h.sayCalls, [{ channel: '#chan', message: 'Good to see you @Hpac13!' }]);
});

test('⛔ does NOT welcome them again for later messages', async () => {
    const h = makeHarness();
    h.instance.onMessage('#chan', viewer('Hpac13'), 'hi');
    h.instance.onMessage('#chan', viewer('Hpac13'), 'still here');
    h.instance.onMessage('#chan', viewer('Hpac13'), 'and again');
    await settle();
    assert.equal(h.sayCalls.length, 1);
});

test('⛔ two messages in the same tick still produce ONE welcome', async () => {
    // The name is marked BEFORE the async work; otherwise both pass the check.
    const h = makeHarness();
    h.instance.onMessage('#chan', viewer('Hpac13'), 'hi');
    h.instance.onMessage('#chan', viewer('Hpac13'), 'hi again');
    await settle();
    assert.equal(h.sayCalls.length, 1);
});

test('different viewers each get one', async () => {
    const h = makeHarness();
    for (const n of ['Hpac13', 'MinaEllyse', 'UweGLE']) h.instance.onMessage('#chan', viewer(n), 'hi');
    await settle();
    assert.equal(h.sayCalls.length, 3);
});

test('matching is case-insensitive on the login', async () => {
    const h = makeHarness();
    h.instance.onMessage('#chan', { username: 'hpac13', 'display-name': 'Hpac13' }, 'hi');
    h.instance.onMessage('#chan', { username: 'HPAC13', 'display-name': 'HPAC13' }, 'hi');
    await settle();
    assert.equal(h.sayCalls.length, 1);
});

// --- the reset ----------------------------------------------------------

test('⛔ reset clears the list so the next stream welcomes everyone again', async () => {
    // Without this the set grows forever and nobody is welcomed twice — which
    // looks identical to the feature being broken, because the symptom is silence.
    const h = makeHarness();
    h.instance.onMessage('#chan', viewer('Hpac13'), 'hi');
    await settle();
    assert.equal(h.sayCalls.length, 1);

    h.instance.reset('stream.online');
    assert.equal(h.instance.seenCount, 0);

    h.instance.onMessage('#chan', viewer('Hpac13'), 'hi');
    await settle();
    assert.equal(h.sayCalls.length, 2);
});

test('the reset is logged with its reason', () => {
    const h = makeHarness();
    h.instance.onMessage('#chan', viewer('Hpac13'), 'hi');
    h.instance.reset('stream.online');
    assert.ok(h.logs.some((l) => /chat-welcome reset \(stream\.online\)/.test(l)));
});

// --- exclusions ---------------------------------------------------------

test('⛔ bots are never welcomed', async () => {
    const h = makeHarness();
    for (const b of ['StreamElements', 'Sery_Bot', 'StreamDjBot', 'Mind_B0t', 'Nightbot']) {
        assert.equal(h.instance.onMessage('#chan', viewer(b), 'beep'), false, `${b} must be excluded`);
    }
    await settle();
    assert.equal(h.claudeCalls.length, 0);
    assert.equal(h.sayCalls.length, 0);
});

test('⛔ the broadcaster is never welcomed', async () => {
    const h = makeHarness();
    assert.equal(h.instance.onMessage('#chan', viewer('Mind_Prime'), 'hi all'), false);
    await settle();
    assert.equal(h.sayCalls.length, 0);
});

test('a nameless user is ignored rather than welcomed as undefined', async () => {
    const h = makeHarness();
    assert.equal(h.instance.onMessage('#chan', {}, 'hi'), false);
    assert.equal(h.instance.onMessage('#chan', null, 'hi'), false);
    await settle();
    assert.equal(h.sayCalls.length, 0);
});

// --- the two lengths ----------------------------------------------------

test('a first-time-ever chatter gets 2 sentences and context', async () => {
    const h = makeHarness();
    h.instance.onMessage('#chan', viewer('NewPerson', { 'first-msg': '1' }), 'hello');
    await settle();
    const p = h.claudeCalls[0];
    assert.match(p, /FIRST-TIME CHATTER/);
    assert.match(p, /EXACTLY 2 SENTENCES/);
    assert.match(p, /Kosmische, Berlin School and Trance/);
});

test('a returning regular gets 1 sentence and no channel explainer', async () => {
    // At 20-40 welcomes a stream, anything longer turns chat into bot.
    const h = makeHarness();
    h.instance.onMessage('#chan', viewer('Hpac13'), 'hello');
    await settle();
    const p = h.claudeCalls[0];
    assert.match(p, /ARRIVING/);
    assert.match(p, /EXACTLY 1 SENTENCE\./);
    assert.doesNotMatch(p, /Kosmische, Berlin School and Trance/);
});

test('first-msg is accepted as string "1" or boolean true', async () => {
    for (const v of ['1', true]) {
        const h = makeHarness();
        h.instance.onMessage('#chan', viewer('X', { 'first-msg': v }), 'hi');
        await settle();
        assert.match(h.claudeCalls[0], /FIRST-TIME CHATTER/, `first-msg=${JSON.stringify(v)}`);
    }
});

test('first-msg=0 is a regular, not a first-timer', async () => {
    const h = makeHarness();
    h.instance.onMessage('#chan', viewer('X', { 'first-msg': '0' }), 'hi');
    await settle();
    assert.match(h.claudeCalls[0], /ARRIVING/);
});

test('every prompt @s them and forbids inventing facts', async () => {
    for (const first of [true, false]) {
        const h = makeHarness();
        h.instance.onMessage('#chan', viewer('Someone', first ? { 'first-msg': '1' } : {}), 'hi');
        await settle();
        assert.match(h.claudeCalls[0], /Address them as @Someone/);
        assert.match(h.claudeCalls[0], /Do not invent facts about them/i);
    }
});

// --- the delay ----------------------------------------------------------

test('⛔ the welcome is DELAYED, not immediate — the command answers first', async () => {
    const scheduled = [];
    const h = makeHarness({
        overrides: {
            delaySec: 5,
            setTimeoutFn: (fn, ms) => { scheduled.push(ms); return 1; },
        },
    });
    h.instance.onMessage('#chan', viewer('Hpac13'), '!song');
    assert.deepEqual(scheduled, [5000], 'must schedule at 5s, not fire now');
    assert.equal(h.sayCalls.length, 0, 'nothing said yet');
});

test('the delay is configurable and 0 is honoured', () => {
    const scheduled = [];
    const h = makeHarness({
        overrides: { delaySec: 0, setTimeoutFn: (fn, ms) => { scheduled.push(ms); return 1; } },
    });
    h.instance.onMessage('#chan', viewer('Hpac13'), 'hi');
    assert.deepEqual(scheduled, [0]);
});

test('a nonsense delay falls back to 0 rather than NaN', () => {
    const scheduled = [];
    const h = makeHarness({
        overrides: { delaySec: 'abc', setTimeoutFn: (fn, ms) => { scheduled.push(ms); return 1; } },
    });
    h.instance.onMessage('#chan', viewer('Hpac13'), 'hi');
    assert.deepEqual(scheduled, [0]);
});

// --- robustness ---------------------------------------------------------

test('⛔ it does NOT consume the message — commands must still run', () => {
    // onMessage returns true meaning "scheduled", and index.js deliberately
    // ignores the return so the command path below still sees the message.
    const h = makeHarness();
    const r = h.instance.onMessage('#chan', viewer('Hpac13'), '!kosmische');
    assert.equal(r, true, 'scheduled');
    // The contract is that the CALLER carries on; nothing here blocks it.
});

test('the kill switch silences it and does not mark them seen', async () => {
    const h = makeHarness({ overrides: { isEnabled: () => false } });
    assert.equal(h.instance.onMessage('#chan', viewer('Hpac13'), 'hi'), false);
    assert.equal(h.instance.seenCount, 0, 'must not consume their one welcome while muted');
    await settle();
    assert.equal(h.sayCalls.length, 0);
});

test('a Claude failure is swallowed and logged, not thrown', async () => {
    const h = makeHarness({ claudeThrows: true });
    h.instance.onMessage('#chan', viewer('Hpac13'), 'hi');
    await settle();
    assert.equal(h.sayCalls.length, 0);
    assert.ok(h.logs.some((l) => /chat-welcome error/.test(l)));
});

test('an empty reply says nothing rather than posting blank', async () => {
    const h = makeHarness({ claudeReply: '  ' });
    h.instance.onMessage('#chan', viewer('Hpac13'), 'hi');
    await settle();
    assert.equal(h.sayCalls.length, 0);
});

test('constructor rejects missing required side effects', () => {
    assert.throws(() => createChatWelcome({}), /requires a `say` function/);
    assert.throws(() => createChatWelcome({ say: () => {} }), /requires a `claudeCall` function/);
});

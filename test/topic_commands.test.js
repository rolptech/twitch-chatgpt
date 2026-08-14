// test/topic_commands.test.js
//
// Routing and prompt-shape tests for topic_commands.js. Run with: node --test
//
// The four anchors are Max's StreamElements text verbatim (14 Aug 2026), except
// "Michael Hoenig", corrected from the SE original's "Honig".
//
// ⛔ The scope assertions below are the point of this file. Max rejected both a
// required-core floor and an open seed — "you should be able to provide enough
// context in the prompt for Claude to choose facts that don't go too far
// afield". Scope IS the control, so if a future edit drops inScope/drift from
// the prompt these fail rather than quietly widening what the bot may say.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTopicCommands, matchTopic, TOPICS, _targetChars } from '../topic_commands.js';

function makeHarness(opts = {}) {
    const sayCalls = [];
    const claudeCalls = [];
    const fired = [];
    const logs = [];
    const instance = createTopicCommands({
        say: (channel, message) => sayCalls.push({ channel, message }),
        claudeCall: async (prompt) => {
            claudeCalls.push(prompt);
            if (opts.claudeThrows) throw new Error('claude exploded');
            return opts.claudeReply !== undefined ? opts.claudeReply : 'A fresh answer.';
        },
        markFired: (u) => fired.push(u),
        log: (...a) => logs.push(a.join(' ')),
        ...opts.overrides,
    });
    return { instance, sayCalls, claudeCalls, fired, logs };
}

const USER = { username: 'someviewer' };
const ALL = ['!kosmische', '!berlinschool', '!artists', '!tranceroots'];

// --- matching -----------------------------------------------------------

test('matches all four commands', () => {
    for (const c of ALL) assert.equal(matchTopic(c), c);
});

test('matches case-insensitively and with trailing text', () => {
    assert.equal(matchTopic('!KOSMISCHE'), '!kosmische');
    assert.equal(matchTopic('  !artists who else?  '), '!artists');
});

test('does not match a command as a substring of another word', () => {
    assert.equal(matchTopic('!artistsxyz'), null);
    assert.equal(matchTopic('talk about !kosmische sometime'), null, 'only the FIRST token counts');
});

test('ignores unrelated messages and non-strings', () => {
    for (const m of ['hello', '!song', '', null, undefined, 42]) assert.equal(matchTopic(m), null);
});

// --- scope is present in every prompt ------------------------------------

test('⛔ every prompt carries BOTH its in-scope and its drift boundary', async () => {
    for (const c of ALL) {
        const h = makeHarness();
        await h.instance.onMessage('#chan', USER, c);
        const p = h.claudeCalls[0];
        assert.match(p, /IN SCOPE — choose freely from:/, `${c} lost its in-scope line`);
        assert.match(p, /TOO FAR AFIELD — do not drift into:/, `${c} lost its drift line`);
        assert.ok(p.includes(TOPICS[c].inScope), `${c} in-scope text missing`);
        assert.ok(p.includes(TOPICS[c].drift), `${c} drift text missing`);
    }
});

test('⛔ every prompt forbids invention', async () => {
    for (const c of ALL) {
        const h = makeHarness();
        await h.instance.onMessage('#chan', USER, c);
        assert.match(h.claudeCalls[0], /never invent one/i, `${c} lost the accuracy clause`);
    }
});

test('every prompt asks for varied substance, not just wording', async () => {
    for (const c of ALL) {
        const h = makeHarness();
        await h.instance.onMessage('#chan', USER, c);
        assert.match(h.claudeCalls[0], /vary the SUBSTANCE/i);
        assert.match(h.claudeCalls[0], /Do NOT paraphrase that back/i);
    }
});

test('the commands point at each other rather than overlapping', () => {
    // Each drift line should hand the excluded material to whichever command
    // owns it, so the four stay distinct instead of converging.
    assert.match(TOPICS['!kosmische'].drift, /!tranceroots/);
    assert.match(TOPICS['!berlinschool'].drift, /!artists/);
    assert.match(TOPICS['!artists'].drift, /!tranceroots/);
});

// --- length -------------------------------------------------------------

test('the length target is derived per command, not a shared constant', () => {
    assert.equal(_targetChars('!kosmische'), 530);
    assert.equal(_targetChars('!berlinschool'), 750);
    assert.equal(_targetChars('!artists'), 530);
    assert.equal(_targetChars('!tranceroots'), 740);
    // The two long ones must not collapse to the two short ones.
    assert.notEqual(_targetChars('!berlinschool'), _targetChars('!artists'));
});

test('each target is 1.5x its own anchor', () => {
    for (const c of ALL) {
        const expected = Math.round((TOPICS[c].anchor.length * 1.5) / 10) * 10;
        assert.equal(_targetChars(c), expected);
    }
});

test('the SE misspelling is not seeded into the generator', () => {
    assert.match(TOPICS['!artists'].anchor, /Michael Hoenig/);
    assert.doesNotMatch(TOPICS['!artists'].anchor, /Michael Honig/);
});

// --- behaviour ----------------------------------------------------------

test('answers a matched command', async () => {
    const h = makeHarness({ claudeReply: 'Kosmische, freshly put.' });
    assert.equal(await h.instance.onMessage('#chan', USER, '!kosmische'), true);
    assert.deepEqual(h.sayCalls, [{ channel: '#chan', message: 'Kosmische, freshly put.' }]);
});

test('an unmatched message is not consumed, so other handlers still see it', async () => {
    const h = makeHarness();
    assert.equal(await h.instance.onMessage('#chan', USER, '!song'), false);
    assert.equal(h.claudeCalls.length, 0);
});

test('the kill switch consumes but stays silent', async () => {
    const h = makeHarness({ overrides: { isEnabled: () => false } });
    assert.equal(await h.instance.onMessage('#chan', USER, '!kosmische'), true, 'still consumed');
    assert.equal(h.sayCalls.length, 0);
    assert.equal(h.claudeCalls.length, 0);
});

test('⚠ cooldown suppresses silently and does NOT mark a fire', async () => {
    const h = makeHarness({ overrides: { cooldownActive: () => true } });
    assert.equal(await h.instance.onMessage('#chan', USER, '!kosmische'), true);
    assert.equal(h.claudeCalls.length, 0);
    assert.deepEqual(h.fired, [], 'a suppressed call must not extend the cooldown');
});

test('a permitted call marks the fire so the cooldown starts', async () => {
    const h = makeHarness();
    await h.instance.onMessage('#chan', USER, '!kosmische');
    assert.deepEqual(h.fired, ['someviewer']);
});

test('a Claude failure is swallowed and logged, not thrown', async () => {
    const h = makeHarness({ claudeThrows: true });
    assert.equal(await h.instance.onMessage('#chan', USER, '!artists'), true);
    assert.equal(h.sayCalls.length, 0);
    assert.ok(h.logs.some((l) => /topic-command error/.test(l)));
});

test('an over-long reply is chunked', async () => {
    const h = makeHarness({ claudeReply: 'x'.repeat(750), overrides: { maxLength: 399 } });
    await h.instance.onMessage('#chan', USER, '!berlinschool');
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(h.sayCalls.length, 2, '750 chars at the 1.5x target lands as two messages');
});

test('constructor rejects missing required side effects', () => {
    assert.throws(() => createTopicCommands({}), /requires a `say` function/);
    assert.throws(() => createTopicCommands({ say: () => {} }), /requires a `claudeCall` function/);
});

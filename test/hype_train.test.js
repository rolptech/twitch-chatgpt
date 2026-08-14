// test/hype_train.test.js
//
// Run with: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHypeTrain, describeTrain } from '../hype_train.js';
import { sayChunked } from '../chunk_text.js';

function makeHarness(opts = {}) {
    const sayCalls = [];
    const claudeCalls = [];
    const logs = [];
    const instance = createHypeTrain({
        say: (channel, message) => sayCalls.push({ channel, message }),
        channel: '#mind_prime',
        claudeCall: async (prompt) => {
            claudeCalls.push(prompt);
            if (opts.claudeThrows) throw new Error('claude exploded');
            return opts.claudeReply !== undefined ? opts.claudeReply : 'ALL ABOARD!';
        },
        sayChunkedFn: sayChunked,
        log: (...a) => logs.push(a.join(' ')),
        ...opts.overrides,
    });
    return { instance, sayCalls, claudeCalls, logs };
}

const EVENT = {
    id: 'train_1',
    level: 2,
    total: 1500,
    progress: 300,
    goal: 2000,
    top_contributions: [{ user_name: 'social_ali3n' }, { user_name: 'UweGLE' }],
};

// --- describeTrain ------------------------------------------------------

test('reads the fields that are present', () => {
    const d = describeTrain(EVENT);
    assert.equal(d.level, 2);
    assert.ok(d.facts.some((f) => /level 2/.test(f)));
    assert.ok(d.facts.some((f) => /1500 points/.test(f)));
    assert.ok(d.facts.some((f) => /300 of 2000/.test(f)));
    assert.deepEqual(d.contributors, ['social_ali3n', 'UweGLE']);
});

test('⛔ every field is optional — an unexpected payload degrades, never throws', () => {
    // The v2 field list could not be retrieved in full from Twitch's docs (the
    // reference page truncates before the hype train payload), so the shape is
    // treated as untrusted.
    for (const e of [{}, null, undefined, { id: 'x' }, { level: 'nonsense', total: null }]) {
        assert.doesNotThrow(() => describeTrain(e));
        const d = describeTrain(e);
        assert.ok(Array.isArray(d.facts));
        assert.ok(Array.isArray(d.contributors));
    }
});

test('zero and negative values are not reported as facts', () => {
    const d = describeTrain({ level: 0, total: 0, goal: 0 });
    assert.deepEqual(d.facts, []);
});

test('a contributor with no usable name is dropped, not rendered undefined', () => {
    const d = describeTrain({ top_contributions: [{ user_name: 'a' }, {}, { user_login: 'b' }] });
    assert.deepEqual(d.contributors, ['a', 'b']);
});

// --- behaviour ----------------------------------------------------------

test('announces a hype train', async () => {
    const h = makeHarness({ claudeReply: 'The train is rolling!' });
    assert.equal(await h.instance.onNotification('channel.hype_train.begin', EVENT), true);
    assert.deepEqual(h.sayCalls, [{ channel: '#mind_prime', message: 'The train is rolling!' }]);
});

test('the prompt carries the numbers and bans inventing more', async () => {
    const h = makeHarness();
    await h.instance.onNotification('channel.hype_train.begin', EVENT);
    const p = h.claudeCalls[0];
    assert.match(p, /\[HYPE TRAIN\]/);
    assert.match(p, /level 2/);
    assert.match(p, /social_ali3n/);
    assert.match(p, /TWO OR THREE SENTENCES/);
    assert.match(p, /Do not invent numbers, names/i);
});

test('⛔ a redelivered notification is announced ONCE', async () => {
    // EventSub is at-least-once, not exactly-once — a reconnect can redeliver.
    const h = makeHarness();
    await h.instance.onNotification('channel.hype_train.begin', EVENT);
    await h.instance.onNotification('channel.hype_train.begin', EVENT);
    await h.instance.onNotification('channel.hype_train.begin', EVENT);
    assert.equal(h.sayCalls.length, 1, 'one train, one message');
    assert.ok(h.logs.some((l) => /already announced/.test(l)));
});

test('a DIFFERENT train later is still announced', async () => {
    const h = makeHarness();
    await h.instance.onNotification('channel.hype_train.begin', EVENT);
    await h.instance.onNotification('channel.hype_train.begin', { ...EVENT, id: 'train_2' });
    assert.equal(h.sayCalls.length, 2);
});

test('an event with no id is let through rather than silently dropped', async () => {
    const h = makeHarness();
    await h.instance.onNotification('channel.hype_train.begin', { level: 1 });
    assert.equal(h.sayCalls.length, 1);
});

test('other EventSub types are ignored', async () => {
    const h = makeHarness();
    assert.equal(await h.instance.onNotification('channel.follow', { id: 'x' }), false);
    assert.equal(h.claudeCalls.length, 0);
});

test('the kill switch silences it', async () => {
    const h = makeHarness({ overrides: { isEnabled: () => false } });
    assert.equal(await h.instance.onNotification('channel.hype_train.begin', EVENT), false);
    assert.equal(h.claudeCalls.length, 0);
    assert.equal(h.sayCalls.length, 0);
});

test('a Claude failure is swallowed and logged, not thrown', async () => {
    const h = makeHarness({ claudeThrows: true });
    assert.equal(await h.instance.onNotification('channel.hype_train.begin', EVENT), true);
    assert.equal(h.sayCalls.length, 0);
    assert.ok(h.logs.some((l) => /hype-train error/.test(l)));
});

test('⛔ there is NO batching or delay on this path', async () => {
    // Max: "2-3 sentences right away, in time before the gift subs thank you".
    // sub_thanks flushes on a 15s window; this must post immediately or the
    // ordering he asked for is lost.
    const h = makeHarness();
    const before = Date.now();
    await h.instance.onNotification('channel.hype_train.begin', EVENT);
    assert.equal(h.sayCalls.length, 1, 'must have said it already, not queued it');
    assert.ok(Date.now() - before < 200, 'no delay on this path');
});

test('constructor requires a channel — EventSub notifications carry none', () => {
    assert.throws(
        () => createHypeTrain({ say: () => {}, claudeCall: async () => '' }),
        /requires a `channel`/,
    );
});

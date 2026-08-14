// test/follow_thanks.test.js
//
// Routing tests for follow_thanks.js. Run with: node --test
//
// The trigger string is not invented — it is the real StreamElements line
// captured from Max's chat on 14 Aug 2026 at 06:44 PT:
//
//     Thank you for following VladdyPoe AstroRowboat
//
// `say` and `claudeCall` are injected fakes, so no network, no credentials.
//
// ⛔ The announcer-spoofing cases below are the point of this file, not
// padding. The trigger is a plain chat string; without the sender check any
// viewer could make the bot welcome an arbitrary name and burn a Claude call
// on demand. Those tests fail loudly if that check is ever loosened.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFollowThanks, extractFollower } from '../follow_thanks.js';

const REAL_LINE = 'Thank you for following VladdyPoe AstroRowboat';

function makeHarness(opts = {}) {
    const sayCalls = [];
    const claudeCalls = [];
    const logs = [];
    const instance = createFollowThanks({
        say: (channel, message) => sayCalls.push({ channel, message }),
        claudeCall: async (prompt) => {
            claudeCalls.push(prompt);
            if (opts.claudeThrows) throw new Error('claude exploded');
            return opts.claudeReply !== undefined ? opts.claudeReply : 'Welcome in!';
        },
        log: (...args) => logs.push(args.join(' ')),
        ...opts.overrides,
    });
    return { instance, sayCalls, claudeCalls, logs };
}

const SE = { username: 'streamelements', 'display-name': 'StreamElements' };

// --- extractFollower ----------------------------------------------------

test('extracts the follower from the real captured StreamElements line', () => {
    assert.equal(extractFollower(REAL_LINE), 'VladdyPoe');
});

test('the trailing emote is not mistaken for the name', () => {
    assert.notEqual(extractFollower(REAL_LINE), 'AstroRowboat');
});

test('tolerates a leading @ on the name', () => {
    assert.equal(extractFollower('Thank you for following @someuser'), 'someuser');
});

test('is case-insensitive on the template text', () => {
    assert.equal(extractFollower('THANK YOU FOR FOLLOWING SomeUser'), 'SomeUser');
});

test('ignores unrelated messages', () => {
    for (const m of ['hello chat', '!song', 'thanks for following me on twitter', '']) {
        assert.equal(extractFollower(m), null, `should not match: ${m}`);
    }
});

test('returns null on non-string input rather than throwing', () => {
    for (const v of [null, undefined, 42, {}]) assert.equal(extractFollower(v), null);
});

// --- the announcer boundary --------------------------------------------

test('⛔ a viewer typing the exact phrase is IGNORED', async () => {
    const h = makeHarness();
    const acted = await h.instance.onMessage('#chan', { username: 'randomviewer' }, REAL_LINE);
    assert.equal(acted, false);
    assert.equal(h.claudeCalls.length, 0, 'must not burn a Claude call');
    assert.equal(h.sayCalls.length, 0, 'must not speak');
});

test('⛔ a near-miss announcer name is IGNORED', async () => {
    const h = makeHarness();
    for (const name of ['streamelement', 'streamelements2', 'stream_elements', 'nightbot']) {
        const acted = await h.instance.onMessage('#chan', { username: name }, REAL_LINE);
        assert.equal(acted, false, `${name} must not be trusted`);
    }
    assert.equal(h.claudeCalls.length, 0);
});

test('the announcer name matches case-insensitively', async () => {
    const h = makeHarness();
    const acted = await h.instance.onMessage('#chan', { username: 'StreamElements' }, REAL_LINE);
    assert.equal(acted, true);
    assert.equal(h.sayCalls.length, 1);
});

test('a custom announcer can be configured, and displaces the default', async () => {
    const h = makeHarness({ overrides: { announcer: 'mind_bot2' } });
    assert.equal(await h.instance.onMessage('#chan', { username: 'mind_bot2' }, REAL_LINE), true);
    assert.equal(await h.instance.onMessage('#chan', SE, REAL_LINE), false,
        'the default must not remain trusted once overridden');
});

// --- behaviour ----------------------------------------------------------

test('welcomes on the announcer\'s follow line', async () => {
    const h = makeHarness({ claudeReply: 'Good to see you, VladdyPoe!' });
    const acted = await h.instance.onMessage('#chan', SE, REAL_LINE);
    assert.equal(acted, true);
    assert.equal(h.sayCalls.length, 1);
    assert.equal(h.sayCalls[0].channel, '#chan');
    assert.equal(h.sayCalls[0].message, 'Good to see you, VladdyPoe!');
});

test('the prompt carries the follower and forbids re-announcing', async () => {
    const h = makeHarness();
    await h.instance.onMessage('#chan', SE, REAL_LINE);
    const p = h.claudeCalls[0];
    assert.match(p, /VladdyPoe/);
    assert.match(p, /do not restate as news/i);
    assert.match(p, /FRESH wording/i);
    assert.match(p, /ONE SHORT LINE/i);
});

test('the announcer\'s OTHER messages are left alone', async () => {
    const h = makeHarness();
    // The real BopBop timer line from the same chat.
    const acted = await h.instance.onMessage('#chan', SE, 'BopBop mindpr1BopBopLasers BopBop');
    assert.equal(acted, false);
    assert.equal(h.claudeCalls.length, 0);
});

test('the kill switch silences it', async () => {
    const h = makeHarness({ overrides: { isEnabled: () => false } });
    const acted = await h.instance.onMessage('#chan', SE, REAL_LINE);
    assert.equal(acted, false);
    assert.equal(h.claudeCalls.length, 0);
    assert.equal(h.sayCalls.length, 0);
});

test('no cooldown — consecutive follows each get a reply', async () => {
    const h = makeHarness();
    await h.instance.onMessage('#chan', SE, 'Thank you for following alpha');
    await h.instance.onMessage('#chan', SE, 'Thank you for following bravo');
    await h.instance.onMessage('#chan', SE, 'Thank you for following charlie');
    assert.equal(h.sayCalls.length, 3, 'Max, 14 Aug 2026: no rate limiting, no cooldown');
});

test('a Claude failure is swallowed and logged, not thrown', async () => {
    const h = makeHarness({ claudeThrows: true });
    const acted = await h.instance.onMessage('#chan', SE, REAL_LINE);
    assert.equal(acted, true, 'still consumed the message');
    assert.equal(h.sayCalls.length, 0);
    assert.ok(h.logs.some((l) => /follow-thanks error/.test(l)), 'should log the failure');
});

test('an empty Claude reply says nothing rather than posting blank', async () => {
    const h = makeHarness({ claudeReply: '   ' });
    await h.instance.onMessage('#chan', SE, REAL_LINE);
    assert.equal(h.sayCalls.length, 0);
});

test('an over-long reply is chunked like every other Claude path', async () => {
    const h = makeHarness({ claudeReply: 'x'.repeat(900), overrides: { maxLength: 399 } });
    await h.instance.onMessage('#chan', SE, REAL_LINE);
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal(h.sayCalls.length, 3);
    assert.ok(h.sayCalls.every((c) => c.message.length <= 399));
});

test('constructor rejects missing required side effects', () => {
    assert.throws(() => createFollowThanks({}), /requires a `say` function/);
    assert.throws(() => createFollowThanks({ say: () => {} }), /requires a `claudeCall` function/);
});

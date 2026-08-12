// test/sub_thanks.test.js
//
// Synthetic-event routing tests for sub_thanks.js (WO §8 — "You cannot make
// a real sub happen ... unit-test the routing with synthetic events").
//
// Run with: node --test
//
// Every event is constructed with the exact argument shape verified against
// tmi.js@1.8.5 source (lib/client.js), not docs — see sub_thanks.js header.
// `say` and `claudeCall` are injected fakes so no network call, no live
// credentials, and no real 15s wait ever happens. Timing-dependent cases use
// small REAL intervalMs/bulkWindowMs (tens-hundreds of ms) so the suite runs
// in well under a second while still exercising real setTimeout scheduling
// rather than a synchronous fast-path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSubThanks } from '../sub_thanks.js';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeHarness(opts = {}) {
    const sayCalls = [];
    const claudeCalls = [];
    const instance = createSubThanks({
        say: (channel, message) => sayCalls.push({ channel, message }),
        claudeCall: async (prompt) => {
            claudeCalls.push(prompt);
            return `THANKS(${claudeCalls.length})`;
        },
        isEnabled: opts.isEnabled ?? (() => true),
        intervalMs: opts.intervalMs ?? 150,
        bulkWindowMs: opts.bulkWindowMs ?? 100,
        log: () => {}, // silence the tag-presence log during tests; asserted separately below
        ...opts.extra,
    });
    return { instance, sayCalls, claudeCalls };
}

// ---------------------------------------------------------------------------
// WO §8, case 1: one submysterygift + 5 subgift WITH the community-gift-id
// tag => EXACTLY ONE message, naming the gifter and the count.
// ---------------------------------------------------------------------------
test('submysterygift + 5 tagged subgift => exactly one message, naming gifter + count', async () => {
    const { instance, sayCalls, claudeCalls } = makeHarness({ intervalMs: 120, bulkWindowMs: 80 });

    instance.onSubmysterygift('#maxchan', 'BigGifter', 5, { prime: false, plan: '1000' }, {});
    for (let i = 0; i < 5; i++) {
        instance.onSubgift('#maxchan', 'BigGifter', 0, `recipient${i}`, { prime: false, plan: '1000' }, {
            'msg-param-community-gift-id': '123456789',
        });
    }

    await sleep(200); // let the throttle interval elapse and the flush fire

    assert.equal(sayCalls.length, 1, 'expected exactly one chat message');
    assert.equal(claudeCalls.length, 1, 'expected exactly one Claude call');
    assert.match(claudeCalls[0], /BigGifter/, 'prompt must name the gifter');
    assert.match(claudeCalls[0], /5 subs/, 'prompt must mention the count');
    assert.match(claudeCalls[0], /not a shoutout/i, 'prompt must state the short/no-shoutout rule');
    assert.match(claudeCalls[0], /do not restate as news/i, 'prompt must tell Claude the announcement already happened');
    assert.match(claudeCalls[0], /SUPPORTING THE CHANNEL/, 'prompt must use the "supporting the channel" framing');
    assert.match(claudeCalls[0], /FRESH wording/i, 'prompt must explicitly ask for varied wording');
});

// ---------------------------------------------------------------------------
// WO §8, case 2: the same WITHOUT the tag => still exactly one message (the
// timing guard catches it).
// ---------------------------------------------------------------------------
test('submysterygift + 5 UNTAGGED subgift within the timing window => still exactly one message', async () => {
    const { instance, sayCalls, claudeCalls } = makeHarness({ intervalMs: 120, bulkWindowMs: 80 });

    instance.onSubmysterygift('#maxchan', 'BigGifter', 5, { prime: false, plan: '1000' }, {});
    for (let i = 0; i < 5; i++) {
        // No community-gift-id tag at all — this is the "Twitch didn't populate
        // it" case the timing guard exists for.
        instance.onSubgift('#maxchan', 'BigGifter', 0, `recipient${i}`, { prime: false, plan: '1000' }, {});
    }

    await sleep(200);

    assert.equal(sayCalls.length, 1, 'expected exactly one chat message (timing guard suppressed the fan-out)');
    assert.equal(claudeCalls.length, 1);
    assert.match(claudeCalls[0], /BigGifter/);
    assert.match(claudeCalls[0], /5 subs/);
});

// ---------------------------------------------------------------------------
// WO §8, case 3: a lone subgift with no preceding submysterygift => one
// message thanking that gifter.
// ---------------------------------------------------------------------------
test('lone subgift with no preceding submysterygift => one message thanking the gifter', async () => {
    const { instance, sayCalls, claudeCalls } = makeHarness({ intervalMs: 120, bulkWindowMs: 80 });

    instance.onSubgift('#maxchan', 'SoloGifter', 0, 'someRecipient', { prime: false, plan: '1000' }, {});

    await sleep(200);

    assert.equal(sayCalls.length, 1, 'expected exactly one chat message');
    assert.equal(claudeCalls.length, 1);
    assert.match(claudeCalls[0], /SoloGifter/, 'prompt must name the gifter');
    assert.match(claudeCalls[0], /gifted a sub to someRecipient/);
});

// ---------------------------------------------------------------------------
// WO §8, case 4: subscription => one message thanking the subscriber.
// ---------------------------------------------------------------------------
test('subscription => one message thanking the subscriber', async () => {
    const { instance, sayCalls, claudeCalls } = makeHarness({ intervalMs: 120 });

    instance.onSubscription('#maxchan', 'NewSubscriber', { prime: false, plan: '1000' }, 'hype!', {});

    await sleep(200);

    assert.equal(sayCalls.length, 1);
    assert.equal(claudeCalls.length, 1);
    assert.match(claudeCalls[0], /NewSubscriber just subscribed/, 'context must still name the subscriber for Claude');
    assert.match(claudeCalls[0], /do not restate as news/i, 'must tell Claude not to re-announce (a separate announcer already did)');
    assert.match(claudeCalls[0], /SUPPORTING THE CHANNEL/, 'must use "supporting the channel" framing, not just "for the sub"');
    assert.match(claudeCalls[0], /FRESH wording/i, 'must explicitly ask for varied wording');
    assert.match(claudeCalls[0], /ONE OR TWO LINES/);
});

// ---------------------------------------------------------------------------
// WO §8, case 5: 20 subscriptions in ~5s (compressed here to well under the
// throttle interval) => batched, never 20 messages.
// ---------------------------------------------------------------------------
test('20 subscriptions arriving faster than the interval => batched, never 20 messages', async () => {
    const { instance, sayCalls, claudeCalls } = makeHarness({ intervalMs: 250 });

    // Space events a few ms apart (not all in one synchronous tick) to
    // exercise real setTimeout scheduling rather than a same-tick fast path.
    for (let i = 0; i < 20; i++) {
        instance.onSubscription('#maxchan', `Subscriber${i}`, { prime: false, plan: '1000' }, '', {});
        await sleep(5); // ~100ms total spread, well under the 250ms interval
    }

    await sleep(400); // let any scheduled flush(es) fire

    assert.ok(sayCalls.length < 20, `expected far fewer than 20 messages, got ${sayCalls.length}`);
    assert.ok(sayCalls.length <= 3, `expected batching to keep this small, got ${sayCalls.length}`);
    // every Subscriber name should appear across the (few) prompts sent, i.e.
    // nobody was silently dropped — batching, not discarding.
    const allPrompts = claudeCalls.join('\n');
    for (let i = 0; i < 20; i++) {
        assert.match(allPrompts, new RegExp(`Subscriber${i}\\b`), `Subscriber${i} missing from any prompt — dropped, not batched`);
    }
    // the batched (>1 fact) prompt still carries the no-restate + variation +
    // "supporting the channel" instructions, not just the single-fact path.
    const batchedPrompt = claudeCalls.find((p) => /Subscriber1\b.*Subscriber2\b/s.test(p));
    assert.ok(batchedPrompt, 'expected a batched prompt containing more than one subscriber');
    assert.match(batchedPrompt, /do not restate as news/i);
    assert.match(batchedPrompt, /SUPPORTING THE CHANNEL/);
    assert.match(batchedPrompt, /FRESH wording/i);
});

// ---------------------------------------------------------------------------
// Bonus coverage (beyond the WO §8 minimum) — exercised because the module
// implements them, not because §8 required them.
// ---------------------------------------------------------------------------

test('[bonus] resub thank-you includes the streak length', async () => {
    const { instance, sayCalls, claudeCalls } = makeHarness({ intervalMs: 120 });
    instance.onResub('#maxchan', 'LoyalViewer', 7, 'still here', {}, { prime: false, plan: '1000' });
    await sleep(200);
    assert.equal(sayCalls.length, 1);
    assert.match(claudeCalls[0], /LoyalViewer just resubscribed for 7 months in a row/);
});

test('[bonus] anonymous mystery gift + tagged anonsubgift fan-out => suppressed (symmetric protection)', async () => {
    const { instance, sayCalls, claudeCalls } = makeHarness({ intervalMs: 120, bulkWindowMs: 80 });
    instance.onAnonSubmysterygift('#maxchan', 4, { prime: false, plan: '1000' }, {});
    for (let i = 0; i < 4; i++) {
        instance.onAnonSubgift('#maxchan', 0, `recipient${i}`, { prime: false, plan: '1000' }, {
            'msg-param-community-gift-id': 'abc',
        });
    }
    await sleep(200);
    assert.equal(sayCalls.length, 1, 'anon fan-out must be suppressed the same way the named one is');
    assert.match(claudeCalls[0], /anonymous gifter/i);
    assert.match(claudeCalls[0], /4 subs/);
});

test('[bonus] lone anonsubgift with no preceding anon mystery gift => thanks "an anonymous gifter"', async () => {
    const { instance, sayCalls, claudeCalls } = makeHarness({ intervalMs: 120 });
    instance.onAnonSubgift('#maxchan', 0, 'someRecipient', { prime: false, plan: '1000' }, {});
    await sleep(200);
    assert.equal(sayCalls.length, 1);
    assert.match(claudeCalls[0], /an anonymous gifter just gifted a sub/i);
});

test('[bonus] kill switch (isEnabled=false) suppresses every sub-thanks path, including bulk-gift bookkeeping', async () => {
    const { instance, sayCalls, claudeCalls } = makeHarness({ intervalMs: 60, bulkWindowMs: 60, isEnabled: () => false });
    instance.onSubscription('#maxchan', 'X', {}, '', {});
    instance.onSubmysterygift('#maxchan', 'Y', 3, {}, {});
    instance.onSubgift('#maxchan', 'Y', 0, 'Z', {}, {});
    instance.onResub('#maxchan', 'W', 2, '', {}, {});
    instance.onAnonSubmysterygift('#maxchan', 2, {}, {});
    instance.onAnonSubgift('#maxchan', 0, 'V', {}, {});
    await sleep(150);
    assert.equal(sayCalls.length, 0);
    assert.equal(claudeCalls.length, 0);
});

test('[bonus] tag-presence is logged exactly once per bulk gift, not once per fan-out event', async () => {
    const logLines = [];
    const instance = createSubThanks({
        say: () => {},
        claudeCall: async () => 'x',
        intervalMs: 120,
        bulkWindowMs: 80,
        log: (...args) => logLines.push(args.join(' ')),
    });
    instance.onSubmysterygift('#maxchan', 'BigGifter', 5, {}, {});
    for (let i = 0; i < 5; i++) {
        instance.onSubgift('#maxchan', 'BigGifter', 0, `r${i}`, {}, { 'msg-param-community-gift-id': 'x' });
    }
    await sleep(200);
    const tagLogLines = logLines.filter((l) => l.includes('community-gift-id tag'));
    assert.equal(tagLogLines.length, 1, `expected exactly one tag-presence log line, got ${tagLogLines.length}`);
    assert.match(tagLogLines[0], /present/);
});

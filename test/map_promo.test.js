// test/map_promo.test.js
//
// Run with: node --test
//
// map_promo posts one fact about The Twitch DJ Network Map roughly every 15 minutes
// (Max, 4 Sep 2026: "for now I want it actively promoting the map in that fashion").
//
// ⛔ The tests that matter here are the ones about when it STAYS SILENT. A promo that
//   fires is obvious the first time you watch chat; a promo that talks to an empty room
//   at 4am, or ignores !mbstop, or lands on the back of a shoutout, is the kind of fault
//   that only shows up once it has annoyed somebody.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMapPromo } from '../map_promo.js';

const INTERVAL = 900;

function makeHarness(opts = {}) {
    const sayCalls = [];
    const logs = [];
    let clock = 1_000_000;
    let live = opts.live ?? true;
    let enabledSwitch = opts.botEnabled ?? true;
    let lastSpoke = opts.lastSpoke ?? 0;

    const instance = createMapPromo({
        say: (channel, message) => sayCalls.push({ channel, message }),
        claudeCall: async (text) => opts.claudeReply ?? `robot voice: ${text}`,
        isEnabled: () => enabledSwitch,
        isLive: () => live,
        maxLength: 400,
        lastSpokeAt: () => lastSpoke,
        log: (m) => logs.push(m),
        now: () => clock,
        random: opts.random ?? (() => 0.5),   // 0.5 ⇒ no jitter
        enabled: opts.enabled ?? true,
        intervalSec: INTERVAL,
    });

    return {
        instance, sayCalls, logs,
        advance: (sec) => { clock += sec * 1000; },
        setLive: (v) => { live = v; },
        setBotEnabled: (v) => { enabledSwitch = v; },
        setLastSpoke: () => { lastSpoke = clock; },
        now: () => clock,
    };
}

test('posts a map fact once the interval has passed', async () => {
    const h = makeHarness();
    h.instance.start('#mind_prime');
    h.advance(INTERVAL + 1);
    await h.instance._tick();
    assert.equal(h.sayCalls.length, 1);
    assert.match(h.sayCalls[0].message, /djnetworkmap\.com/);
});

test('says nothing before the interval has passed', async () => {
    const h = makeHarness();
    h.instance.start('#mind_prime');
    h.advance(60);
    await h.instance._tick();
    assert.equal(h.sayCalls.length, 0);
});

test('does not fire twice in a row — the clock is reset when it speaks', async () => {
    const h = makeHarness();
    h.instance.start('#mind_prime');
    h.advance(INTERVAL + 1);
    await h.instance._tick();
    h.advance(60);
    await h.instance._tick();
    assert.equal(h.sayCalls.length, 1);
});

// ⛔ The channel is dark for most of the day. Without this it posts into an empty room
//   every 15 minutes, forever.
test('stays silent while the stream is offline', async () => {
    const h = makeHarness({ live: false });
    h.instance.start('#mind_prime');
    h.advance(INTERVAL + 1);
    await h.instance._tick();
    assert.equal(h.sayCalls.length, 0);
});

test('resumes once the stream goes live', async () => {
    const h = makeHarness({ live: false });
    h.instance.start('#mind_prime');
    h.advance(INTERVAL + 1);
    await h.instance._tick();
    h.setLive(true);
    await h.instance._tick();
    assert.equal(h.sayCalls.length, 1);
});

// ⛔ A kill switch honoured by some paths and not others is not a kill switch.
test('respects !mbstop', async () => {
    const h = makeHarness();
    h.instance.start('#mind_prime');
    h.setBotEnabled(false);
    h.advance(INTERVAL + 1);
    await h.instance._tick();
    assert.equal(h.sayCalls.length, 0);
});

// ⇒ Skip the turn, do not queue it. Otherwise a promo lands immediately after a
//   shoutout and reads as the bot talking over itself.
test('skips its turn if the bot has just spoken', async () => {
    const h = makeHarness();
    h.instance.start('#mind_prime');
    h.advance(INTERVAL + 1);
    h.setLastSpoke();
    await h.instance._tick();
    assert.equal(h.sayCalls.length, 0);
});

test('MAP_PROMO_ENABLED=false silences it entirely', async () => {
    const h = makeHarness({ enabled: false });
    h.instance.start('#mind_prime');
    h.advance(INTERVAL * 10);
    await h.instance._tick();
    assert.equal(h.sayCalls.length, 0);
});

// ⛔ The address is the entire point of the message. If the model drops it the post is
//   a fact about a website nobody can find.
test('appends the address when the model leaves it out', async () => {
    const h = makeHarness({ claudeReply: 'a fact with no address in it' });
    h.instance.start('#mind_prime');
    h.advance(INTERVAL + 1);
    await h.instance._tick();
    assert.match(h.sayCalls[0].message, /djnetworkmap\.com$/);
});

test('does not duplicate the address when the model already included it', async () => {
    const h = makeHarness({ claudeReply: 'come and see djnetworkmap.com right now' });
    h.instance.start('#mind_prime');
    h.advance(INTERVAL + 1);
    await h.instance._tick();
    const hits = h.sayCalls[0].message.match(/djnetworkmap\.com/g) || [];
    assert.equal(hits.length, 1);
});

test('a Claude failure is swallowed, not thrown', async () => {
    const h = makeHarness();
    const broken = createMapPromo({
        say: () => {}, claudeCall: async () => { throw new Error('boom'); },
        isEnabled: () => true, isLive: () => true, lastSpokeAt: () => 0,
        log: () => {}, now: () => 2_000_000, random: () => 0.5, intervalSec: 1,
    });
    broken.start('#mind_prime');
    await assert.doesNotReject(() => broken._tick());
});

// ⇒ The same viewers sit in chat all night. A random pick repeats within a few draws
//   and they notice; this plays the whole pack before any repeat.
test('every fact is used before any repeats', () => {
    const h = makeHarness({ random: Math.random });
    const seen = new Set();
    for (let i = 0; i < h.instance.FACTS.length; i++) seen.add(h.instance._nextFact());
    assert.equal(seen.size, h.instance.FACTS.length);
});

// ⛔ Counts change with every build of the map. A fact quoting one is wrong by the
//   next morning and the bot would keep saying it.
test('no fact quotes a figure that changes between builds', () => {
    const h = makeHarness();
    const offenders = h.instance.FACTS.filter((f) => /\d{3,}|\b\d+,\d+/.test(f));
    assert.deepEqual(offenders, []);
});

// ⛔ Wire 36 — Max has asked repeatedly for this construction to be gone from anything
//   visitor-facing, and chat is visitor-facing.
test('no fact uses the banned by-hand construction', () => {
    const h = makeHarness();
    const banned = /by hand|by-hand|hand-placed|hand placed|hand-chosen|hand chosen|hand-positioned|by a human|by a person|manually placed|placed manually/i;
    const offenders = h.instance.FACTS.filter((f) => banned.test(f));
    assert.deepEqual(offenders, []);
});

test('every fact fits in a chat line', () => {
    const h = makeHarness();
    const tooLong = h.instance.FACTS.filter((f) => f.length > 200);
    assert.deepEqual(tooLong, []);
});

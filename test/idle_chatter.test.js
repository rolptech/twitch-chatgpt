// test/idle_chatter.test.js
//
// Run with: node --test
//
// Quiet is "fewer than 4 HUMAN messages in 2 minutes" (Max, 21 Aug 2026). The
// humans-only part is load-bearing rather than tidy: StreamElements and Sery_Bot
// post into this channel on their own, so counting them lets an empty room read as
// busy and suppresses the whole feature.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdleChatter } from '../idle_chatter.js';

function makeHarness(opts = {}) {
    const sayCalls = [];
    const claudeCalls = [];
    const logs = [];
    let clock = 1_000_000;

    const instance = createIdleChatter({
        say: (channel, message) => sayCalls.push({ channel, message }),
        claudeCall: async (text) => { claudeCalls.push(text); return opts.claudeReply ?? "ok"; },
        log: (m) => logs.push(m),
        now: () => clock,
        random: opts.random ?? (() => 0.0),
        setIntervalFn: () => ({ unref() {} }),
        clearIntervalFn: () => {},
        ...opts,
    });

    return {
        instance, sayCalls, claudeCalls, logs,
        advance(sec) { clock += sec * 1000; },
        get clock() { return clock; },
    };
}

test('quiet: fewer than 4 human messages in the window', () => {
    const h = makeHarness();
    assert.equal(h.instance.isQuiet(), true);
    for (let i = 0; i < 3; i++) h.instance.noteMessage({ username: `u${i}` });
    assert.equal(h.instance.isQuiet(), true, '3 messages is still quiet');
    h.instance.noteMessage({ username: 'u4' });
    assert.equal(h.instance.isQuiet(), false, '4 messages is not quiet');
});

test('bots do not count toward activity', () => {
    const h = makeHarness();
    for (const b of ['StreamElements', 'Sery_Bot', 'Nightbot', 'mind_b0t']) {
        h.instance.noteMessage({ username: b });
    }
    assert.equal(h.instance.messageCount, 0);
    assert.equal(h.instance.isQuiet(), true, 'a room of only bots is quiet');
});

test('the window expires — old messages stop counting', () => {
    const h = makeHarness({ quietWindowSec: 120 });
    for (let i = 0; i < 5; i++) h.instance.noteMessage({ username: `u${i}` });
    assert.equal(h.instance.isQuiet(), false);
    h.advance(121);
    assert.equal(h.instance.isQuiet(), true, 'past the window it is quiet again');
});

test('cooldown is 2 min live and 1 hour offline', () => {
    let live = true;
    const h = makeHarness({ isLive: () => live });
    h.instance.markSpoke();
    assert.equal(h.instance.cooldownActive(), true);
    h.advance(121);
    assert.equal(h.instance.cooldownActive(), false, 'live cooldown clears after 2 min');

    live = false;
    h.instance.markSpoke();
    h.advance(121);
    assert.equal(h.instance.cooldownActive(), true, 'offline still gated after 2 min');
    h.advance(3600);
    assert.equal(h.instance.cooldownActive(), false, 'offline clears after an hour');
});

test('ANY mind_b0t message restarts the cooldown', async () => {
    const h = makeHarness({ isLive: () => true });
    h.advance(9999);
    assert.equal(h.instance.cooldownActive(), false);
    // e.g. a shoutout or !song answer, produced by a different module entirely
    h.instance.markSpoke();
    assert.equal(h.instance.cooldownActive(), true, 'a reply resets the self-initiated clock');
});

test('live: an unprompted comment waits for the cooldown', async () => {
    const h = makeHarness({ isLive: () => true });
    h.instance.markSpoke();
    assert.equal(await h.instance._tick('#c'), false, 'gated inside the cooldown');
    h.advance(121);
    assert.equal(await h.instance._tick('#c'), true, 'fires once it clears');
    assert.equal(h.sayCalls.length, 1);
});

test('busy chat suppresses the unprompted comment', async () => {
    const h = makeHarness({ isLive: () => true });
    h.advance(9999);
    for (let i = 0; i < 4; i++) h.instance.noteMessage({ username: `u${i}` });
    assert.equal(await h.instance._tick('#c'), false);
});

test('!mbstop silences self-initiated comments too', async () => {
    let enabled = false;
    const h = makeHarness({ isLive: () => true, isEnabled: () => enabled });
    h.advance(9999);
    assert.equal(await h.instance._tick('#c'), false, 'disabled: silent');
    assert.equal(await h.instance.maybeReplyTo('#c', { username: 'a' }, 'hi'), false);
    enabled = true;
    assert.equal(await h.instance._tick('#c'), true);
});

test('offline replies are ungated; live replies are not', async () => {
    let live = true;
    const h = makeHarness({ isLive: () => live });
    h.instance.markSpoke();

    assert.equal(await h.instance.maybeReplyTo('#c', { username: 'a' }, 'hey'), false,
        'live: inside cooldown, no reply');

    live = false;
    h.instance.markSpoke();
    assert.equal(await h.instance.maybeReplyTo('#c', { username: 'a' }, 'no stream today?'), true,
        'offline: replies immediately regardless of cooldown');
});

test('a reply is about what they said, and carries the track when there is one', async () => {
    const h = makeHarness({ isLive: () => false, nowPlaying: () => 'Artist - Track' });
    await h.instance.maybeReplyTo('#c', { username: 'vi' }, 'brb coffee');
    const prompt = h.claudeCalls[0];
    assert.match(prompt, /brb coffee/, 'quotes what they actually said');
    assert.match(prompt, /vi/);
    assert.match(prompt, /Now playing on stream: Artist - Track/);
});

test('offline drops the three music categories', () => {
    const h = makeHarness();
    const withTrack = new Set();
    const withoutTrack = new Set();
    for (let r = 0; r < 100; r++) {
        const rnd = r / 100;
        const inst = makeHarness({ random: () => rnd }).instance;
        withTrack.add(inst._pickCategory('Artist - Track').key);
        withoutTrack.add(inst._pickCategory(null).key);
    }
    for (const k of ['now_playing', 'track_trivia', 'genre_fact']) {
        assert.ok(withTrack.has(k), `${k} available with a track`);
        assert.ok(!withoutTrack.has(k), `${k} must not be picked without a track`);
    }
    assert.ok(withoutTrack.has('robot_joke') && withoutTrack.has('planet_weather'));
});

test('music categories take about 60% when a track is playing', () => {
    const music = new Set(['now_playing', 'track_trivia', 'genre_fact']);
    let hits = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
        const inst = makeHarness({ random: () => i / N }).instance;
        if (music.has(inst._pickCategory('Artist - Track').key)) hits++;
    }
    const pct = (hits / N) * 100;
    assert.ok(pct > 55 && pct < 65, `music share was ${pct}%, expected ~60%`);
});

test('a Claude failure is swallowed — ambient chatter never surfaces an error', async () => {
    const h = makeHarness({
        isLive: () => true,
        claudeCall: async () => { throw new Error('boom'); },
    });
    h.advance(9999);
    assert.equal(await h.instance._tick('#c'), false);
    assert.equal(h.sayCalls.length, 0, 'nothing posted to chat');
    assert.ok(h.logs.some((l) => /suppressed error/.test(l)));
});

test('a slow call does not stack — one in flight at a time', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const h = makeHarness({
        isLive: () => true,
        claudeCall: async () => { await gate; return 'late'; },
    });
    h.advance(9999);
    const first = h.instance._tick('#c');
    const second = await h.instance._tick('#c');
    assert.equal(second, false, 'second tick declines while the first is in flight');
    release();
    assert.equal(await first, true);
});

test('missing dependencies throw at construction', () => {
    assert.throws(() => createIdleChatter({}), /requires a `say` function/);
    assert.throws(() => createIdleChatter({ say: () => {} }), /requires a `claudeCall` function/);
});

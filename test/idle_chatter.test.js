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

test('cooldown is 4 min live and 2 hours offline', () => {
    let live = true;
    const h = makeHarness({ isLive: () => live });
    h.instance.markSpoke();
    assert.equal(h.instance.cooldownActive(), true);
    h.advance(241);
    assert.equal(h.instance.cooldownActive(), false, 'live cooldown clears after 4 min');

    live = false;
    h.instance.markSpoke();
    h.advance(241);
    assert.equal(h.instance.cooldownActive(), true, 'offline still gated after 4 min');
    h.advance(7200);
    assert.equal(h.instance.cooldownActive(), false, 'offline clears after two hours');
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
    h.advance(241);
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

test('with a track but NO title, the music share drops to ~52% — set_vibe is out', () => {
    // ⚠ Weights are absolute, so excluding a category renormalises the rest. Losing
    // set_vibe (16) leaves the other three music ones at 44 of 84 = ~52%, not 60%.
    // Deliberate and small; recorded here so the drift is not mistaken for a bug.
    const music = new Set(['now_playing', 'track_trivia', 'genre_fact']);
    let hits = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
        const inst = makeHarness({ random: () => i / N }).instance;
        if (music.has(inst._pickCategory('Artist - Track', null).key)) hits++;
    }
    const pct = (hits / N) * 100;
    assert.ok(pct > 48 && pct < 57, `music share was ${pct}%, expected ~52%`);
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

// ---------------------------------------------------------------------------
// Regressions from the 21 Aug 2026 live run — all three were observed or proved,
// not hypothesised.

test('never replies to another bot, even when the room is quiet', async () => {
    const h = makeHarness({ isLive: () => false });   // offline == replies otherwise ungated
    for (const b of ['StreamElements', 'Sery_Bot', 'mind_b0t']) {
        assert.equal(
            await h.instance.maybeReplyTo('#c', { username: b }, 'automated post'), false,
            `${b} must not get a reply`);
    }
    assert.equal(h.sayCalls.length, 0);
    // ...but a human in the same conditions does.
    assert.equal(await h.instance.maybeReplyTo('#c', { username: 'a_human' }, 'hi'), true);
});

test('not counting a bot and not replying to it are separate gates', async () => {
    // The activity count already dropped bots; this asserts the reply path does too,
    // because the first version had one without the other.
    const h = makeHarness({ isLive: () => false });
    h.instance.noteMessage({ username: 'Sery_Bot' });
    assert.equal(h.instance.messageCount, 0, 'not counted');
    assert.equal(await h.instance.maybeReplyTo('#c', { username: 'Sery_Bot' }, 'x'), false, 'not answered');
});

test('set_vibe needs a TITLE, not a track — it is about the whole night', () => {
    const seen = (t, ti) => {
        const s = new Set();
        for (let i = 0; i < 300; i++) s.add(makeHarness({ random: () => i / 300 }).instance._pickCategory(t, ti).key);
        return s;
    };
    assert.ok(seen('A - B', 'Cyberium').has('set_vibe'));
    assert.ok(seen(null, 'Cyberium').has('set_vibe'), 'available between tracks');
    assert.ok(!seen('A - B', null).has('set_vibe'), 'not available without a title');
});

test('the set prompt is about the set, and carries the title', () => {
    // ⛔ Ask for set_vibe specifically. The first version of this test took whatever
    // _pickCategory returned and asserted the title was in it — but only set_vibe
    // carries the title, so it failed on any other draw. The test was wrong.
    const h = makeHarness({ random: () => 0 });
    let cat = null;
    for (let i = 0; i < 500 && !cat; i++) {
        const c = makeHarness({ random: () => i / 500 }).instance._pickCategory('A - B', 'Cyberium (Techno/Acid)');
        if (c.key === 'set_vibe') cat = c;
    }
    assert.ok(cat, 'set_vibe must be reachable');
    const p = cat.prompt('A - B', 'Cyberium (Techno/Acid)');
    assert.match(p, /Cyberium/, 'the title is in the prompt');
    assert.match(p, /SET AS A WHOLE/, 'and it asks for the set, not the track');
});

test('a reply carries the set framing as well as the track', async () => {
    const h = makeHarness({ isLive: () => false, nowPlaying: () => 'A - B', streamTitle: () => 'Cyberium (Techno/Acid)' });
    await h.instance.maybeReplyTo('#c', { username: 'v' }, 'nice one');
    assert.match(h.claudeCalls[0], /Cyberium/, 'the set title is in the reply context');
    assert.match(h.claudeCalls[0], /A - B/, 'and so is the track');
});

test('music share stays ~60% now that four categories share it', () => {
    const music = new Set(['now_playing', 'track_trivia', 'genre_fact', 'set_vibe']);
    let hits = 0; const N = 1000;
    for (let i = 0; i < N; i++) {
        const inst = makeHarness({ random: () => i / N }).instance;
        if (music.has(inst._pickCategory('A - B', 'Cyberium').key)) hits++;
    }
    const pct = (hits / N) * 100;
    assert.ok(pct > 55 && pct < 65, `music share was ${pct}%, expected ~60%`);
});

test('⛔ every music category carries the night\'s title, not just set_vibe', () => {
    // The 21 Aug Berlin School error: genre_fact saw only the track name, inferred
    // "trance", and credited Tangerine Dream over a Techno/Acid/Dark Trance set.
    // Only set_vibe had the title, which is the gap this asserts is closed.
    const TITLE = 'Cyberium (Techno/Acid/Dark Trance)';
    const music = ['now_playing', 'track_trivia', 'genre_fact', 'set_vibe'];
    const found = {};
    for (let i = 0; i < 600; i++) {
        const c = makeHarness({ random: () => i / 600 }).instance._pickCategory('A - B', TITLE);
        found[c.key] = c.prompt('A - B', TITLE);
    }
    for (const k of music) {
        assert.ok(found[k], `${k} must be reachable`);
        assert.match(found[k], /Techno\/Acid\/Dark Trance/, `${k} must carry the title`);
    }
});

test('genre_fact is told explicitly not to drift to another lineage', () => {
    const TITLE = 'Cyberium (Techno/Acid/Dark Trance)';
    let p = null;
    for (let i = 0; i < 600 && !p; i++) {
        const c = makeHarness({ random: () => i / 600 }).instance._pickCategory('A - B', TITLE);
        if (c.key === 'genre_fact') p = c.prompt('A - B', TITLE);
    }
    assert.ok(p);
    assert.match(p, /Do NOT reach for a different/, 'the anti-drift instruction is present');
});

test('without a title the music prompts still read cleanly', () => {
    let p = null;
    for (let i = 0; i < 600 && !p; i++) {
        const c = makeHarness({ random: () => i / 600 }).instance._pickCategory('A - B', null);
        if (c.key === 'genre_fact') p = c.prompt('A - B', null);
    }
    assert.ok(p);
    assert.ok(!/Tonight's stream is titled/.test(p), 'no empty title block');
    assert.match(p, /Stay close to what is actually playing/);
});

// ---------------------------------------------------------------------------
// Backoff: unprompted comments into an empty room double the wait — 4, 8, 16 —
// capped at 16 min, live only, and reset by ANY human message (Max, 21 Aug 2026).

test('the live cooldown doubles 4 -> 8 -> 16 and stops at 16', async () => {
    const h = makeHarness({ isLive: () => true });
    // ⚠ BASE DOUBLED 120 -> 240 (Max, 1 Sep 2026) and the CEILING left at 960, so the
    // ladder is ONE RUNG SHORTER than before — it caps at the second comment, not the
    // fourth. A consequence of the change, recorded so it is not read as a regression.
    const expected = [240, 480, 960, 960, 960, 960];
    for (const want of expected) {
        h.advance(100000);                       // clear whatever the current wait is
        assert.equal(await h.instance._tick('#c'), true);
        assert.equal(h.instance.cooldownSec, want, `expected a ${want}s wait`);
    }
});

test('the backoff actually gates — it is not just a reported number', async () => {
    const h = makeHarness({ isLive: () => true });
    h.advance(100000); await h.instance._tick('#c');   // streak 1 -> next wait 240s
    h.advance(100000); await h.instance._tick('#c');   // streak 2 -> next wait 480s
    assert.equal(h.instance.cooldownSec, 480);
    h.advance(400);
    assert.equal(await h.instance._tick('#c'), false, 'still gated at 400s of a 480s wait');
    h.advance(100);
    assert.equal(await h.instance._tick('#c'), true, 'fires once 480s has passed');
});

test('ANY human message resets the backoff to the base', async () => {
    const h = makeHarness({ isLive: () => true });
    for (let i = 0; i < 3; i++) { h.advance(100000); await h.instance._tick('#c'); }
    assert.equal(h.instance.selfStreak, 3);
    assert.equal(h.instance.cooldownSec, 960, '3 comments in -> 16 minutes, the cap');

    h.instance.noteMessage({ username: 'a_human' });
    assert.equal(h.instance.selfStreak, 0);
    assert.equal(h.instance.cooldownSec, 240, 'back to 4 minutes');
});

test('a BOT message does not reset the backoff', async () => {
    const h = makeHarness({ isLive: () => true });
    h.advance(100000); await h.instance._tick('#c');
    assert.equal(h.instance.selfStreak, 1);
    h.instance.noteMessage({ username: 'StreamElements' });
    assert.equal(h.instance.selfStreak, 1, 'automation is not company');
});

test('replying to a human does not itself escalate the streak', async () => {
    const h = makeHarness({ isLive: () => true });
    h.advance(100000);
    h.instance.noteMessage({ username: 'a_human' });          // resets to 0
    assert.equal(await h.instance.maybeReplyTo('#c', { username: 'a_human' }, 'hi'), true);
    assert.equal(h.instance.selfStreak, 0, 'a reply is not an unprompted comment');
});

test('offline stays flat at two hours — no backoff on top', async () => {
    const h = makeHarness({ isLive: () => false });
    for (let i = 0; i < 4; i++) { h.advance(100000); await h.instance._tick('#c'); }
    assert.equal(h.instance.selfStreak, 4, 'the counter still moves');
    assert.equal(h.instance.cooldownSec, 7200, 'but offline ignores it');
});

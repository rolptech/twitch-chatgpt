// test/watch_streak.test.js
//
// Run with: node --test
//
// Tag values are the real ones from Twitch's developer forum, not invented:
//   msg-id=viewermilestone; msg-param-category=watch-streak; msg-param-value=10
// tmi.js has no named case for viewermilestone, so it arrives via the
// 'usernotice' catch-all as (msgid, channel, tags, msg).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWatchStreak, parseWatchStreak, sentencesFor } from '../watch_streak.js';
import { sayChunked } from '../chunk_text.js';

const TAGS = (value, extra = {}) => ({
    'msg-id': 'viewermilestone',
    'msg-param-category': 'watch-streak',
    'msg-param-value': String(value),
    'display-name': 'sealpupB3B0',
    login: 'sealpupb3b0',
    ...extra,
});

function makeHarness(opts = {}) {
    const sayCalls = [];
    const claudeCalls = [];
    const logs = [];
    const instance = createWatchStreak({
        say: (channel, message) => sayCalls.push({ channel, message }),
        claudeCall: async (prompt) => {
            claudeCalls.push(prompt);
            if (opts.claudeThrows) throw new Error('claude exploded');
            return opts.claudeReply !== undefined ? opts.claudeReply : 'Respect.';
        },
        sayChunkedFn: sayChunked,
        log: (...a) => logs.push(a.join(' ')),
        ...opts.overrides,
    });
    return { instance, sayCalls, claudeCalls, logs };
}

// --- parsing ------------------------------------------------------------

test('parses a real watch streak notice', () => {
    const p = parseWatchStreak('viewermilestone', TAGS(25));
    assert.deepEqual(p, { name: 'sealpupB3B0', streak: 25 });
});

test('the count is a NUMBER — the tag arrives as a string', () => {
    const p = parseWatchStreak('viewermilestone', TAGS(240));
    assert.equal(typeof p.streak, 'number');
    assert.ok(parseWatchStreak('viewermilestone', TAGS(100)).streak
        > parseWatchStreak('viewermilestone', TAGS(25)).streak);
});

test('⛔ other viewermilestone categories are ignored', () => {
    // msg-param-category is a family; watch-streak is one member of it.
    assert.equal(parseWatchStreak('viewermilestone', TAGS(10, { 'msg-param-category': 'something-else' })), null);
});

test('⛔ other usernotice types are ignored', () => {
    for (const id of ['sub', 'resub', 'raid', 'ritual', 'announcement', '']) {
        assert.equal(parseWatchStreak(id, TAGS(10)), null, `${id} must not match`);
    }
});

test('falls back to login when display-name is absent', () => {
    const t = TAGS(10); delete t['display-name'];
    assert.equal(parseWatchStreak('viewermilestone', t).name, 'sealpupb3b0');
});

test('a nameless or malformed notice is rejected rather than half-handled', () => {
    const noName = TAGS(10); delete noName['display-name']; delete noName.login;
    assert.equal(parseWatchStreak('viewermilestone', noName), null);
    for (const v of ['0', '-5', 'abc', '']) {
        assert.equal(parseWatchStreak('viewermilestone', TAGS(v)), null, `value ${v} must be rejected`);
    }
    assert.equal(parseWatchStreak('viewermilestone', null), null);
});

// --- length bands -------------------------------------------------------

test('sentence count follows Max\'s exact bands', () => {
    // "less than 25 gets one line, 25-99 two, 100+ three, 200+ four"
    assert.equal(sentencesFor(1), 1);
    assert.equal(sentencesFor(24), 1);
    assert.equal(sentencesFor(25), 2);
    assert.equal(sentencesFor(99), 2);
    assert.equal(sentencesFor(100), 3);
    assert.equal(sentencesFor(199), 3);
    assert.equal(sentencesFor(200), 4);
    assert.equal(sentencesFor(240), 4);   // his own streak on another channel
});

test('the boundaries are inclusive-low, so 25 and 100 and 200 step UP', () => {
    for (const [below, at] of [[24, 25], [99, 100], [199, 200]]) {
        assert.ok(sentencesFor(at) > sentencesFor(below), `${at} must exceed ${below}`);
    }
});

// --- prompt -------------------------------------------------------------

test('the prompt carries the name, the count and the sentence budget', async () => {
    const h = makeHarness();
    await h.instance.onUsernotice('viewermilestone', '#chan', TAGS(25));
    const p = h.claudeCalls[0];
    assert.match(p, /@sealpupB3B0/);
    assert.match(p, /25-stream watch streak/);
    assert.match(p, /EXACTLY 2 SENTENCES/);
});

test('a 1-sentence budget is not pluralised', async () => {
    const h = makeHarness();
    await h.instance.onUsernotice('viewermilestone', '#chan', TAGS(7));
    assert.match(h.claudeCalls[0], /EXACTLY 1 SENTENCE\./);
});

test('⛔ the prompt names NO tier numbers', async () => {
    // Twitch does not publish them. I guessed "3, 10, 25, 50, 100", found the
    // same list in community sources, and repeated it — Max, who sees these
    // fire, says there are tiers between 3 and 10, and his own is 240.
    const h = makeHarness();
    await h.instance.onUsernotice('viewermilestone', '#chan', TAGS(50));
    const p = h.claudeCalls[0];
    assert.match(p, /Do NOT say how many more streams until the next milestone/i);
    assert.match(p, /Twitch does not publish which counts are milestones/i);
});

test('the scale is described as a range, not as thresholds', async () => {
    const h = makeHarness();
    await h.instance.onUsernotice('viewermilestone', '#chan', TAGS(240));
    const p = h.claudeCalls[0];
    assert.match(p, /Under 25 is ordinary/);
    assert.match(p, /three-figure streak is exceptional/);
});

test('⛔ Max\'s own 240 on another channel never reaches the prompt', async () => {
    // It calibrated the range, but in the bot's context it risks being repeated
    // in his chat — naming his viewing of someone else's channel, unprompted.
    for (const n of [10, 25, 100, 240]) {
        const h = makeHarness();
        await h.instance.onUsernotice('viewermilestone', '#chan', TAGS(n));
        assert.doesNotMatch(h.claudeCalls[0], /Hiss|pleasanthiss/i);
        if (n !== 240) assert.doesNotMatch(h.claudeCalls[0], /240/);
    }
});

test('restating the count is explicitly allowed here', async () => {
    // Unlike follows and cheers, where repeating the announcement is echo.
    const h = makeHarness();
    await h.instance.onUsernotice('viewermilestone', '#chan', TAGS(25));
    assert.match(h.claudeCalls[0], /You may mention the number/i);
});

test('it forbids inventing facts about the viewer', async () => {
    const h = makeHarness();
    await h.instance.onUsernotice('viewermilestone', '#chan', TAGS(25));
    assert.match(h.claudeCalls[0], /Do not invent facts about them/i);
});

// --- behaviour ----------------------------------------------------------

test('thanks them on a real notice', async () => {
    const h = makeHarness({ claudeReply: 'Twenty-five nights, @sealpupB3B0.' });
    assert.equal(await h.instance.onUsernotice('viewermilestone', '#chan', TAGS(25)), true);
    assert.deepEqual(h.sayCalls, [{ channel: '#chan', message: 'Twenty-five nights, @sealpupB3B0.' }]);
});

test('an unrelated usernotice is not consumed', async () => {
    const h = makeHarness();
    assert.equal(await h.instance.onUsernotice('announcement', '#chan', {}), false);
    assert.equal(h.claudeCalls.length, 0);
});

test('the kill switch silences it', async () => {
    const h = makeHarness({ overrides: { isEnabled: () => false } });
    assert.equal(await h.instance.onUsernotice('viewermilestone', '#chan', TAGS(25)), false);
    assert.equal(h.claudeCalls.length, 0);
    assert.equal(h.sayCalls.length, 0);
});

test('no floor — a small streak still fires, because Max publishes manually', async () => {
    const h = makeHarness();
    assert.equal(await h.instance.onUsernotice('viewermilestone', '#chan', TAGS(3)), true);
    assert.equal(h.sayCalls.length, 1);
});

test('no batching — consecutive streaks each get their own reply', async () => {
    const h = makeHarness();
    await h.instance.onUsernotice('viewermilestone', '#chan', TAGS(5, { 'display-name': 'a' }));
    await h.instance.onUsernotice('viewermilestone', '#chan', TAGS(9, { 'display-name': 'b' }));
    assert.equal(h.sayCalls.length, 2);
});

test('a Claude failure is swallowed and logged, not thrown', async () => {
    const h = makeHarness({ claudeThrows: true });
    assert.equal(await h.instance.onUsernotice('viewermilestone', '#chan', TAGS(25)), true);
    assert.equal(h.sayCalls.length, 0);
    assert.ok(h.logs.some((l) => /watch-streak error/.test(l)));
});

test('an empty reply says nothing rather than posting blank', async () => {
    const h = makeHarness({ claudeReply: '   ' });
    await h.instance.onUsernotice('viewermilestone', '#chan', TAGS(25));
    assert.equal(h.sayCalls.length, 0);
});

test('a 4-sentence reply over the limit is chunked on word boundaries', async () => {
    const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    const h = makeHarness({ claudeReply: long, overrides: { maxLength: 200 } });
    await h.instance.onUsernotice('viewermilestone', '#chan', TAGS(240));
    await new Promise((r) => setTimeout(r, 3200));
    assert.ok(h.sayCalls.length > 1);
    for (const c of h.sayCalls) assert.equal(c.message, c.message.trim());
});

test('constructor rejects missing required side effects', () => {
    assert.throws(() => createWatchStreak({}), /requires a `say` function/);
    assert.throws(() => createWatchStreak({ say: () => {} }), /requires a `claudeCall` function/);
});

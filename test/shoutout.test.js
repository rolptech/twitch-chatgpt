// test/shoutout.test.js
//
// Run with: node --test
//
// The manual "SO <name>" command and the profile block it shares with the raid
// path. `fetchProfile`, `say` and `claudeCall` are injected fakes — no network,
// no credentials, no twitch_profile.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShoutout, parseShoutoutTarget, profileLines } from '../shoutout.js';
import { sayChunked } from '../chunk_text.js';

// Stand-ins for twitch_profile.js's cleaners — identity is enough here; what
// matters is that profileLines calls them and omits empty results.
const HELPERS = {
    cleanDescription: (d) => (d || '').trim(),
    extractPanelText: (p) => (Array.isArray(p) ? p.map((x) => x.description).filter(Boolean).join(' | ') : ''),
    cleanTitle: (t) => (t || '').trim(),
    relativeTimePhrase: () => 'two days ago',
};

const PROFILE = {
    description: 'Techno and acid, Detroit',
    panels: [{ description: 'I play dark techno every Thursday' }],
    stream: null,
    lastBroadcast: { title: 'Acid Night', startedAt: '2026-08-12T00:00:00Z', game: { name: 'DJs' } },
};

function makeHarness(opts = {}) {
    const sayCalls = [];
    const claudeCalls = [];
    const fetched = [];
    const logs = [];
    const instance = createShoutout({
        say: (channel, message) => sayCalls.push({ channel, message }),
        claudeCall: async (prompt) => {
            claudeCalls.push(prompt);
            if (opts.claudeThrows) throw new Error('claude exploded');
            return opts.claudeReply !== undefined ? opts.claudeReply : 'Go follow them!';
        },
        fetchProfile: async (login) => {
            fetched.push(login);
            if (opts.fetchThrows) throw new Error('network down');
            return opts.profile !== undefined ? opts.profile : PROFILE;
        },
        helpers: HELPERS,
        sayChunkedFn: sayChunked,
        log: (...a) => logs.push(a.join(' ')),
        ...opts.overrides,
    });
    return { instance, sayCalls, claudeCalls, fetched, logs };
}

const USER = { username: 'mind_prime' };

// --- parsing ------------------------------------------------------------

test('parses the form Max actually types', () => {
    // Verified against his real messages, 14 Aug 2026 — always "SO @name":
    //   @mb SO @violetdotwav · @mb SO @AngelinaVanArden · @mb SO @ItinerantHammer
    assert.equal(parseShoutoutTarget('SO @violetdotwav'), 'violetdotwav');
    assert.equal(parseShoutoutTarget('so @violetdotwav'), 'violetdotwav');
    assert.equal(parseShoutoutTarget('  SO   @violetdotwav  '), 'violetdotwav');
});

test('accepts the longer spellings too', () => {
    assert.equal(parseShoutoutTarget('shoutout @someone'), 'someone');
    assert.equal(parseShoutoutTarget('shout out @someone'), 'someone');
});

test('⛔ ordinary chat containing "so" does NOT fire a shoutout', () => {
    for (const m of [
        'so anyway what track is this',
        'so good',                                            // the bare-word trap
        'so cool',
        'so much this',
        'I was so tired',
        'so @violetdotwav was saying something interesting',   // trailing text
        'SO',
        '',
    ]) {
        assert.equal(parseShoutoutTarget(m), null, `should not match: "${m}"`);
    }
});

test('⛔ the bare "so" form REQUIRES an @ — "so good" is not a shoutout to "good"', () => {
    // Caught by this test, not by reading the regex. "so <word>" is a complete
    // and common English utterance, so anchoring the pattern was not enough.
    assert.equal(parseShoutoutTarget('so good'), null);
    assert.equal(parseShoutoutTarget('so @good'), 'good');
    // "shoutout" is unambiguous, so it still takes a bare name.
    assert.equal(parseShoutoutTarget('shoutout good'), 'good');
});

test('returns null on non-strings rather than throwing', () => {
    for (const v of [null, undefined, 42, {}]) assert.equal(parseShoutoutTarget(v), null);
});

// --- the shared profile block -------------------------------------------

test('profileLines renders every field that is present', () => {
    const lines = profileLines(PROFILE, HELPERS);
    assert.match(lines.join('\n'), /About them: Techno and acid, Detroit/);
    assert.match(lines.join('\n'), /dark techno every Thursday/);
    assert.match(lines.join('\n'), /Their last stream: "Acid Night" in DJs, two days ago/);
});

test('profileLines omits empty fields rather than emitting blanks', () => {
    const lines = profileLines({ description: '', panels: [], stream: null, lastBroadcast: null }, HELPERS);
    assert.deepEqual(lines, []);
});

test('profileLines returns nothing for a null profile', () => {
    assert.deepEqual(profileLines(null, HELPERS), []);
});

test('a live channel is flagged', () => {
    const lines = profileLines({ ...PROFILE, stream: { id: '123' } }, HELPERS);
    assert.ok(lines.some((l) => /LIVE right now/.test(l)));
});

test('⛔ the panel-handling instruction travels with the panel data', () => {
    // Three regex classifiers were tried before this instruction existed and all
    // shipped gear lists and donation pitches into shoutouts. If the data ever
    // ships without the instruction, that returns.
    const lines = profileLines(PROFILE, HELPERS);
    const panelLine = lines.find((l) => /dark techno every Thursday/.test(l));
    assert.match(panelLine, /never repeat donation appeals/i);
    assert.match(panelLine, /Use ONLY what genuinely describes them/i);
});

// --- behaviour ----------------------------------------------------------

test('fetches the target and shouts out', async () => {
    const h = makeHarness({ claudeReply: 'violetdotwav plays dark techno — go watch.' });
    assert.equal(await h.instance.onTriggered('#chan', USER, 'SO @violetdotwav'), true);
    assert.deepEqual(h.fetched, ['violetdotwav']);
    assert.deepEqual(h.sayCalls, [{ channel: '#chan', message: 'violetdotwav plays dark techno — go watch.' }]);
});

test('the prompt carries the fetched facts and bans username-guessing', async () => {
    const h = makeHarness();
    await h.instance.onTriggered('#chan', USER, 'SO @violetdotwav');
    const p = h.claudeCalls[0];
    assert.match(p, /\[SHOUTOUT\]/);
    assert.match(p, /Techno and acid, Detroit/);
    assert.match(p, /Do NOT guess anything from their username/i);
    assert.match(p, /based ONLY on what is above/i);
});

test('⛔ FAILS CLOSED when the profile cannot be fetched', async () => {
    // This is the whole point of the feature: a name-only shoutout is the thing
    // being replaced, so producing one on failure would be indistinguishable
    // from the bug it fixes.
    const h = makeHarness({ profile: null });
    assert.equal(await h.instance.onTriggered('#chan', USER, 'SO @ghost'), true);
    assert.equal(h.claudeCalls.length, 0, 'must not ask Claude to improvise');
    assert.match(h.sayCalls[0].message, /Couldn't pull up ghost/);
    assert.match(h.sayCalls[0].message, /rather than a made-up one/);
});

test('a thrown fetch also fails closed, and is logged', async () => {
    const h = makeHarness({ fetchThrows: true });
    assert.equal(await h.instance.onTriggered('#chan', USER, 'SO @ghost'), true);
    assert.equal(h.claudeCalls.length, 0);
    assert.match(h.sayCalls[0].message, /Couldn't pull up ghost/);
    assert.ok(h.logs.some((l) => /profile fetch failed/.test(l)));
});

test('a non-shoutout message is not consumed, so the trigger path still runs', async () => {
    const h = makeHarness();
    assert.equal(await h.instance.onTriggered('#chan', USER, 'what track is this'), false);
    assert.equal(h.fetched.length, 0, 'must not fetch on ordinary chat');
    assert.equal(h.claudeCalls.length, 0);
});

// --- the mod/broadcaster gate -------------------------------------------

test('⛔ a plain viewer cannot trigger a shoutout', async () => {
    const h = makeHarness({ overrides: { isAllowed: (u) => !!(u && u.mod) } });
    assert.equal(await h.instance.onTriggered('#chan', { username: 'viewer' }, 'SO @someone'), true,
        'consumed, so it cannot fall through to the improvising trigger path');
    assert.equal(h.fetched.length, 0, 'must not spend a profile fetch');
    assert.equal(h.claudeCalls.length, 0, 'must not spend a Claude call');
    assert.equal(h.sayCalls.length, 0, 'refusal is SILENT — no way to make the bot talk');
});

test('a mod can trigger it', async () => {
    const h = makeHarness({ overrides: { isAllowed: (u) => !!(u && u.mod) } });
    await h.instance.onTriggered('#chan', { username: 'amod', mod: true }, 'SO @someone');
    assert.deepEqual(h.fetched, ['someone']);
    assert.equal(h.sayCalls.length, 1);
});

test('the broadcaster can trigger it via the badge, not just the mod flag', async () => {
    const isAllowed = (u) => !!(u && (u.mod || (u.badges && u.badges.broadcaster === '1')));
    const h = makeHarness({ overrides: { isAllowed } });
    await h.instance.onTriggered('#chan', { username: 'mind_prime', badges: { broadcaster: '1' } }, 'SO @someone');
    assert.equal(h.sayCalls.length, 1);
});

test('the kill switch consumes but stays silent, and does not fetch', async () => {
    const h = makeHarness({ overrides: { isEnabled: () => false } });
    assert.equal(await h.instance.onTriggered('#chan', USER, 'SO @someone'), true);
    assert.equal(h.fetched.length, 0);
    assert.equal(h.sayCalls.length, 0);
});

test('a Claude failure is swallowed and logged, not thrown', async () => {
    const h = makeHarness({ claudeThrows: true });
    assert.equal(await h.instance.onTriggered('#chan', USER, 'SO @someone'), true);
    assert.equal(h.sayCalls.length, 0);
    assert.ok(h.logs.some((l) => /shoutout error/.test(l)));
});

test('an over-long shoutout is chunked on word boundaries', async () => {
    const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    const h = makeHarness({ claudeReply: long, overrides: { maxLength: 200 } });
    await h.instance.onTriggered('#chan', USER, 'SO @someone');
    await new Promise((r) => setTimeout(r, 3200));
    assert.ok(h.sayCalls.length > 1);
    for (const c of h.sayCalls) {
        assert.ok(c.message.length <= 200);
        assert.equal(c.message, c.message.trim());
    }
});

test('constructor rejects missing required side effects', () => {
    assert.throws(() => createShoutout({}), /requires a `say` function/);
    assert.throws(() => createShoutout({ say: () => {} }), /requires a `claudeCall` function/);
    assert.throws(() => createShoutout({ say: () => {}, claudeCall: async () => '' }),
        /requires a `fetchProfile` function/);
});

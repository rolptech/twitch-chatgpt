// test/twitch_live_state.test.js
//
// Run with: node --test
//
// fetchIsLive exists because EventSub stream.online/offline are TRANSITIONS: a process
// starting mid-stream misses the event and treats a live channel as offline for the
// whole broadcast. Observed live 21 Aug 2026 on the deploy that shipped idle_chatter.
//
// ⛔ The three-way result is the point. null means "could not determine" and MUST NOT
// be read as offline — a caller that collapses it to false reintroduces the bug it was
// written to fix, silently, on any network blip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchIsLive } from '../twitch_profile.js';

function withFetch(impl, fn) {
    const real = globalThis.fetch;
    globalThis.fetch = impl;
    return Promise.resolve(fn()).finally(() => { globalThis.fetch = real; });
}

const ok = (body) => async () => ({ ok: true, json: async () => body });

test('a live channel resolves true', async () => {
    await withFetch(ok({ data: { user: { stream: { id: '123' } } } }), async () => {
        assert.equal(await fetchIsLive('someone'), true);
    });
});

test('an offline channel resolves false — stream is null, user is not', async () => {
    await withFetch(ok({ data: { user: { stream: null } } }), async () => {
        assert.equal(await fetchIsLive('someone'), false);
    });
});

test('an unknown login resolves NULL, not false', async () => {
    // ⛔ Twitch returns {data:{user:null}} for a login that does not exist. Reading
    // that as "offline" would be a confident wrong answer about a real channel whose
    // name was merely mistyped in config.
    await withFetch(ok({ data: { user: null } }), async () => {
        assert.equal(await fetchIsLive('nope'), null);
    });
});

test('a non-2xx resolves null', async () => {
    await withFetch(async () => ({ ok: false, json: async () => ({}) }), async () => {
        assert.equal(await fetchIsLive('someone'), null);
    });
});

test('a thrown network error resolves null and never rejects', async () => {
    await withFetch(async () => { throw new Error('offline machine'); }, async () => {
        assert.equal(await fetchIsLive('someone'), null);
    });
});

test('malformed json resolves null rather than throwing', async () => {
    await withFetch(async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }), async () => {
        assert.equal(await fetchIsLive('someone'), null);
    });
});

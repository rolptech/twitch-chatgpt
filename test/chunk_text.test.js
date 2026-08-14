// test/chunk_text.test.js
//
// Run with: node --test
//
// The two failing cases below are REAL output from Max's chat on 14 Aug 2026,
// not invented examples. The old splitter cut at exactly maxLength with no
// regard for word boundaries, and had been doing so in the raid shoutouts for
// as long as they existed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, sayChunked } from '../chunk_text.js';

test('short text is returned whole, in one part', () => {
    assert.deepEqual(chunkText('hello', 399), ['hello']);
});

test('empty text produces no parts at all — never a blank message', () => {
    assert.deepEqual(chunkText('', 399), []);
    assert.deepEqual(chunkText(null, 399), []);
    assert.deepEqual(chunkText(undefined, 399), []);
});

test('⛔ the real !kosmische break no longer splits "drones"', () => {
    const real = "Kosmische Musik emerged from West Germany's experimental studios in the late '60s and '70s, where synthesizer pioneers like Klaus Schulze created soundscapes designed to evoke outer space and inner meditation. Unlike Krautrock's rock-based cousins, Kosmische strips away drums and structure, layering analog synthesizers and treated acoustic instruments into vast, immersive drones. Tangerine Dream perfected this in albums like Phaedra.";
    const parts = chunkText(real, 399);
    assert.ok(parts.length > 1, 'this text must actually split');
    for (const p of parts) assert.ok(p.length <= 399);
    // No part may start or end mid-word.
    assert.doesNotMatch(parts[0], /\bdr$/, 'the observed failure: "...immersive dr"');
    assert.doesNotMatch(parts[1], /^ones\./, 'the observed failure: "ones. Tangerine..."');
    assert.ok(parts.join(' ').includes('drones'), 'the word survives intact');
});

test('⛔ the real raid-shoutout break no longer splits "looking"', () => {
    const real = 'She has a mystical connection to synthesizers that borders on supernatural - some say she can make a Moog weep just by looking at it!';
    const parts = chunkText(real, 100);
    assert.doesNotMatch(parts[0], /looki$/);
    assert.ok(parts.join(' ').includes('looking'), 'the word survives intact');
});

test('every part respects the limit', () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    for (const max of [20, 50, 399, 500]) {
        for (const p of chunkText(text, max)) assert.ok(p.length <= max, `part exceeded ${max}`);
    }
});

test('no part is blank or whitespace-only', () => {
    const parts = chunkText('a'.repeat(50) + '     ' + 'b'.repeat(50), 40);
    assert.ok(parts.length > 1, 'this input must actually split');
    for (const p of parts) {
        assert.doesNotMatch(p, /^\s*$/, 'whitespace-only part emitted');
        // Whitespace runs are kept as tokens so nothing is lost, which used to
        // let a part end with the run that did not fit — "aaaa     ".
        assert.equal(p, p.trim(), 'part has leading or trailing whitespace');
    }
});

test('⛔ a single token longer than the limit is hard-split, not dropped or hung', () => {
    const parts = chunkText('x'.repeat(1000), 100);
    assert.equal(parts.length, 10);
    assert.equal(parts.join(''), 'x'.repeat(1000), 'nothing lost');
});

test('a long URL is hard-split rather than making no progress', () => {
    const url = 'https://example.com/' + 'a'.repeat(500);
    const parts = chunkText(`see ${url} thanks`, 100);
    assert.ok(parts.length > 1);
    for (const p of parts) assert.ok(p.length <= 100);
    assert.ok(parts.join('').includes('a'.repeat(500)));
});

test('nothing is lost — the parts rejoin to the original words', () => {
    const text = "Tangerine Dream perfected this in albums like Phaedra, using modular synths to build hypnotic walls of sound across Berlin.";
    const parts = chunkText(text, 40);
    assert.deepEqual(parts.join(' ').split(/\s+/), text.split(/\s+/));
});

test('an absurd or missing maxLength returns the text rather than looping', () => {
    assert.deepEqual(chunkText('hello', 0), ['hello']);
    assert.deepEqual(chunkText('hello', NaN), ['hello']);
    assert.deepEqual(chunkText('hello', undefined), ['hello']);
});

// --- sayChunked ---------------------------------------------------------

test('a single-part message is said immediately, with no timer', () => {
    const calls = [];
    let timers = 0;
    sayChunked((c, m) => calls.push(m), '#chan', 'short', 399, () => { timers++; });
    assert.deepEqual(calls, ['short']);
    assert.equal(timers, 0, 'a one-part message must not be deferred');
});

test('multi-part messages are spaced one second apart', () => {
    const scheduled = [];
    sayChunked(() => {}, '#chan', 'word '.repeat(200), 100, (fn, delay) => scheduled.push(delay));
    assert.ok(scheduled.length > 1);
    assert.deepEqual(scheduled, scheduled.map((_, i) => 1000 * i));
});

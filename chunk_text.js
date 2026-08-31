// chunk_text.js
//
// Split a message into Twitch-sized parts WITHOUT cutting a word in half.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS (14 Aug 2026)
//
// Every Claude path in this bot had its own copy of:
//
//     text.match(new RegExp(`.{1,${maxLength}}`, "g"))
//
// which cuts at exactly maxLength and does not care what it lands in the middle
// of. Live examples from Max's chat, both real:
//
//     "...into vast, immersive dr"  /  "ones. Tangerine Dream perfected..."
//     "...make a Moog weep just by looki"  /  "ng at it!"
//
// It had been doing this in the raid shoutouts for as long as they have existed;
// the longer topic-command answers only made it frequent enough to notice.
//
// ⛔ EIGHT COPIES, ONE BEHAVIOUR — one each in sub_thanks, follow_thanks,
// cheer_thanks and topic_commands, plus FOUR inline in index.js. Fixing the copy
// that happened to be observed would have left seven behind, all still cutting
// words in half, and the next person would have fixed an eighth. One home instead.
//
// ⚠ I said "six" before counting, and the count was the whole point — the fix is
// only worth doing if it catches the ones nobody has seen fail. Grep for the
// construct, do not enumerate from memory.
//
// ⚠ twitch_profile.js already had _capAtWordBoundary and has done all along —
// the knowledge was in the repo, just not where the splitting happens.
// ---------------------------------------------------------------------------

// Splits on whitespace, keeping each part <= maxLength.
//
// ⛔ A single token longer than maxLength is HARD-SPLIT rather than skipped or
// emitted oversized. A URL or an emote wall can legitimately exceed the limit,
// and a splitter that cannot make progress on one is a hang, not a nicety.
export function chunkText(text, maxLength) {
    const s = String(text == null ? "" : text);
    const max = Number(maxLength);
    if (!Number.isFinite(max) || max < 1) return s ? [s] : [];
    if (s.length <= max) return s ? [s] : [];

    const parts = [];
    let current = "";

    const flush = () => {
        // ⛔ Trimmed on the way out. Because whitespace runs are kept as tokens
        // so nothing is lost, a part can otherwise end with the run that did not
        // fit — "aaaa     " — and post to chat with trailing spaces.
        const t = current.trim();
        if (t) parts.push(t);
        current = "";
    };

    // Keep the whitespace runs so joining parts back gives the original text.
    for (const token of s.split(/(\s+)/)) {
        if (!token) continue;

        if (current.length + token.length <= max) {
            current += token;
            continue;
        }

        // Doesn't fit. Close the current part first — but never emit a part
        // that is only whitespace, and never start a new one with it.
        if (/^\s+$/.test(token)) { flush(); continue; }

        flush();

        if (token.length <= max) {
            current = token;
            continue;
        }

        // Token alone exceeds the limit: hard-split it.
        let rest = token;
        while (rest.length > max) {
            parts.push(rest.slice(0, max));
            rest = rest.slice(max);
        }
        current = rest;
    }

    flush();
    return parts;
}

// The shape every caller actually wants: chunk, then post one part per second
// so Twitch's own rate limiting doesn't drop the tail.

// ---------------------------------------------------------------------------
// ⛔⛔ NEVER POST AN UNFINISHED SENTENCE (ported from Philo_B0t, 30 Aug 2026).
//
// Philo_B0t ended every reply mid-clause — "belonging", "the one", "And then he
// would". THREE ROUNDS were spent tuning max_tokens (300 → 200 → 250) before it
// was established that the ceiling was not the cause: the final sample stopped a
// third short of its limit and was severed anyway.
//
// ⇒ This fixes the SYMPTOM deterministically without needing the cause. If text
//   does not end on terminal punctuation, cut back to the last sentence that does.
//
// ⚠ Mind_B0t is newly exposed to this: max_tokens dropped 300 → 200 on 30 Aug, and
//   file_context.txt still asks shoutouts to run 600-800 characters — right at the
//   new ceiling, and it explicitly instructs "plan the ending so the last sentence
//   completes", which it can no longer reliably do unaided.
//
// ⛔ Applied in sayChunked (BEFORE chunking) and never to an individual chunk —
//   chunk 1 of 3 legitimately ends mid-sentence and trimming it would delete the
//   rest of the message.
export function completeSentencesOnly(text) {
    const t = String(text == null ? "" : text).trim();
    if (!t) return t;
    if (/[.!?…"'’”\)]$/.test(t)) return t;
    const m = t.match(/^[\s\S]*[.!?…]["'’”\)]?(?=\s|$)/);
    const kept = m ? m[0].trim() : "";
    // Proportional, not a fixed floor: a fixed minimum rejected the salvage on
    // short replies and returned the severed text unchanged — the very bug this
    // prevents. If trimming would discard more than a third, the reply was mostly
    // one long unfinished clause and the original is the lesser evil.
    return (kept.length >= t.length * 0.66) ? kept : t;
}

export function sayChunked(say, channel, text, maxLength, setTimeoutFn = setTimeout) {
    const parts = chunkText(completeSentencesOnly(text), maxLength);
    if (parts.length === 1) { say(channel, parts[0]); return parts; }
    parts.forEach((part, index) => setTimeoutFn(() => say(channel, part), 1000 * index));
    return parts;
}

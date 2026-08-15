// watch_streak.js
//
// Thank-yous for Twitch Watch Streaks (Max, 15 Aug 2026: "thank them for the
// watch streak, with more enthusiasm for longer ones").
//
// ---------------------------------------------------------------------------
// HOW IT ARRIVES — measured from the docs, not guessed
//
// A Watch Streak is an IRC USERNOTICE. tmi.js@1.8.5 has no named case for it,
// so it falls to the catch-all at lib/client.js:783:
//
//     // All other msgid events should be emitted under a usernotice event
//     default:
//         this.emit('usernotice', msgid, channel, tags, msg);
//
//   msg-id              viewermilestone
//   msg-param-category  watch-streak
//   msg-param-value     the streak count
//
// [dev.twitch.tv forum, "Watch Streaks via EventSub?", read 15 Aug 2026]
//
// ⛔ NOT AVAILABLE VIA EVENTSUB. There is an open feature request and nothing
// shipped, so the EventSub connection built for hype trains does not serve this.
// IRC is the only path.
//
// ⭐ Max suggested keying off the visible text "Watch Streak reached". That
// works, but these tags are strictly better: no dependency on Twitch's wording,
// and nothing a viewer could type. The `system-msg` text is used for NOTHING
// here — identity and count both come from tags.
//
// ⚠ THE RESEARCH IS THE POINT OF THIS FILE'S HISTORY. I was about to ship a
// logging deploy to discover these three strings, and a search answered it in
// seconds. "Read the executing artifact" is right for OUR systems; for a
// third-party protocol constant the documentation IS the primary source.
//
// ---------------------------------------------------------------------------
// ⛔ NO TIER NUMBERS ANYWHERE, and that is load-bearing.
//
// Twitch does not publish which streak counts trigger a milestone. I guessed
// "3, 10, 25, 50, 100", then found the same list in community sources and
// repeated it with more confidence than it earned. Max — who watches these fire
// — says there are tiers between 3 and 10, and his own streak on another
// channel is 240, well past where every published list stops.
//
// ⇒ So the prompt says only that these occur at Twitch's own milestones, which
// is true whatever the sequence is. It also must never say how far to the next
// tier: with an unknown list that would be a guess stated as fact.
//
// ---------------------------------------------------------------------------
// FIRING: every published streak, no floor, no batching, no cooldown.
//
// ⭐ Because the STREAMER publishes these manually — Twitch notifies him and he
// chooses to post — he is already the filter. A small streak he did not want
// acknowledged simply never appears. A floor in code would second-guess a
// decision he has already made by hand.
//
// ⚠ I claimed these bunch at stream start and that batching was needed. Wrong,
// and his own chat disproved it: the 25-streak landed 17 minutes into a stream
// and was the only one all session.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_LENGTH = 399;

// Sentence count by streak length (Max, 15 Aug 2026, exact bands).
// ⚠ These ARE thresholds, unlike everywhere else in this codebase — he asked
// for them explicitly and they govern LENGTH only, never whether it fires.
export function sentencesFor(streak) {
    if (streak >= 200) return 4;
    if (streak >= 100) return 3;
    if (streak >= 25) return 2;
    return 1;
}

export function parseWatchStreak(msgid, tags) {
    if (msgid !== "viewermilestone") return null;
    const t = tags || {};
    if (t["msg-param-category"] !== "watch-streak") return null;

    const streak = Number(t["msg-param-value"]);
    if (!Number.isFinite(streak) || streak <= 0) return null;

    const name = String(t["display-name"] || t.login || t.username || "").trim();
    if (!name) return null;

    return { name, streak };
}

export function createWatchStreak({
    say,
    claudeCall,
    isEnabled = () => true,
    sayChunkedFn,
    maxLength = DEFAULT_MAX_LENGTH,
    log = console.log,
} = {}) {
    if (typeof say !== "function") throw new Error("createWatchStreak requires a `say` function");
    if (typeof claudeCall !== "function") throw new Error("createWatchStreak requires a `claudeCall` function");

    function _buildPrompt({ name, streak }) {
        const n = sentencesFor(streak);
        return [
            `[WATCH STREAK] @${name} has just hit a ${streak}-stream watch streak on the channel. Twitch has already announced it in chat.`,
            `Thank them for it, addressing them as @${name}. EXACTLY ${n} SENTENCE${n === 1 ? "" : "S"}.`,
            // ⛔ A described range, not switching logic. Claude scales continuously
            // instead of stepping at a boundary, and there is no number here that
            // anyone has to justify or maintain.
            `Scale your enthusiasm to the number: watch streaks run from a handful up to several hundred on long-established channels. Under 25 is ordinary — warm, but brief. 25 is genuinely impressive without being rare. The further above that, the more remarkable, and a three-figure streak is exceptional.`,
            // ⛔ Unlike the follow and cheer paths, restating the count is ALLOWED:
            // there the number is the headline and repeating it is pure echo, but
            // here the number IS the substance of what is being thanked.
            `You may mention the number — it is the substance here, not just the headline.`,
            `⛔ Do NOT say how many more streams until the next milestone. Twitch does not publish which counts are milestones and any such claim would be invented.`,
            `⛔ You know NOTHING about ${name} beyond this streak. Do not invent facts about them, what they watch, or how long they have been around beyond what the number implies. No links.`,
            `Use FRESH wording every time — a different opening and different imagery from how you've thanked people earlier in this chat. Stay in the channel's cosmic/synth/Mindverse register.`,
        ].join("\n");
    }

    // Wire to tmi.js's 'usernotice' catch-all: (msgid, channel, tags, msg).
    async function onUsernotice(msgid, channel, tags) {
        const parsed = parseWatchStreak(msgid, tags);
        if (!parsed) return false;
        if (!isEnabled()) return false;

        try {
            const response = await claudeCall(_buildPrompt(parsed));
            if (response && String(response).trim()) {
                sayChunkedFn(say, channel, String(response).trim(), maxLength);
            }
        } catch (err) {
            log("[mind_b0t] watch-streak error:", err && err.message ? err.message : err);
        }
        return true;
    }

    return { onUsernotice, parseWatchStreak, sentencesFor, _buildPrompt };
}

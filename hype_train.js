// hype_train.js
//
// "Can mind_b0t detect that a Hype Train started, and say a few sentences about
// it?" — Max, 14 Aug 2026. Then: "the Hype Train comment can be 2-3 sentences
// right away, in time before the gift subs thank you".
//
// ---------------------------------------------------------------------------
// ⛔ THE TIMING REQUIREMENT IS THE DESIGN CONSTRAINT, and it is already met by
// doing nothing clever.
//
// sub_thanks.js batches subs and gift subs behind a 15-SECOND flush window —
// deliberately, so a 20-sub gift produces one thank-you instead of twenty. A
// hype train fires on the sub that STARTS it, so:
//
//     t=0s   hype train begins, subs land        -> this message posts now
//     t=15s  sub_thanks flushes its batch        -> the thank-you follows
//
// ⇒ The ordering Max asked for falls out of the existing batch window. This path
// deliberately has NO queue, NO batching and NO delay. ⛔ Do not add one: a
// 15-second-batched hype message would land simultaneously with the sub thanks,
// which is the one arrangement he ruled out.
//
// ---------------------------------------------------------------------------
// ⛔ ONE MESSAGE PER TRAIN. channel.hype_train.begin fires once per train, but
// a reconnect can redeliver a notification — EventSub guarantees at-least-once,
// not exactly-once. Twitch's own advice is to dedupe on metadata.message_id;
// this dedupes on the EVENT id too, which additionally survives the same train
// arriving down a fresh session after a drop.
//
// ⚠ NOT gated by the shared cooldowns. A hype train is a rare, real event
// nobody can spam — same reasoning as the raid welcome, which is also ungated.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_LENGTH = 399;
// Remember enough train ids to cover a reconnect storm, not the whole stream.
const SEEN_LIMIT = 20;

// ⛔ Written defensively: the v2 payload is read field-by-field and EVERY field
// is optional. I could not retrieve the complete v2 field list from Twitch's
// docs (the reference page truncates before the hype train payload), so an
// unexpected shape degrades to a shorter message instead of throwing. Level is
// the one field confirmed present in v2.
export function describeTrain(event) {
    const e = event || {};
    const facts = [];

    const level = Number(e.level);
    if (Number.isFinite(level) && level > 0) facts.push(`It is at level ${level}`);

    const total = Number(e.total);
    if (Number.isFinite(total) && total > 0) facts.push(`${total} points contributed so far`);

    const goal = Number(e.goal);
    const progress = Number(e.progress);
    if (Number.isFinite(goal) && goal > 0 && Number.isFinite(progress)) {
        facts.push(`${progress} of ${goal} toward the next level`);
    }

    const contributors = Array.isArray(e.top_contributions)
        ? e.top_contributions.map((c) => c && (c.user_name || c.user_login)).filter(Boolean)
        : [];

    return { facts, contributors, level: Number.isFinite(level) ? level : null };
}

export function createHypeTrain({
    say,
    // ⛔ Explicit, because an EventSub notification does NOT arrive on a chat
    // connection and carries no channel to reply into — unlike every other
    // handler here, which is handed the channel by tmi.js. The caller knows
    // which channel it subscribed for; it has to say so.
    channel,
    claudeCall,
    isEnabled = () => true,
    sayChunkedFn,
    maxLength = DEFAULT_MAX_LENGTH,
    log = console.log,
} = {}) {
    if (typeof say !== "function") throw new Error("createHypeTrain requires a `say` function");
    if (typeof claudeCall !== "function") throw new Error("createHypeTrain requires a `claudeCall` function");
    if (!channel) throw new Error("createHypeTrain requires a `channel` — EventSub notifications carry none");

    const _seen = [];

    function _alreadyHandled(id) {
        if (!id) return false;             // no id to dedupe on — let it through
        if (_seen.includes(id)) return true;
        _seen.push(id);
        if (_seen.length > SEEN_LIMIT) _seen.shift();
        return false;
    }

    function _buildPrompt(event) {
        const { facts, contributors } = describeTrain(event);
        const lines = ["[HYPE TRAIN] A Hype Train has just started on the channel."];

        if (facts.length) lines.push(`[${facts.join(". ")}.]`);
        if (contributors.length) {
            lines.push(`[Top contributors so far: ${contributors.slice(0, 3).join(", ")}]`);
        }

        lines.push(
            `React to it with real excitement, in the channel's cosmic/synth/Mindverse voice. ` +
            `TWO OR THREE SENTENCES. Rally the chat to pile on and keep it going.`
        );
        // ⛔ Same guard as every other generated path here: the numbers above are
        // the only facts available. Everything else would be invention, and this
        // one posts mid-hype-train when chat is moving fast and nobody is reading
        // carefully — which is exactly when a made-up claim slips past.
        lines.push(
            `⛔ Use ONLY the details above. Do not invent numbers, names, or how long it has been running, ` +
            `and do not claim anything about who contributed beyond what is listed. If little detail is given, ` +
            `be enthusiastic without being specific.`
        );
        return lines.join("\n");
    }

    // (type, event) from EventSub. Returns true if it acted.
    async function onNotification(type, event) {
        if (type !== "channel.hype_train.begin") return false;
        if (!isEnabled()) return false;
        if (_alreadyHandled(event && event.id)) {
            log("[mind_b0t] hype train already announced, ignoring redelivery");
            return false;
        }

        try {
            const response = await claudeCall(_buildPrompt(event));
            if (response && String(response).trim()) {
                sayChunkedFn(say, channel, String(response).trim(), maxLength);
            }
        } catch (err) {
            log("[mind_b0t] hype-train error:", err && err.message ? err.message : err);
        }
        return true;
    }

    return { onNotification, describeTrain, _buildPrompt };
}

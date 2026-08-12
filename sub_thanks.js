// sub_thanks.js
//
// Sub + gift-sub thank-yous (11 Aug 2026 work order: "Mind_B0t — Sub +
// gift-sub thanks"). Same wiring shape as the raid auto-shoutout
// (twitch_profile.js / bot.onRaided in index.js), but this is a THANK-YOU,
// not a shoutout:
//
//   ⛔ NO twitch_profile.js call, no fetch of any kind on this path
//      (Max, 11 Aug 2026: "just thank them, no lookups for added info,
//      it's not a shoutout").
//   ⛔ SHORT — one or two lines. The 600-800 char shoutout rule does NOT
//      apply here; every prompt built below says so explicitly.
//
// ---------------------------------------------------------------------------
// WO §6 (corrected 11 Aug 2026, after an earlier draft got this backwards):
// a SEPARATE announcer (not this codebase — StreamElements or a Twitch
// alert) already posts "X just subscribed" to chat. This bot is not that
// announcer and nothing needs to be turned off. What this build replaces is
// Max typing "Thanks for the sub!" by hand. Two consequences, both load-
// bearing in _buildPrompt below:
//
//   1. Don't restate the announcement. The who/what is already on screen —
//      the fact lines fed to Claude are CONTEXT, and every prompt tells
//      Claude explicitly not to echo them back as news. The bot's only job
//      is the thanks itself.
//   2. Vary the wording every time, and ask for that EXPLICITLY in the
//      prompt (Max: "maybe a different variation on that each time?"). A
//      fixed system prompt + a near-identical user prompt converges on one
//      house phrasing on its own — that convergence is exactly what would
//      make this no better than the static announcer it's replacing, so the
//      instruction is spelled out rather than assumed.
//   3. Thank people for SUPPORTING THE CHANNEL, not just "for the sub" —
//      Max's framing; it reads warmer and covers resubs/gifts/Prime too.
// ---------------------------------------------------------------------------
//
// This module is pure logic + injected side effects (say/claudeCall/log/
// clock/timer), so it can be unit-tested with synthetic tmi.js-shaped
// events and no live credentials, no network, and no real 15s waits.
//
// ---------------------------------------------------------------------------
// THE TRAP (WO §2/§3/§4) — a single 20-sub gift fires ONE 'submysterygift'
// and then TWENTY 'subgift' events, one per recipient. Thanking naively on
// every 'subgift' means twenty thank-yous for one act, in a burst, mid-hype-
// train. Two independent guards, BOTH required:
//
//   1. TAG CHECK (primary, per WO §3): a 'subgift' carrying
//      tags['msg-param-community-gift-id'] is part of a bulk gift that was
//      already thanked via its 'submysterygift' -> suppress, unconditionally.
//      Verified in tmi.js source (parser.js assigns every raw IRC tag into
//      message.tags with no whitelist, and the 'subgift' case in client.js
//      passes that whole tags object through as its last argument) that the
//      tag WOULD reach us if Twitch sends it. NOT verified: whether Twitch's
//      wire format actually populates it on a real bulk gift in Max's
//      channel — that's a claim about Twitch, not about this code.
//
//   2. TIMING GUARD (fallback, per WO §4): a 'subgift' arriving within
//      ~10s of a 'submysterygift' from the SAME gifter is treated as part
//      of that bulk and suppressed too, whether or not the tag is present.
//      This is what makes the feature degrade to Max's stated fallback
//      ("I'd rather miss single givers than thank all the receivers, if it
//      can't be distinguished") automatically if the tag never shows up in
//      production, instead of flooding chat.
//
// Both guards are OR'd: suppress if EITHER fires. Tag presence/absence is
// logged once per correlated bulk gift (WO §4's "log the tag's presence or
// absence once per bulk gift so the next session knows whether the primary
// discriminator actually works in production") — never tag *contents*
// beyond that boolean.
//
// ---------------------------------------------------------------------------
// ⚠ JUDGMENT CALL, FLAGGED FOR REVIEW (not silently decided): WO §3's rule
// table only spells out tag-based suppression for the NAMED 'subgift' row;
// the anon row ("anonsubmysterygift / anonsubgift -> thank 'an anonymous
// gifter'") doesn't mention suppression at all. But WO §2's "THE TRAP" is a
// property of tmi.js/Twitch's mystery-gift fan-out in general, and Twitch's
// anonymous bulk gifts fan out into 'anonsubmysterygift' + N x 'anonsubgift'
// the same way named ones fan out into 'submysterygift' + N x 'subgift'.
// Leaving anon gifts unsuppressed would reproduce the exact flood this
// feature exists to prevent, just for anonymous gifters. This module
// applies the SAME tag-check + timing-guard pattern to the anon pair,
// keyed on a single shared "last anon mystery gift" slot (there's no
// gifter username to correlate on for an anonymous gift). Flag this to the
// lead — it is an extension beyond the letter of §3's table, made because
// the alternative is a known flood bug, not because the WO said to.
// ---------------------------------------------------------------------------
//
// THROTTLING (WO §5) — subs are frequent, unlike raids, so (unlike
// bot.onRaided) this path is rate-limited: at most one thank-you message
// per `intervalMs` (~15s). Events arriving faster than that are queued and
// merged into ONE batched message naming everyone, never dropped, never
// more than one message per interval. Deliberately NOT `_cooldownActive()`
// (WO §5: that gate is shared by the @-mention chatter path and mixing them
// would let chat traffic suppress a sub thank-you or the reverse) — this
// module owns its own independent queue/timer state.

const DEFAULT_INTERVAL_MS = 15000;
const DEFAULT_BULK_WINDOW_MS = 10000;
const DEFAULT_MAX_LENGTH = 399;

export function createSubThanks({
    say,                                  // (channel, message) => void
    claudeCall,                           // (promptText) => Promise<string>
    isEnabled = () => true,               // () => boolean — kill switch (_botEnabled)
    intervalMs = DEFAULT_INTERVAL_MS,
    bulkWindowMs = DEFAULT_BULK_WINDOW_MS,
    maxLength = DEFAULT_MAX_LENGTH,
    log = console.log,
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
} = {}) {
    if (typeof say !== "function") throw new Error("createSubThanks requires a `say` function");
    if (typeof claudeCall !== "function") throw new Error("createSubThanks requires a `claudeCall` function");

    // --- bulk-gift correlation state -------------------------------------
    // gifterUsername -> { ts, tagLogged }
    const _recentMysteryGifts = new Map();
    // anonymous mystery gifts have no username to key on — one shared slot.
    let _recentAnonMysteryGift = null; // { ts, tagLogged } | null

    // --- throttle/batch state ----------------------------------------------
    let _queue = [];           // [{ factLine, channel }]
    let _timer = null;
    let _lastFlushAt = -Infinity;
    let _pendingFlushPromise = null; // set in tests to await the in-flight flush

    function _hasTag(tags) {
        return !!(tags && tags["msg-param-community-gift-id"]);
    }

    function _logTagOnce(record, hasTag, label) {
        if (record && !record.tagLogged) {
            log(`[mind_b0t] bulk gift (${label}): community-gift-id tag ${hasTag ? "present" : "ABSENT"} on the fan-out subgift event`);
            record.tagLogged = true;
        }
    }

    function _enqueue(factLine, channel) {
        _queue.push({ factLine, channel });
        _scheduleFlush();
    }

    function _scheduleFlush() {
        if (_timer) return; // a flush is already scheduled — new events join the same batch
        const elapsed = now() - _lastFlushAt;
        const wait = Math.max(0, intervalMs - elapsed);
        _timer = setTimeoutFn(() => {
            _timer = null;
            _pendingFlushPromise = _flush().catch((err) => {
                log("[mind_b0t] sub-thanks flush error:", err && err.message ? err.message : err);
            });
        }, wait);
    }

    function _buildPrompt(factLines) {
        // WO §6 (corrected 11 Aug 2026): a separate announcer already posts
        // "X just subscribed" to chat — this bot is not that announcer, it
        // replaces Max typing "Thanks for the sub!" by hand. So the fact
        // lines below are CONTEXT for Claude (who, what kind of support, how
        // many), not text to be echoed back as a re-announcement — the
        // instruction explicitly tells Claude the news part is already on
        // screen and its only job is the thanks itself.
        const lines = factLines.length === 1
            ? [`[Already announced in chat — do not restate as news: ${factLines[0]}.]`]
            : [`[Already announced in chat — do not restate as news:`, ...factLines.map((f) => `- ${f}.`)];

        const instruction = factLines.length === 1
            ? "Your only job is to thank them for SUPPORTING THE CHANNEL — not just \"for the sub\", so the same phrasing works for a resub, a gift, or Prime too. ONE OR TWO LINES ONLY. Use FRESH wording every time — a different opening and phrasing than a typical stock \"thanks for the sub!\" line, and different from how you've thanked people earlier in this chat. This is a quick thank-you, not a shoutout: no biographical facts, no lookups, nothing beyond a short, warm thanks."
            : "Your only job is to thank them all together for SUPPORTING THE CHANNEL — not just \"for the sub\", so the same phrasing works for resubs, gifts, and Prime too — naming everyone briefly, in ONE short message. ONE OR TWO LINES TOTAL. Use FRESH wording every time — a different opening and phrasing than a typical stock line, and different from how you've thanked people earlier in this chat. This is a quick thank-you, not a shoutout: no biographical facts, no lookups.";

        lines.push(instruction);
        return lines.join("\n");
    }

    function _sayChunked(channel, text) {
        if (text.length > maxLength) {
            const parts = text.match(new RegExp(`.{1,${maxLength}}`, "g"));
            parts.forEach((part, index) => {
                setTimeoutFn(() => say(channel, part), 1000 * index);
            });
        } else {
            say(channel, text);
        }
    }

    async function _flush() {
        if (_queue.length === 0) return;
        const batch = _queue;
        _queue = [];
        _lastFlushAt = now();

        // Group by channel — normally all one channel, but don't assume it.
        const byChannel = new Map();
        for (const item of batch) {
            if (!byChannel.has(item.channel)) byChannel.set(item.channel, []);
            byChannel.get(item.channel).push(item.factLine);
        }

        for (const [channel, factLines] of byChannel) {
            const prompt = _buildPrompt(factLines);
            const response = await claudeCall(prompt);
            _sayChunked(channel, response);
        }
    }

    // --- event handlers ------------------------------------------------
    // Signatures verified against tmi.js@1.8.5 source (lib/client.js), not
    // docs — see the work order §2 and this repo's raid handler for the
    // same verification approach.

    function onSubscription(channel, username, methods, message, tags) {
        if (!isEnabled()) return;
        _enqueue(`${username} just subscribed`, channel);
    }

    function onResub(channel, username, streakMonths, message, tags, methods) {
        if (!isEnabled()) return;
        const months = Number(streakMonths) || 0;
        const streakPart = months > 0 ? ` for ${months} months in a row` : "";
        _enqueue(`${username} just resubscribed${streakPart}`, channel);
    }

    function onSubmysterygift(channel, username, giftSubCount, methods, tags) {
        if (!isEnabled()) return;
        // Record BEFORE the fan-out subgifts arrive — Twitch always sends the
        // mystery-gift event before its per-recipient subgift events.
        _recentMysteryGifts.set(username, { ts: now(), tagLogged: false });
        _enqueue(`${username} just gifted ${giftSubCount} subs to the channel`, channel);
    }

    function onSubgift(channel, username, streakMonths, recipient, methods, tags) {
        if (!isEnabled()) return;

        const hasTag = _hasTag(tags);
        const record = _recentMysteryGifts.get(username);
        const withinWindow = !!record && (now() - record.ts) < bulkWindowMs;

        if (record) _logTagOnce(record, hasTag, username);

        if (hasTag || withinWindow) return; // suppressed: part of a bulk already thanked

        // Standalone gift — a genuine single gift sub.
        _enqueue(`${username} just gifted a sub to ${recipient}`, channel);
    }

    function onAnonSubmysterygift(channel, giftSubCount, methods, tags) {
        if (!isEnabled()) return;
        _recentAnonMysteryGift = { ts: now(), tagLogged: false };
        _enqueue(`an anonymous gifter just gave ${giftSubCount} subs to the channel`, channel);
    }

    function onAnonSubgift(channel, streakMonths, recipient, methods, tags) {
        if (!isEnabled()) return;

        const hasTag = _hasTag(tags);
        const record = _recentAnonMysteryGift;
        const withinWindow = !!record && (now() - record.ts) < bulkWindowMs;

        if (record) _logTagOnce(record, hasTag, "anonymous");

        if (hasTag || withinWindow) return; // suppressed: part of a bulk already thanked

        _enqueue(`an anonymous gifter just gifted a sub`, channel);
    }

    return {
        onSubscription,
        onResub,
        onSubgift,
        onSubmysterygift,
        onAnonSubgift,
        onAnonSubmysterygift,
        // test/inspection hooks — not used by index.js
        _debug: {
            get queueLength() { return _queue.length; },
            get lastFlushAt() { return _lastFlushAt; },
            get pendingFlushPromise() { return _pendingFlushPromise; },
            flushNow: () => _flush(),
        },
    };
}

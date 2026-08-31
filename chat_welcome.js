// chat_welcome.js
//
// Welcomes each viewer on their FIRST message of the stream (Max, 15 Aug 2026:
// "I want Mind_B0t to welcome them").
//
// ---------------------------------------------------------------------------
// ⛔ TWITCH HAS NO PER-STREAM MARKER, so this tracks it.
//
// Two tags exist and neither means what is needed [dev.twitch.tv/docs/irc/tags]:
//
//     first-msg=1          "First Time Chat" — first message on the CHANNEL, ever
//     returning-chatter=1  a new viewer who has chatted twice in 30 days
//
// Neither resets per stream, because chat tags have no notion of "this stream".
// So the module keeps a Set of names seen and clears it when a new stream
// starts — signalled from outside via reset(), wired to EventSub stream.online.
//
// ⚠ IN MEMORY, NOT PERSISTED, and that is Max's call: "we will factor that in as
// to whether to do them" — i.e. do not redeploy mid-stream. An UNPLANNED restart
// still re-welcomes everyone; the failure is cosmetic and accepted rather than
// engineered around.
//
// ---------------------------------------------------------------------------
// WHY THE 5-SECOND DELAY, which is not a cooldown.
//
// If someone's first message is a command, Max wants the command answered first
// and the welcome after — "give the welcome a default 5 second delay so it fires
// after the command, with the brief pause in between".
//
// ⭐ A delay rather than awaiting the command: awaiting would block !song behind
// a Claude call, which is the arrangement he rejected. The cost is that ordering
// is by LIKELIHOOD, not guarantee — a slow !kosmische can still lose the race,
// and no fixed delay can prevent that.
//
// ⚠ It applies to every welcome, not only ones following a command. That is
// fine and arguably better: a beat reads like noticing someone rather than an
// instant reflex.
//
// ---------------------------------------------------------------------------
// TWO LENGTHS, from first-msg:
//
//     first-msg=1   never spoken here    2 sentences — there is something to say
//     otherwise     a regular arriving   1 sentence
//
// ⭐ ONE SENTENCE FOR REGULARS IS LOAD-BEARING. At 20-40 welcomes across a
// stream, anything longer turns the channel into bot. Max greets people himself
// today and finds it "a huge pain in the ass" — this replaces that, so it has to
// feel like a greeting, not an announcement.
//
// Everyone is on the same footing: mods, regulars and strangers alike (his call).
// ---------------------------------------------------------------------------

const DEFAULT_MAX_LENGTH = 399;
const DEFAULT_DELAY_SEC = 5;

// ⛔ Accounts that post but are not viewers. Mind_B0t itself is already excluded
// upstream by tmi.js's `self` flag, but is listed anyway — that flag only covers
// the account this process is logged in as, and a second bot instance or an
// alias account would not be caught by it.
const DEFAULT_EXCLUDED = [
    "streamelements", "sery_bot", "streamdjbot", "mind_b0t", "mind_bot2",
    "philo_b0t",
    "nightbot", "moobot", "streamlabs",
];

export function createChatWelcome({
    say,
    claudeCall,
    isEnabled = () => true,
    broadcaster = "",                  // excluded — Max does not welcome himself
    excluded = DEFAULT_EXCLUDED,
    delaySec = DEFAULT_DELAY_SEC,
    sayChunkedFn,
    maxLength = DEFAULT_MAX_LENGTH,
    log = console.log,
    setTimeoutFn = setTimeout,
} = {}) {
    if (typeof say !== "function") throw new Error("createChatWelcome requires a `say` function");
    if (typeof claudeCall !== "function") throw new Error("createChatWelcome requires a `claudeCall` function");

    const _excluded = new Set(
        [...excluded, broadcaster].filter(Boolean).map((n) => String(n).toLowerCase().replace(/^[@#]/, ""))
    );
    let _seen = new Set();

    // Called on EventSub stream.online. ⛔ Without this the set grows forever and
    // nobody is ever welcomed twice — which looks identical to the feature being
    // broken, since the symptom is silence.
    function reset(reason = "stream.online") {
        const had = _seen.size;
        _seen = new Set();
        log(`[mind_b0t] chat-welcome reset (${reason}) — cleared ${had} seen`);
    }

    function _buildPrompt(name, isFirstEver) {
        const lines = [
            isFirstEver
                ? `[FIRST-TIME CHATTER] @${name} has just sent their VERY FIRST message in this channel.`
                : `[ARRIVING] @${name} has just sent their first message of tonight's stream. They have been here before.`,
            isFirstEver
                ? `Welcome them and give them a sense of what they have walked into — a DJ stream playing Kosmische, Berlin School and Trance. EXACTLY 2 SENTENCES.`
                : `Welcome them back. EXACTLY 1 SENTENCE.`,
            `Address them as @${name}.`,
            // ⛔ Same guard as every other generated path here — a name is all
            // there is to go on, and at 20-40 of these a stream any invented
            // detail is repeated invention.
            `⛔ You know NOTHING about ${name}. Do not invent facts about them, what they listen to, how long they have been around, or anything about their channel. No links.`,
            `Use FRESH wording every time — a different opening and different imagery from how you've welcomed people earlier in this chat. Stay in the channel's cosmic/synth/Mindverse register.`,
        ];
        return lines.join("\n");
    }

    // Call from bot.onMessage. Returns:
    //   false  not a first message (or excluded) — nothing scheduled
    //   true   a welcome has been SCHEDULED (not yet posted — see the delay)
    //
    // ⛔ Does NOT consume the message. The caller must carry on to command
    // handling: Max wants the command answered too, just first.
    function onMessage(channel, user, message) {
        if (!isEnabled()) return false;

        const login = String((user && (user.username || user["display-name"])) || "").toLowerCase();
        if (!login || _excluded.has(login)) return false;
        if (_seen.has(login)) return false;

        // ⛔ Marked BEFORE the async work. Two messages in the same second would
        // otherwise both pass the check and produce two welcomes.
        _seen.add(login);

        const name = String((user && user["display-name"]) || login);
        const isFirstEver = !!(user && (user["first-msg"] === "1" || user["first-msg"] === true));

        setTimeoutFn(async () => {
            try {
                const response = await claudeCall(_buildPrompt(name, isFirstEver));
                if (response && String(response).trim()) {
                    sayChunkedFn(say, channel, String(response).trim(), maxLength);
                }
            } catch (err) {
                log("[mind_b0t] chat-welcome error:", err && err.message ? err.message : err);
            }
        }, Math.max(0, Number(delaySec) || 0) * 1000);

        return true;
    }

    return {
        onMessage, reset, _buildPrompt,
        get seenCount() { return _seen.size; },
        get excluded() { return _excluded; },
    };
}

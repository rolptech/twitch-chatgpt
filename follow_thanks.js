// follow_thanks.js
//
// Varied welcomes for new followers (Max, 14 Aug 2026).
//
// Started as one short line at his request, widened the same morning after he
// saw it live: "lets make it a bit fancier than that, 2-3 sentences with some
// enthusiasm and creativity". Still NOT a shoutout — see _buildPrompt for the
// line that matters, which is that creativity here means imagery and voice,
// never invented facts about someone we know nothing about.
//
// Same module shape as sub_thanks.js: pure logic + injected side effects
// (say/claudeCall/log), so it unit-tests with synthetic tmi.js-shaped input,
// no live credentials and no network.
//
// ---------------------------------------------------------------------------
// WHY THIS READS CHAT INSTEAD OF LISTENING FOR A FOLLOW EVENT
//
// Follows are NOT an IRC event and never have been. tmi.js gives us raids, subs
// and gift subs because those arrive as IRC USERNOTICE, and cheers because they
// arrive as a PRIVMSG carrying a `bits` tag; a follow arrives on NEITHER path,
// and nowhere else on IRC. The real event needs EventSub (channel.follow, scope
// moderator:read:followers) — a second connection this bot does not have.
//
// ⚠ That USERNOTICE/PRIVMSG split was stated wrongly here when this file was
// merged — cheers were lumped in with the sub family. Corrected 14 Aug 2026
// against tmi.js@1.8.5 lib/client.js:1089. The conclusion never depended on it
// (a follow is on no IRC path at all), but the stated mechanism was wrong, and
// the next person to build an event handler would have read it as authoritative.
//
// StreamElements already announces follows in chat, so this watches for that
// announcement instead. Cheaper than EventSub and uses machinery already here.
//
// ⛔ THE TRADEOFF, STATED HONESTLY: this is pattern-matching a third party's
// output. If StreamElements changes its chat-alert format the trigger stops
// firing, and NOTHING ERRORS — a regex that doesn't match is silent. That is
// acceptable HERE and only here: Max reads his own chat live and would see the
// follow alert land with no reply after it. Do not copy this pattern to
// anything unattended, where the same silence is invisible.
//
// ---------------------------------------------------------------------------
// ⛔⛔ THE ANNOUNCER CHECK IS A SECURITY BOUNDARY, NOT A TIDINESS RULE.
//
// The trigger is a plain chat string. Any viewer can type "Thank you for
// following Someone" and, without this check, make the bot address a person
// who never followed — or burn a Claude call on demand, repeatedly.
//
// So the sender is verified against FOLLOW_ANNOUNCER before the text is even
// examined. Default "streamelements". It is an env var because the announcing
// account is a thing Max changes: until 14 Aug 2026 StreamElements was
// connected to the mind_bot2 (Mind_B0t) account and posted AS the bot, which
// is exactly why this feature could not exist before — index.js drops its own
// messages with `if (self) return;`, so the bot could not see the follow line.
// He disconnected it that morning, which is what made this possible.
//
// ---------------------------------------------------------------------------
// THE OBSERVED MESSAGE (captured live from Max's chat, 14 Aug 2026 06:44 PT):
//
//     Thank you for following VladdyPoe AstroRowboat
//
// "VladdyPoe" is the follower; "AstroRowboat" is a channel emote in the alert
// template. So: the follower is the FIRST token after "following", and
// anything after it is decoration. Matched case-insensitively, and leading
// punctuation/@ is tolerated because the template is Max's to edit.
//
// ⛔ NO RATE LIMIT AND NO COOLDOWN — Max, 14 Aug 2026, explicitly, twice.
// Ten follows means ten replies. That is the instruction, not an oversight,
// and it is deliberately NOT wired to _cooldownActive in index.js the way the
// !song and trigger paths are. If that ever needs revisiting it is his call.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_LENGTH = 399;
const DEFAULT_ANNOUNCER = "streamelements";

// First token after "following" is the follower. Everything after is emotes.
// Tolerates a leading @ and trailing punctuation on the name.
const FOLLOW_RE = /^\s*thank you for following\s+@?([A-Za-z0-9_]{3,25})\b/i;

export function extractFollower(message) {
    if (typeof message !== "string") return null;
    const m = message.match(FOLLOW_RE);
    return m ? m[1] : null;
}

export function createFollowThanks({
    say,                                  // (channel, message) => void
    claudeCall,                           // (promptText) => Promise<string>
    isEnabled = () => true,               // () => boolean — kill switch (_botEnabled)
    announcer = DEFAULT_ANNOUNCER,        // the account whose follow lines we trust
    maxLength = DEFAULT_MAX_LENGTH,
    log = console.log,
    setTimeoutFn = setTimeout,
} = {}) {
    if (typeof say !== "function") throw new Error("createFollowThanks requires a `say` function");
    if (typeof claudeCall !== "function") throw new Error("createFollowThanks requires a `claudeCall` function");

    const _announcer = String(announcer || DEFAULT_ANNOUNCER).toLowerCase().replace(/^@/, "");

    function _buildPrompt(follower) {
        // Same reasoning as sub_thanks._buildPrompt: a separate announcer has
        // ALREADY posted the news line. Restating "X just followed!" would make
        // the bot a second announcer rather than a welcome, so the fact is
        // given as context and Claude is told not to echo it.
        //
        // The "fresh wording" instruction is spelled out rather than assumed —
        // a fixed system prompt plus a near-identical user prompt converges on
        // one house phrasing by itself, and that convergence is precisely what
        // would make this no better than the static alert it sits next to.
        return [
            `[Already announced in chat — do not restate as news: ${follower} just followed the channel.]`,
            `Welcome ${follower} to the Mindverse with real enthusiasm. TWO OR THREE SENTENCES — room to be creative and vivid, but still a welcome, not a shoutout.`,
            `⛔ You know NOTHING about ${follower} except that they just followed. Do NOT invent facts about them — no claims about their music, their channel, their skills or their history, and no links. The raid-shoutout path can embellish because it fetches a real profile first; this path has only a name. Creativity here means IMAGERY AND VOICE — the cosmic/synth/Mindverse register of the channel — not fiction about a stranger.`,
            `Use FRESH wording every time: a different opening, different imagery, and a different shape from how you've welcomed people earlier in this chat.`,
        ].join("\n");
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

    // Call from index.js's bot.onMessage, BEFORE any command parsing.
    // Returns true if this message was a follow announcement we acted on —
    // callers may use that to skip further handling, but need not.
    async function onMessage(channel, user, message) {
        if (!isEnabled()) return false;

        // ⛔ Sender check FIRST — see the header. Anyone can type the phrase.
        const sender = String((user && (user.username || user["display-name"])) || "").toLowerCase();
        if (sender !== _announcer) return false;

        const follower = extractFollower(message);
        if (!follower) return false;

        try {
            const response = await claudeCall(_buildPrompt(follower));
            if (response && String(response).trim()) _sayChunked(channel, String(response).trim());
        } catch (err) {
            // A failed welcome must never take down the message handler — every
            // other chat message flows through the same onMessage.
            log("[mind_b0t] follow-thanks error:", err && err.message ? err.message : err);
        }
        return true;
    }

    return { onMessage, extractFollower, _buildPrompt, announcer: _announcer };
}

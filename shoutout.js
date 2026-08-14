// shoutout.js
//
// The profile block both shoutout paths share, plus the manual "SO <name>"
// command (Max, 14 Aug 2026: "I want mind_b0t to do the data fetch one when I
// tell it to do an SO").
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
//
// There was never a shoutout COMMAND. "@mb SO @violetdotwav" was an ordinary
// chat message that happened to contain the trigger token, so it went down the
// general trigger path: strip the token, prefix "Message from user ...", hand
// the remainder to Claude under the system prompt "You are a helpful Twitch
// Chatbot." Claude received six words and improvised the rest.
//
// It showed. From Max's chat, 14 Aug 2026, and note that the bot says so itself:
//
//     "Shout out to @violetdotwav! I'm picking up some serious synth energy
//      FROM THAT NAME—you're PROBABLY out there bending waveforms..."
//
// Meanwhile bot.onRaided already fetched the raider's real description, panels
// and last broadcast and built a proper context block. Same output shape, two
// completely different amounts of knowledge behind it.
//
// ⛔ SO THE PROFILE BLOCK IS EXTRACTED HERE AND SHARED, not copied. Copying it
// would have made two homes for the panel-handling instruction — and that
// instruction is load-bearing (see twitch_profile.js: three regex classifiers
// were tried and all shipped gear lists and donation pitches into shoutouts).
// Eight copies of the message splitter had to be fixed this same morning; the
// lesson was still warm.
//
// ---------------------------------------------------------------------------
// ⛔ WHAT HAPPENS WHEN THE FETCH FAILS IS THE WHOLE POINT OF THE FEATURE.
//
// The raid path is deliberately FAIL-OPEN: a raid is real and time-critical, so
// a failed enrichment still produces a welcome from username + viewer count.
//
// A manual SO is NOT that. Its entire reason for existing is the fetched data —
// falling back to a name-only improvisation would silently reproduce exactly the
// behaviour Max asked to replace, and he would have no way to tell which one he
// got. So this path FAILS CLOSED: no profile, no shoutout, and it says why.
//
// ⇒ Same function, opposite fallback, on purpose. Do not "harmonise" these.
// ---------------------------------------------------------------------------

// Matches the whole remaining message after the trigger token is stripped.
//
// ⛔ THE BARE "so" FORM REQUIRES AN @. "so" is an ordinary English word, and
// without that requirement "@mb so good" parsed as a shoutout to a user called
// "good" — caught by a test, not by reading. Anchoring alone is not enough
// because "so <word>" is a complete, common utterance.
//
// "shoutout" and "shout out" are unambiguous, so they take a bare name too.
const SO_RE = /^\s*(?:so\s+@|shoutout\s+@?|shout\s*out\s+@?)([A-Za-z0-9_]{3,25})\s*$/i;

export function parseShoutoutTarget(message) {
    if (typeof message !== "string") return null;
    const m = message.match(SO_RE);
    return m ? m[1] : null;
}

// The shared context block. `profile` may be null; every bracketed field is
// omitted when empty, exactly as the raid path has always done.
export function profileLines(profile, { cleanDescription, extractPanelText, cleanTitle, relativeTimePhrase }) {
    const lines = [];
    if (!profile) return lines;

    const description = cleanDescription(profile.description);
    if (description) lines.push(`[About them: ${description}]`);

    // ⛔ Panel text is deliberately UNFILTERED beyond mechanical cleanup — the
    // instruction below IS the filter and has to travel with the data. Three
    // regex classifiers were tried first and every one of them shipped gear
    // lists and donation pitches into shoutouts. See twitch_profile.js.
    const panelText = extractPanelText(profile.panels);
    if (panelText) {
        lines.push(
            `[Raw text from their channel panels — may include chat rules, gear lists, ` +
            `donation appeals or link labels. Use ONLY what genuinely describes them as ` +
            `a DJ/streamer (genre, aliases, what they play, where they're from). Ignore ` +
            `everything else, and never repeat donation appeals or link names: ${panelText}]`
        );
    }

    if (profile.stream && profile.stream.id) lines.push(`[They are LIVE right now.]`);

    const lastBroadcast = profile.lastBroadcast;
    const title = lastBroadcast ? cleanTitle(lastBroadcast.title) : "";
    if (title) {
        const category = lastBroadcast.game && lastBroadcast.game.name ? ` in ${lastBroadcast.game.name}` : "";
        const when = relativeTimePhrase(lastBroadcast.startedAt);
        lines.push(`[Their last stream: "${title}"${category}${when ? `, ${when}` : ""}]`);
    }
    return lines;
}

export function createShoutout({
    say,
    claudeCall,
    fetchProfile,                       // (login) => Promise<profile|null>
    helpers,                            // { cleanDescription, extractPanelText, cleanTitle, relativeTimePhrase }
    isEnabled = () => true,
    isAllowed = () => true,             // (user) => boolean — mod/broadcaster gate
    cooldownActive = () => false,
    markFired = () => {},
    sayChunkedFn,                       // (say, channel, text, maxLength) => void
    maxLength = 399,
    log = console.log,
} = {}) {
    if (typeof say !== "function") throw new Error("createShoutout requires a `say` function");
    if (typeof claudeCall !== "function") throw new Error("createShoutout requires a `claudeCall` function");
    if (typeof fetchProfile !== "function") throw new Error("createShoutout requires a `fetchProfile` function");

    function _buildPrompt(target, profile) {
        const lines = [`[SHOUTOUT] The streamer has asked you to shout out ${target}.`];
        lines.push(...profileLines(profile, helpers));
        lines.push(
            `Give them a warm, in-character shoutout based ONLY on what is above. ` +
            `⛔ Do NOT guess anything from their username — no inventing what they play, ` +
            `how they sound, or what their channel is like. If the details above are thin, ` +
            `keep it short and warm rather than filling the gap.`
        );
        return lines.join("\n");
    }

    // Call with the message AFTER the trigger token has been stripped.
    // Returns true if this was a shoutout request that has been handled.
    async function onTriggered(channel, user, strippedMessage) {
        const target = parseShoutoutTarget(strippedMessage);
        if (!target) return false;
        if (!isEnabled()) return true;

        // ⛔ MOD/BROADCASTER ONLY (Max, 14 Aug 2026: "can you limit it so only my
        // Mods and I can trigger it?"). A shoutout posts a link to someone's
        // channel in Max's chat, in his bot's voice — unrestricted, any viewer
        // could make it promote anything.
        //
        // ⚠ SILENT on refusal, deliberately. Returning true consumes the message
        // so it does not fall through to the general trigger path and get an
        // improvised answer instead, and saying "you can't do that" would give
        // anyone a way to make the bot talk by typing a command they cannot use.
        if (!isAllowed(user)) return true;

        const username = (user && user.username) || "";
        if (cooldownActive(username)) return true;
        markFired(username);

        let profile = null;
        try {
            profile = await fetchProfile(target);
        } catch (err) {
            log("[mind_b0t] shoutout profile fetch failed:", err && err.message ? err.message : err);
        }

        // ⛔ FAIL CLOSED — see the header. A name-only shoutout is the thing this
        // feature replaces, so producing one on failure would be indistinguishable
        // from the bug and impossible for Max to spot in chat.
        if (!profile) {
            say(channel, `Couldn't pull up ${target}'s channel just now — no shoutout rather than a made-up one.`);
            return true;
        }

        try {
            const response = await claudeCall(_buildPrompt(target, profile));
            if (response && String(response).trim()) {
                sayChunkedFn(say, channel, String(response).trim(), maxLength);
            }
        } catch (err) {
            log("[mind_b0t] shoutout error:", err && err.message ? err.message : err);
        }
        return true;
    }

    return { onTriggered, parseShoutoutTarget, _buildPrompt };
}

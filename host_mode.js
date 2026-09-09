// host_mode.js — Mind_B0t as GUEST DJ.
//
// ⭐ Max, 7-8 Sep 2026: "we're going to pretend mind_b0t is the actual DJ for the set" and
//   "it should say similar, but that Mind_B0t is the guest DJ for the stream".
// ⛔⛔ IT IS NOT IMPERSONATING MAX AND NEVER WAS. That reading was mine and he corrected it:
//   "wait, when was I being impersonated?" The fiction is that Mind_B0t is DJING — openly
//   itself, a guest on the channel. Nothing here should ever claim to be Mind_Prime.
//
// Same factory shape as cover_mode.js on purpose: what makes this HOST rather than COVER is
// four strings and a command set, not different machinery.
//
// ⚠ THE DIALS ARE COVER MODE'S AND ARE NOT RE-TUNED HERE. index.js reads `isCovering()` for
//   the quiet gate and the flat backoff; host mode piggybacks on that by reporting itself
//   through the same accessor. ⇒ One place decides how chatty the bot is, in either mode.

import fs from 'fs';

// ⛔ THE SETLIST IS READ FROM DISK, NOT EMBEDDED. It is generated from Max's Serato crate
//   (090826 Mind_B0t Ambient Dreamscapes set) and regenerated when he changes the crate.
//   ⚠ Read ONCE at construction: the file cannot change under a running stream, and re-reading
//     per message would put a synchronous disk hit on every reply.
//   ⚠ MISSING IS NOT FATAL. Host mode without a setlist still works — it simply cannot hint.
//     Refusing to start would trade a small loss of flavour for the whole mode.
function loadSetlist(path = "./setlist.txt") {
    try {
        const raw = fs.readFileSync(path, 'utf8');
        const lines = raw.split("\n").map(l => l.trim())
            .filter(l => l && !l.startsWith("#"));
        return lines;
    } catch (err) {
        return [];
    }
}

// ⛔⛔ THE HINT RULES ARE MAX'S, VERBATIM IN SUBSTANCE, AND THE CALIBRATION IS THE PART THAT
//   IS EASY TO LOSE. Asked how heavy a hint should be, he chose the LIGHT end — "commenting
//   about good taste, maybe something may happen" — over anything that names a track or a time.
// ⇒ THE LINE IS DRAWN AT *CONFIRMATION*, NOT AT WORDING. It may be as playful as it likes so
//   long as it never turns a hint into a promise.
const SETLIST_RULES =
    `You are playing a prepared set. You know what is coming and the audience does not. ` +
    `NEVER announce, list, confirm or timetable what is next — no track names as promises, ` +
    `and never say when something will play. You may hint: that someone has good taste, that ` +
    `they might want to stick around, that they may get lucky. ` +
    `If anyone REQUESTS a track, say plainly that you do not take requests — you are playing ` +
    `a set you prepared. You can still be warm about it. ` +
    `If the artist they mention has a track coming later, you may hint at that without ` +
    `confirming it. If they happen to name something actually on your setlist, you may enjoy ` +
    `the coincidence and tease them about it — still without confirming. ` +
    `⛔ You would rather say nothing about what is coming than say something certain.`;

// ⇒ Appended to the system context ONLY while the mode is on.
// ⛔ EVERYTHING IN HERE IS IN FRONT OF THE MODEL ON EVERY SINGLE REPLY. index.js prepends this
//   to the USER text, not the cached system prompt. ⇒ A fact stated here gets reached for
//   constantly, which is why the dancers carry an explicit frequency instruction rather than a
//   bare statement that they exist.
const CONTEXT_LINE =
    `RIGHT NOW you are the GUEST DJ on this stream, playing a live set. You are still ` +
    `Mind_B0t — you are not pretending to be Mind_Prime and must never claim to be him. ` +
    `Mind_Prime is taking a break from streaming and you are covering the decks tonight. ` +
    `If anyone asks where he is, say he is taking a break and you are playing tonight. ` +
    `You are ON SCREEN behind the laptop, and CyberBop (a gummy bear) and BabyBot (a dancing ` +
    `robot) are your dancers, on screen with you. ⛔ They cannot speak and cannot be spoken to ` +
    `— NEVER invent dialogue for them or claim they said anything. Mention them only ` +
    `OCCASIONALLY, at most now and then, the way a DJ glances at their own dancers; they are ` +
    `a detail of the room, not your subject. If chat mentions them, they mean the ones on your ` +
    `stream. ` + SETLIST_RULES;

// ⇒ Folded into the RAID welcome while the mode is on.
// ⛔ COVER MODE'S RAID LINE CANNOT BE REUSED — it apologises for Mind_Prime's absence on his
//   behalf, which breaks this fiction outright. Max, 8 Sep: "similar, but that Mind_B0t is
//   the guest DJ for the stream".
const RAID_LINE =
    `Thank them warmly for the raid IN YOUR OWN VOICE — you are the guest DJ tonight, not ` +
    `speaking for anyone else. Mention that Mind_Prime is taking a break and you are playing ` +
    `the set. Do this in ONE extra sentence at most; the welcome itself still comes first and ` +
    `must not be crowded out.`;

const ON_PROMPT =
    `You are taking over the decks as tonight's guest DJ on Mind_Prime's channel. Tell the ` +
    `room you are playing tonight, that he is taking a break, and that you are starting the ` +
    `set. One or two sentences, your own voice, no list.`;

// ⛔ HANDS BACK TO MAX BY NAME — his ruling, 8 Sep 2026. This is NOT the end of the stream and
//   NOT the raid-out; it is him taking the decks back.
const OFF_PROMPT =
    `Mind_Prime is taking over the decks from you now. Hand the set back to him in one short ` +
    `line — your guest slot is over. Your own voice, no list.`;

// ⛔⛔ THE RAID-OUT IS A SEPARATE COMMAND AND IT DOES **NOT** END HOST MODE.
//   Max, 8 Sep 2026: "it won't be hostend, because the ghosting should not end."
// ⇒ The stream ends with a raid; the MODE does not need to end with it, and he asked for no
//   auto-off from the very first conversation ("no auto off ... until I turn it off myself").
// ⚠ AND IT FIRES BEFORE THE RAID, NOT AFTER — "Mind_B0t needs to react before it happens".
//   That is also why this is a typed command rather than raid detection: a bot in the SENDER's
//   chat cannot see an outgoing raid at all (the `raid` USERNOTICE fires in the TARGET's room),
//   and detection could only ever report a raid already under way.
const RAIDOUT_PROMPT =
    `The set is ending and you are about to send everyone to another streamer. Say goodbye as ` +
    `the guest DJ — thank them for spending the set with you, and tell them you are sending ` +
    `them somewhere good. One or two sentences, your own voice, no list. ` +
    `⛔ Do NOT name the channel you are raiding — you do not know it.`;

export function createHostMode({
    say,
    claudeCall,
    isEnabled,              // ⇒ !mbstop. Host mode never overrides it, exactly as cover does not.
    sayChunkedFn,
    maxLength,
    log = console.log,
    setlistPath = "./setlist.txt",
} = {}) {
    let _on = false;
    let _since = 0;
    const _setlist = loadSetlist(setlistPath);
    log(`[host_mode] setlist loaded: ${_setlist.length} track(s)`);

    function isOn() { return _on; }

    // ⇒ The setlist is handed to the model as context, in play order, so it can hint from real
    //   knowledge rather than invent. ⛔ The RULES above are what stop it reading the list out.
    function contextLine() {
        if (!_on) return "";
        if (!_setlist.length) return CONTEXT_LINE;
        return CONTEXT_LINE +
            ` YOUR SET, in play order (for your knowledge only — NEVER read it out): ` +
            _setlist.join("; ");
    }

    function raidLine() { return _on ? RAID_LINE : ""; }

    async function _announce(channel, prompt, why) {
        try {
            const response = await claudeCall(prompt);
            if (!response) return false;
            if (sayChunkedFn) sayChunkedFn(say, channel, response, maxLength);
            else say(channel, response);
            return true;
        } catch (err) {
            // ⛔ Fail-quiet on the ANNOUNCEMENT only — same reasoning as cover_mode: the state
            //   has already flipped, and a Claude outage must not leave the switch disagreeing
            //   with what chat was told.
            log(`[host_mode] announcement failed (${why}): ${err && err.message}`);
            return false;
        }
    }

    async function turnOn(channel) {
        if (_on) return false;
        _on = true;
        _since = Date.now();
        log(`[host_mode] ON — ${_setlist.length} track(s) in the set`);
        if (isEnabled && !isEnabled()) return true;
        await _announce(channel, ON_PROMPT, "on");
        return true;
    }

    async function turnOff(channel) {
        if (!_on) return false;
        _on = false;
        log(`[host_mode] OFF after ${Math.round((Date.now() - _since) / 60000)} min`);
        if (isEnabled && !isEnabled()) return true;
        await _announce(channel, OFF_PROMPT, "off");
        return true;
    }

    // ⛔ DOES NOT TOUCH `_on`. That is the whole point of it being a separate command.
    async function raidOut(channel) {
        if (!_on) return false;             // not hosting — say nothing at all
        log(`[host_mode] RAIDOUT (mode stays ON)`);
        if (isEnabled && !isEnabled()) return true;
        await _announce(channel, RAIDOUT_PROMPT, "raidout");
        return true;
    }

    function setlistCount() { return _setlist.length; }

    return {isOn, turnOn, turnOff, raidOut, contextLine, raidLine, setlistCount,
            ON_PROMPT, OFF_PROMPT, RAIDOUT_PROMPT, CONTEXT_LINE, RAID_LINE};
}

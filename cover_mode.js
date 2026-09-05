// cover_mode.js — Mind_B0t holds the room while Max is away.
//
// Max, 4 Sep 2026: a switchable mode where the bot "becomes more active, responds to more
// chat messages, and explains that it's covering for me while I take a break", started and
// stopped by a chat command "so that I can trigger from anywhere", and — his words —
// "no auto off, so that if necessary I can start an autoplay setlist and have it keep going
// until I turn it off myself".
//
// ⛔⛔ NO TIMER. NOT AN OVERSIGHT — A REQUIREMENT. He may put on a recorded set and walk
//   away for hours. Anything that quietly switches this off would drop the room back to
//   near-silence in the middle of exactly the situation it exists for.
//
// ⚠ IT IS IN-MEMORY, like the !mbstop kill switch. A Render restart or a deploy clears it,
//   so it cannot outlive the process — but it DOES survive the stream ending. If he goes
//   offline with cover mode on and streams again later without restarting, it is still on.
//   ⇒ Max confirmed this directly, 4 Sep 2026: "don't worry about stopping it if the
//     stream ends". ⛔ So the stream ending is NOT a stop condition. Do not add one.
//
// WHAT IT CHANGES — two dials that already exist, nothing new:
//   ⇒ the QUIET gate: normally the bot answers an undirected message only when chat has
//     gone quiet. In cover mode it answers whether or not the room is busy.
//   ⇒ the BACKOFF: normally the cooldown doubles 4 → 8 → 16 → 32 min, because Max asked
//     in August for less unprompted talking. In cover mode it is flat and short.
//   ⇒ the RAID WELCOME: gains one sentence thanking the raider on Max's behalf and
//     apologising that he is not there to greet them himself.
//
// WHAT IT DELIBERATELY DOES NOT CHANGE:
//   ⛔ It does not override !mbstop. Told to shut up, the bot shuts up, cover or no cover.
//   ⛔ It does not make the bot answer other bots. StreamElements and Sery_Bot post on
//     their own; answering them is a machine talking to a machine in an empty room.
//   ⛔ It does not touch the character limit or the shoutout rules.

const DEFAULT_COOLDOWN_SEC = 45;

// ⇒ Said by the bot in its own voice via Claude, not posted as fixed strings — a canned
//   line repeated every break reads as an away message, which is the thing this is
//   supposed to be better than.
const ON_PROMPT =
    `Mind_Prime is stepping away from the decks for a bit and has left you in charge of the chat. ` +
    `Tell everyone he is taking a break, that the music keeps going, and that you are holding ` +
    `the room until he is back. One or two sentences, your own voice, no list.`;

const OFF_PROMPT =
    `Mind_Prime is back at the decks. Hand the chat back to him in one short line — you are ` +
    `standing down from covering. Your own voice, no list.`;

// ⇒ Appended to the system context ONLY while the mode is on, so the bot can answer
//   "where is Max?" truthfully instead of inventing something.
const CONTEXT_LINE =
    `Right now Mind_Prime is away from his stream taking a break, and you are covering the ` +
    `chat for him. The music is still playing. He will be back later. If anyone asks where ` +
    `he is or why he is not talking, tell them he is on a break and you are holding the room. ` +
    `Do not say how long he has been gone or when he will return, because you do not know.`;

// ⇒ Folded into the RAID welcome while the mode is on. Max, 4 Sep 2026: "in this mode it
//   should thank raiders and apologize for my temporary absence".
//   ⛔ A raid is the one arrival that costs the raider something — they brought their room
//     here and the host is not at the decks. Saying so is the difference between a warm
//     welcome and one that reads as nobody being home.
const RAID_LINE =
    `Mind_Prime is away from the decks right now, so thank them warmly for the raid ON HIS ` +
    `BEHALF and apologise that he is not here in person to greet them — he is on a short ` +
    `break and the music is still going. Do this in ONE extra sentence at most; the welcome ` +
    `itself still comes first and must not be crowded out.`;

export function createCoverMode({
    say,
    claudeCall,
    isEnabled,              // ⇒ !mbstop. Cover mode never overrides it.
    sayChunkedFn,
    maxLength,
    log = console.log,
    cooldownSec = DEFAULT_COOLDOWN_SEC,
} = {}) {
    let _on = false;
    let _since = 0;

    function isOn() {
        return _on;
    }

    // ⇒ Read by idle_chatter. Kept as a getter rather than a constructor flag so the mode
    //   can be flipped mid-stream without rebuilding anything.
    function coverCooldownSec() {
        return cooldownSec;
    }

    function contextLine() {
        return _on ? CONTEXT_LINE : "";
    }

    // ⇒ Empty when the mode is off, so the raid prompt reads exactly as it does today and
    //   the normal path is untouched. One call site, one branch.
    function raidLine() {
        return _on ? RAID_LINE : "";
    }

    async function _announce(channel, prompt, why) {
        try {
            const response = await claudeCall(prompt);
            if (!response) return false;
            if (sayChunkedFn) sayChunkedFn(say, channel, response, maxLength);
            else say(channel, response);
            return true;
        } catch (err) {
            // ⛔ Fail-quiet on the ANNOUNCEMENT only. The mode itself has already flipped
            //   by the time this runs — a Claude outage must not leave the switch in a
            //   state that disagrees with what chat was told, so the state change is
            //   committed first and the announcement is best-effort.
            log(`[cover_mode] announcement failed (${why}): ${err && err.message}`);
            return false;
        }
    }

    async function turnOn(channel) {
        if (_on) return false;          // already covering — say nothing, do not re-announce
        _on = true;
        _since = Date.now();
        log(`[cover_mode] ON`);
        if (isEnabled && !isEnabled()) return true;   // muted: flip the state, stay silent
        await _announce(channel, ON_PROMPT, "on");
        return true;
    }

    async function turnOff(channel) {
        if (!_on) return false;
        _on = false;
        log(`[cover_mode] OFF after ${Math.round((Date.now() - _since) / 60000)} min`);
        if (isEnabled && !isEnabled()) return true;
        await _announce(channel, OFF_PROMPT, "off");
        return true;
    }

    return {isOn, turnOn, turnOff, contextLine, raidLine, coverCooldownSec,
            ON_PROMPT, OFF_PROMPT, CONTEXT_LINE, RAID_LINE};
}

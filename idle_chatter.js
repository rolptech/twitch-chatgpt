// idle_chatter.js
//
// Mind_B0t speaks up when chat has gone quiet (Max, 21 Aug 2026: "when my chat has
// not been active I want Mind_B0t to occasionaly say something compeltely on it's
// own, or reply to a new comment made by another chatter when it happens").
//
// ---------------------------------------------------------------------------
// TWO BEHAVIOURS, AND THEY NEED DIFFERENT MACHINERY.
//
// Replying to someone who breaks the silence happens ON a message — the handler is
// already running, so it needs no timer. Speaking with nothing to react to has no
// message to hang off: nothing arrives to prompt the check, so something must tick
// independently and ask "has it been quiet long enough?". Hence start()/stop().
//
// ---------------------------------------------------------------------------
// WHAT COUNTS AS QUIET (Max, 21 Aug 2026): fewer than 4 messages in 2 minutes.
//
// ⛔ HUMANS ONLY. Mind_B0t's own messages do not count, and neither do other bots'.
// His reasoning, and it is not tidiness: StreamElements posts follow announcements
// and Sery_Bot posts wellness reminders, so a channel with nobody in it can still
// carry 4 messages in 2 minutes and read as busy — which would suppress Mind_B0t
// during exactly the stretches it exists to fill.
//
// ⚠ He first proposed "fewer than 2 in the last minute" and widened it when shown
// that one person chatting every 40s would register as quiet — from their side they
// are mid-conversation. The window is the guard against talking over a slow talker.
//
// ---------------------------------------------------------------------------
// THE COOLDOWN, AND WHAT RESTARTS IT (Max, 21 Aug 2026).
//
//     "give mind_b0t a cooldown before any self-initiated/non-triggered comments,
//      with the cooldown restarted after every mind_b0t comment. so if someone asks
//      it a question which it answers, the cooldown engages or restarts for any
//      self-initiated comments"
//
// ⇒ ANY Mind_B0t message restarts it, whatever prompted that message. The bot never
// speaks unprompted within the cooldown of having said anything at all. That is why
// markSpoke() is wired to bot.say itself in index.js rather than called from the two
// paths here — a shoutout, a hype-train line or a !song answer must all reset it,
// and none of them run through this module.
//
// ⛔ REPLIES TO DIRECT MENTIONS ARE NEVER GATED, by this or anything else (Max:
// "Mind_b0t can always reply to direct comments to it, or direct replies to it,
// there shold be no limit for that"). Those never reach this module — index.js
// handles them on the trigger path and only calls maybeReplyTo() when the message
// was NOT directed at the bot.
//
// ---------------------------------------------------------------------------
// LIVE vs OFFLINE — different cooldowns, and offline replies are ungated.
//
//     live      unprompted: 2 min   ·  reply to a non-directed comment: 2 min
//     offline   unprompted: 1 hour  ·  reply to a non-directed comment: IMMEDIATE
//
// ⚠ Max added the offline case deliberately after first saying live-only: "it wopuld
// be funny if it occasionaly commented when i'm not live, but a lot less often, as
// people do occasinalyy pop inmto not live streams". The ungated offline reply is
// the point of it — someone who shows up to a dark channel and says something gets
// answered, rather than ignored because the bot spoke 40 minutes ago.
//
// ⛔ Offline the three music categories are unavailable — there is no track — so the
// pool drops to the other four. Handled in _pickCategory, not by the caller.
//
// ---------------------------------------------------------------------------
// ⚠ IN MEMORY, NOT PERSISTED — the same call Max made for chat_welcome. An unplanned
// restart loses the activity window and the cooldown; the bot then treats the channel
// as quiet until messages arrive. Cosmetic, and accepted rather than engineered
// around (Max, 21 Aug: "stop worrying about the restart case").

const DEFAULT_QUIET_WINDOW_SEC = 120;
const DEFAULT_QUIET_MAX = 4;          // FEWER than this in the window == quiet
// ⛔ THESE TWO ARE DEAD CODE — index.js ALWAYS passes cooldownLiveSec and
// cooldownOfflineSec, so its `??` fallbacks are the values that actually run. They are
// kept in step so a reader of this file is not told a different number than the bot uses.
// ⚠ backoffMaxSec below is NOT passed by index.js, so ITS default here IS live.
const DEFAULT_COOLDOWN_LIVE_SEC = 240;
// ⛔ LIVE ONLY. The live cooldown DOUBLES for each unprompted comment made into a room
// where nobody has spoken — 4, 8, 16 minutes — and stops at this ceiling so the bot
// never goes fully silent while Max is streaming (his call, 21 Aug 2026).
// ⚠ Offline is deliberately EXEMPT and stays flat at TWO hours: that is already a long
// wait, and backing off on top of it would mean multi-hour gaps in a room where the
// whole point is that someone might wander in.
const DEFAULT_BACKOFF_MAX_SEC = 960;
const DEFAULT_COOLDOWN_OFFLINE_SEC = 7200;
const DEFAULT_TICK_SEC = 15;

// Bots whose messages must not count as chat activity. Lowercased, no leading @/#.
// ⛔ NOT an exclusion list for anything else — these are still real chatters to
// every other part of the bot; this list only answers "is the room busy".
export const DEFAULT_BOT_NAMES = [
    "streamelements",
    "nightbot",
    "sery_bot",
    "streamlabs",
    "moobot",
    "fossabot",
    "wizebot",
    "mind_b0t",
];

// ---------------------------------------------------------------------------
// THE SEVEN CATEGORIES (Max, 21 Aug 2026), with his weighting: "weighted, music ones
// more often" — the three music ones take ~60% between them, the other four share
// 40%, hype the most common of those and planet weather the rarest.
//
// ⛔ `needsTrack` is what makes a category unavailable offline, and also protects the
// live case where Serato reports nothing. Do not assume live == a track is playing.
// Tonight's framing, prepended to every prompt that could otherwise guess wrong about
// the genre. Empty when no title is known, so the prompts read normally without it.
function _setting(title) {
    return title ? `[Tonight's stream is titled: "${title}"] ` : "";
}

const CATEGORIES = [
    {
        key: "now_playing",
        weight: 18,
        needsTrack: true,
        prompt: (t, title) =>
            _setting(title) +
            `[Now playing on stream: ${t}] Chat has gone quiet. Say something about this track or artist ` +
            `to the chat, unprompted — your own take, not a track listing. Nobody asked; you are just filling the silence.`,
    },
    {
        key: "track_trivia",
        weight: 14,
        needsTrack: true,
        prompt: (t, title) =>
            _setting(title) +
            `[Now playing on stream: ${t}] Chat has gone quiet. Offer one piece of trivia connected in some way ` +
            `to this track or its artist. Unprompted — nobody asked.`,
    },
    {
        // ⛔⛔ THE TITLE IS LOAD-BEARING HERE, NOT DECORATION. This category asks for a
        // fact about THE GENRE, and without the night's stated genre it can only infer
        // one from the track name — which produced a real error live on 21 Aug 2026:
        // over a Techno/Acid/DARK TRANCE set it reached for the word "trance" and
        // credited the Berlin School and Tangerine Dream, a 1970s sequencer lineage
        // with nothing to do with the music playing.
        // ⇒ Max's title names the genre outright. Anchor on it and say so explicitly,
        // because the failure was a plausible-sounding wrong lineage, not a nonsense one.
        key: "genre_fact",
        weight: 12,
        needsTrack: true,
        prompt: (t, title) =>
            _setting(title) +
            `[Now playing on stream: ${t}] Chat has gone quiet. Offer one fact about the music itself — the genre, ` +
            `its history, how the sound is made, something adjacent to what is playing. ` +
            (title
                ? `⛔ The genre is the one named in tonight's title above. Do NOT reach for a different ` +
                  `genre or lineage because the track name suggests one — stay in the territory Max is actually playing.`
                : `Stay close to what is actually playing rather than a broader guess at the genre.`),
    },
    {
        // ⛔ THE SET, NOT THE RECORD. Max, 21 Aug 2026: "I want comments about the set as
        // awhgole". The stream TITLE is the framing he chose for the night — e.g.
        // "Cyberium (Techno/Acid/Dark Trance) | ..." — which is information Serato does
        // not have. Without it the bot described a dark-trance night as "dark ambient".
        // ⚠ needsTitle, not needsTrack: this one is about the whole set, so it is
        // available whenever a title is known even between tracks.
        key: "set_vibe",
        weight: 16,
        needsTitle: true,
        prompt: (t, title) =>
            `[Tonight's stream is titled: "${title}"]${t ? ` [Now playing: ${t}]` : ""} Chat has gone quiet. ` +
            `Say something about the SET AS A WHOLE — the mood of the night, where the journey has been heading, ` +
            `the genre territory it is in. Not a comment on a single track. Unprompted.`,
    },
    {
        key: "hype",
        weight: 15,
        needsTrack: false,
        prompt: () =>
            `Chat has gone quiet. Post a short hyping comment or question to the room — the kind of thing that ` +
            `invites a reply, like asking whether everyone is having a good time in the mindverse, or that you ` +
            `cannot help dancing to these vibes. Keep it warm and brief.`,
    },
    {
        key: "robot_joke",
        weight: 10,
        needsTrack: false,
        prompt: () => `Chat has gone quiet. Tell the chat a short joke about robots. Unprompted — nobody asked.`,
    },
    {
        key: "twitch_fact",
        weight: 8,
        needsTrack: false,
        prompt: () => `Chat has gone quiet. Offer the chat one random fact about Twitch. Unprompted — nobody asked.`,
    },
    {
        key: "planet_weather",
        weight: 7,
        needsTrack: false,
        prompt: () =>
            `Chat has gone quiet. Deliver a short weather report for somewhere other than Earth — a real planet or ` +
            `moon, or one you invent. Play it straight, like a forecast. Unprompted.`,
    },
];

export function createIdleChatter({
    say,
    claudeCall,
    isEnabled = () => true,
    isLive = () => false,
    nowPlaying = () => null,
    streamTitle = () => null,
    sayChunkedFn,
    maxLength = 399,
    quietWindowSec = DEFAULT_QUIET_WINDOW_SEC,
    quietMax = DEFAULT_QUIET_MAX,
    cooldownLiveSec = DEFAULT_COOLDOWN_LIVE_SEC,
    cooldownOfflineSec = DEFAULT_COOLDOWN_OFFLINE_SEC,
    backoffMaxSec = DEFAULT_BACKOFF_MAX_SEC,
    botNames = DEFAULT_BOT_NAMES,
    tickSec = DEFAULT_TICK_SEC,
    log = console.log,
    now = () => Date.now(),
    random = Math.random,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
} = {}) {
    if (typeof say !== "function") throw new Error("createIdleChatter requires a `say` function");
    if (typeof claudeCall !== "function") throw new Error("createIdleChatter requires a `claudeCall` function");

    const _bots = new Set(botNames.map((n) => String(n).toLowerCase().replace(/^[@#]/, "")));
    let _stamps = [];            // ms epochs of human messages, within the window
    let _lastSpokeAt = -Infinity; // ms epoch of ANY Mind_B0t message
    let _timer = null;
    let _inFlight = false;        // one Claude call at a time; a slow call must not stack
    // Consecutive unprompted comments made with NO human message in between.
    // ⛔ Reset by ANY human message (Max, 21 Aug 2026), which includes one the bot then
    // replies to — a person speaking is a person in the room, however the bot found out.
    let _selfStreak = 0;

    function _isBot(username) {
        return _bots.has(String(username || "").toLowerCase().replace(/^[@#]/, ""));
    }

    function _prune(t) {
        const cutoff = t - quietWindowSec * 1000;
        _stamps = _stamps.filter((s) => s > cutoff);
    }

    // Record a chat message for the activity count. Bots are dropped here, which is
    // the whole of the "humans only" rule — every other path treats them normally.
    function noteMessage(user) {
        const name = typeof user === "string" ? user : user && user.username;
        if (_isBot(name)) return false;
        const t = now();
        _prune(t);
        _stamps.push(t);
        // ⛔ A human spoke -> the room is not empty -> the backoff goes back to the base.
        _selfStreak = 0;
        return true;
    }

    function isQuiet() {
        _prune(now());
        return _stamps.length < quietMax;
    }

    function _cooldownSec() {
        if (!isLive()) return cooldownOfflineSec;          // flat, no backoff — see above
        // ⛔ EXPONENT IS streak-1, NOT streak. The streak counts comments ALREADY MADE,
        // so after the first one the next wait is the BASE (2 min), not double it.
        // Using 2^streak started the ladder a rung high — 4, 8, 16 — and skipped the
        // 2-minute gap Max actually asked for. Caught by the ladder test, not by reading.
        const rung = Math.max(0, _selfStreak - 1);
        return Math.min(cooldownLiveSec * Math.pow(2, rung), backoffMaxSec);
    }

    function cooldownActive() {
        return now() - _lastSpokeAt < _cooldownSec() * 1000;
    }

    // Called from index.js's wrapper around bot.say, so EVERY outgoing message
    // restarts the cooldown regardless of which module produced it.
    function markSpoke() {
        _lastSpokeAt = now();
    }

    function _pickCategory(track, title) {
        const pool = CATEGORIES.filter((c) =>
            (!c.needsTrack || Boolean(track)) && (!c.needsTitle || Boolean(title)));
        const total = pool.reduce((s, c) => s + c.weight, 0);
        if (total <= 0) return null;
        let r = random() * total;
        for (const c of pool) {
            r -= c.weight;
            if (r < 0) return c;
        }
        return pool[pool.length - 1];
    }

    async function _speak(channel, text, why) {
        if (_inFlight) return false;
        _inFlight = true;
        try {
            const response = await claudeCall(text);
            if (!response) return false;
            if (sayChunkedFn) sayChunkedFn(say, channel, response, maxLength);
            else say(channel, response);
            // ⛔ Mark our OWN send here rather than relying solely on index.js's say()
            // wrapper. The wrapper is what catches messages from every OTHER module, and
            // it still does — but without this line the module cannot enforce its own
            // cooldown standalone, which is a rule depending on a caller to hold it.
            // (Double-marking is harmless: markSpoke just stamps the clock.)
            markSpoke();
            log(`[idle_chatter] spoke (${why})`);
            return true;
        } catch (err) {
            // Fail-quiet: this is ambient chatter, never worth surfacing to chat.
            log(`[idle_chatter] suppressed error (${why}): ${err && err.message}`);
            return false;
        } finally {
            _inFlight = false;
        }
    }

    // A message that was NOT directed at Mind_B0t. index.js calls this only after the
    // trigger check has fallen through, so anything reaching here is unsolicited.
    //
    // ⛔ Offline this is UNGATED by cooldown but still requires the room to be quiet —
    // "always reply to a comment immediately when I'm not live" is about the cooldown,
    // and an offline channel is quiet by definition, so the quiet test is a no-op there
    // rather than a second gate.
    async function maybeReplyTo(channel, user, message) {
        if (!isEnabled()) return false;

        // ⛔ NEVER REPLY TO ANOTHER BOT. Max asked for a reply to "a new comment made by
        // another chatter" — StreamElements' follow announcements and Sery_Bot's
        // wellness reminders are not that, and answering them would have the bot
        // holding conversations with automation in an empty room.
        //
        // ⚠ The same list already excludes bots from the ACTIVITY COUNT, but that is a
        // different question and the two were wired separately at first: not counting a
        // message is not the same as not answering it. Both are needed.
        const _who = (user && user.username) || user;
        if (_isBot(_who)) return false;

        if (!isQuiet()) return false;
        const live = isLive();
        if (live && cooldownActive()) return false;

        const who = (user && user.username) || "someone";
        const track = nowPlaying();
        let text =
            `[Chat has been quiet. ${who} just said, without addressing you: "${message}"] ` +
            `Reply to what they actually said, briefly, like someone in the room picking up the thread.`;
        if (track) text = `[Now playing on stream: ${track}] ` + text;
        const _title = streamTitle();
        if (_title) text = `[Tonight's stream: "${_title}"] ` + text;

        return _speak(channel, text, live ? "reply/live" : "reply/offline");
    }

    // The unprompted path — nothing to react to, so it is driven by the tick.
    async function _tick(channel) {
        if (!isEnabled()) return false;
        if (cooldownActive()) return false;
        if (!isQuiet()) return false;

        const track = nowPlaying();
        const title = streamTitle();
        const cat = _pickCategory(track, title);
        if (!cat) return false;

        const spoke = await _speak(channel, cat.prompt(track, title), `self/${cat.key}`);
        // ⛔ Only the UNPROMPTED path escalates. maybeReplyTo does not, because reaching
        // it means a human just spoke — which has already reset the streak to 0.
        if (spoke) _selfStreak += 1;
        return spoke;
    }

    function start(channel) {
        if (_timer) return;
        _timer = setIntervalFn(() => { _tick(channel); }, tickSec * 1000);
        if (_timer && typeof _timer.unref === "function") _timer.unref();
        log(`[idle_chatter] started — quiet = fewer than ${quietMax} human messages in ${quietWindowSec}s`);
    }

    function stop() {
        if (!_timer) return;
        clearIntervalFn(_timer);
        _timer = null;
    }

    return {
        noteMessage, maybeReplyTo, markSpoke, start, stop,
        isQuiet, cooldownActive,
        get selfStreak() { return _selfStreak; },
        get cooldownSec() { return _cooldownSec(); },
        _tick, _pickCategory,
        get messageCount() { _prune(now()); return _stamps.length; },
        get bots() { return _bots; },
    };
}

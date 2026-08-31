import express from 'express';
import fs from 'fs';

import expressWs from 'express-ws';

import {job} from './keep_alive.js';

import {ClaudeOperations} from './claude_operations.js';
import {SeratoOperations} from './serato_operations.js';
import {TwitchBot} from './twitch_bot.js';
import {fetchRaiderProfile, cleanTitle, cleanDescription, relativeTimePhrase, extractPanelText, fetchStreamState} from './twitch_profile.js';
import {createSubThanks} from './sub_thanks.js';
import {createFollowThanks} from './follow_thanks.js';
import {createCheerThanks} from './cheer_thanks.js';
import {createTopicCommands} from './topic_commands.js';
import {chunkText, sayChunked} from './chunk_text.js';
import {createShoutout, profileLines} from './shoutout.js';
import {createEventSub} from './eventsub.js';
import {createHypeTrain} from './hype_train.js';
import {createWatchStreak} from './watch_streak.js';
import {createChatWelcome} from './chat_welcome.js';
import {createIdleChatter} from './idle_chatter.js';
import WebSocket from 'ws';

// The four cleaners profileLines needs, bundled once so both shoutout paths
// pass the same set. Injected rather than imported inside shoutout.js so that
// module stays testable without twitch_profile.js or any network.
const _profileHelpers = {cleanDescription, extractPanelText, cleanTitle, relativeTimePhrase};

// WO (11 Aug 2026, §3b2): nothing pins the Node version this runs on — no
// engines field, no .nvmrc, render.yaml just says "runtime: node" — and the
// raid-enrichment fetch below needs Node >=18 for global fetch to exist.
// This is the one-time (now permanent, via Render's log) way to find out
// what's actually running. process.version is NOT a secret — do not extend
// this to anything from process.env (that was the Stage 1 leak).
console.log("node", process.version);

// start keep alive cron job
job.start();

// setup express app
const app = express();
const expressWsInstance = expressWs(app);

// set the view engine to ejs
app.set('view engine', 'ejs');

// The channel this bot serves, needed before the module setups below. CHANNELS
// is split into an array further down; this reads the raw env so ordering does
// not matter.
const _hypeChannelName = String(process.env.CHANNELS || "").split(",")[0].trim();

// load env variables
let GPT_MODE = process.env.GPT_MODE // CHAT or PROMPT
let HISTORY_LENGTH = process.env.HISTORY_LENGTH // number of messages to keep in history
let ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY // anthropic api key
let MODEL_NAME = process.env.MODEL_NAME // anthropic/claude model name (e.g. claude-haiku-4-5-20251001)
let TWITCH_USER = process.env.TWITCH_USER // twitch bot username
let TWITCH_AUTH =  process.env.TWITCH_AUTH // tmi auth token
let COMMAND_NAME = process.env.COMMAND_NAME // comma separated list of commands to trigger bot (e.g. !gpt, !chat) — NOTE: no longer used for the Claude trigger path as of Stage 3 (see TRIGGER_REGEX below); left in place only to avoid touching unrelated env parsing.
let CHANNELS = process.env.CHANNELS // comma separated list of channels to join
let SEND_USERNAME = process.env.SEND_USERNAME // send username in message to claude
let ENABLE_CHANNEL_POINTS = process.env.ENABLE_CHANNEL_POINTS; // enable channel points
let SERATO_PLAYLIST_ID = process.env.SERATO_PLAYLIST_ID // serato live playlist id for now-playing (e.g. 15134427)

if (!GPT_MODE) {
    GPT_MODE = "CHAT"
}
if (!HISTORY_LENGTH) {
    HISTORY_LENGTH = 5
}
if (!ANTHROPIC_API_KEY) {
    console.log("No ANTHROPIC_API_KEY found. Please set it as environment variable.")
}
if (!MODEL_NAME) {
    MODEL_NAME = "claude-haiku-4-5-20251001"
}
if (!TWITCH_USER) {
    TWITCH_USER = "oSetinhasBot"
    console.log("No TWITCH_USER found. Using oSetinhasBot as default.")
}
if (!TWITCH_AUTH) {
    // https://dev.twitch.tv/console
    // https://twitchapps.com/tmi/
    TWITCH_AUTH = "oauth:vgvx55j6qzz1lkt3cwggxki1lv53c2"
    console.log("No TWITCH_AUTH found. Using oSetinhasBot auth as default.")
}
if (!COMMAND_NAME) {
    COMMAND_NAME = ["!gpt"]
} else {
    // split commands by comma into array
    COMMAND_NAME = COMMAND_NAME.split(",")
}
COMMAND_NAME = COMMAND_NAME.map(function(x){ return x.toLowerCase() })
if (!CHANNELS) {
    CHANNELS = ["oSetinhas", "jones88"]
} else {
    // split channels by comma into array
    CHANNELS = CHANNELS.split(",")
}
if (!SEND_USERNAME) {
    SEND_USERNAME = "true"
}
if (!ENABLE_CHANNEL_POINTS) {
    ENABLE_CHANNEL_POINTS = "false";
}

// ---------------------------------------------------------------------------
// Stage 3 — Broader triggering (2026-07-03 work order)
// ---------------------------------------------------------------------------

// Trigger token set (Max, 3 Jul 2026) — fixed, not env-configurable.
// Case-insensitive, word-boundary matched: fires only as a standalone
// word/mention, never as a substring inside a larger word (e.g.
// "mindbotting") or a dotted URL/domain (e.g. "mindbot.tv"). A literal
// sentence-ending period ("...mindbot.") still passes — only a period
// immediately followed by another word character (domain-suffix shape) is
// excluded. "@mb" deliberately requires the "@" so it never collides with
// "my bad".
//
// This REPLACES the old prefix-only match (`message.toLowerCase().startsWith(COMMAND_NAME)`)
// and its slice-bug: `message.slice(COMMAND_NAME.length)` used the command
// ARRAY's .length (=1), not the matched string's length, so it stripped only
// one character and leaked trigger text into the Claude prompt. The
// anywhere-match rewrite below strips the actual matched token via regex
// replace instead, so that bug class can't recur.
// The companion bot. Its messages reach follow_thanks (above) but never any
// conversational path. Env-overridable in case the account is ever renamed.
// Philo_B0t's own trigger tokens. Built with the SAME pattern logic as
// TRIGGER_REGEX below, so "@pb" cannot match inside an email or a word.
const PHILO_TRIGGER_TOKENS = ["@Philo_B0t", "philobot", "philob0t", "philo_b0t", "philo_bot", "@pb"];

// Commands belonging to other bots. Mind_B0t must not treat them as chat.
const FOREIGN_COMMANDS = String(process.env.FOREIGN_COMMANDS || "!philo,!pbstop,!pbstart")
    .split(",").map(c => c.trim().toLowerCase()).filter(Boolean);
const PHILO_ACCOUNT = String(process.env.PHILO_ACCOUNT || "philo_b0t").toLowerCase();

const TRIGGER_TOKENS = ["@Mind_B0t", "mindbot", "mindb0t", "mind_b0t", "mind_bot", "@mb"];

function _triggerTokenToPattern(tok) {
    const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // defensive; no metachars in current tokens
    const lead = esc.startsWith("@") ? "(?<![\\w@])" : "\\b"; // "@token" must not be glued to a preceding word char or another "@"
    const trail = "\\b(?!\\.\\w)"; // standard word boundary, but refuse to match into a ".tld"-shaped URL/domain suffix
    return `${lead}${esc}${trail}`;
}

const TRIGGER_REGEX = new RegExp(TRIGGER_TOKENS.map(_triggerTokenToPattern).join("|"), "i");
const PHILO_TRIGGER_REGEX = new RegExp(PHILO_TRIGGER_TOKENS.map(_triggerTokenToPattern).join("|"), "i");
// Separate global/case-insensitive copy used ONLY for stripping the matched token(s)
// out of the outgoing Claude text (S3 nit: the non-global TRIGGER_REGEX above must stay
// non-global for .test() — a "g" flag there would introduce lastIndex statefulness across
// calls and break repeated matching). This one strips ALL occurrences in a multi-token message.
const TRIGGER_REGEX_STRIP_ALL = new RegExp(TRIGGER_TOKENS.map(_triggerTokenToPattern).join("|"), "gi");

// Cooldowns (Max, 3 Jul 2026) — silent, gate ONLY the trigger→Claude path.
// !song (S2) and the kill-switch commands below are exempt. In-memory only
// (resets on restart) — no persistence needed for a rate limiter.
const COOLDOWN_PER_USER_SEC = Number(process.env.COOLDOWN_PER_USER_SEC || 10);
const COOLDOWN_GLOBAL_SEC = Number(process.env.COOLDOWN_GLOBAL_SEC || 5);

// How long to hold a raid shoutout before posting it (Max, 12 Aug 2026).
// ⛔ NOT a cooldown — it does not suppress anything, it delays one message.
// Deliberately an env var so it can be retuned on Render without a deploy.
// Set to 0 to post immediately (the pre-12-Aug behaviour).
//
// ⚠ Measured from the moment the raid arrives, NOT from the end of the
// enrichment work: the fetch and the Claude call happen straight away and
// only the POSTING waits out the remainder. Two reasons, and the first is
// the load-bearing one:
//   1. `stream { id }` -> "[They are LIVE right now.]" is a fact about the
//      raider AT THE MOMENT THEY RAIDED. Raiders routinely end their stream
//      seconds after raiding, so a fetch deferred by 30s would report them
//      offline and silently drop a line that was true when it mattered.
//   2. It makes the delay mean what it says — the message lands at ~30s, not
//      at 30s plus however long Claude took.
// ⚠ `??` not `||`, deliberately: with `||` a value of 0 would fall through to
// the default and "post immediately" would be unreachable. And a malformed
// value falls back to the DEFAULT rather than to 0 — a typo'd env var should
// not silently turn the delay off, which is the failure nobody would notice.
const _raidDelayRaw = Number(process.env.RAID_SHOUTOUT_DELAY_SEC ?? 30);
const RAID_SHOUTOUT_DELAY_SEC =
    Number.isFinite(_raidDelayRaw) && _raidDelayRaw >= 0 ? _raidDelayRaw : 30;
const _lastFirePerUser = new Map(); // username (as given by tmi.js) -> ms epoch of last Claude fire
let _lastFireGlobal = -Infinity;    // ms epoch of last Claude fire, any user

function _cooldownActive(username) {
    const now = Date.now();
    if (now - _lastFireGlobal < COOLDOWN_GLOBAL_SEC * 1000) return true;
    const last = _lastFirePerUser.get(username);
    if (last && now - last < COOLDOWN_PER_USER_SEC * 1000) return true;
    return false;
}

function _markFired(username) {
    const now = Date.now();
    _lastFireGlobal = now;
    _lastFirePerUser.set(username, now);
}

// Kill switch (Max, 3 Jul 2026) — mod/broadcaster-only, instant, in-memory.
// BOT_ENABLED is only the BOOT default (Max sets it on Render); the chat
// command flips in-memory state until the process next restarts. The
// Stream-Deck trigger for this rides on Stage 4's endpoint — not built here.
// Command names are deliberately NOT trigger tokens (verified: neither
// "!mbstop" nor "!mbstart" matches TRIGGER_REGEX above).
let _botEnabled = String(process.env.BOT_ENABLED || "true").toLowerCase() !== "false";

// True when a message came from THIS bot's own Twitch account, whichever process
// posted it. Compared by login, so it holds across duplicate instances.
function _isOwnAccount(username) {
    if (!username) return false;
    return String(username).toLowerCase() === String(TWITCH_USER || "").toLowerCase().replace(/^[@#]/, "");
}

function _isModOrBroadcaster(user) {
    if (user && user.mod) return true;
    if (user && user.badges && user.badges.broadcaster === "1") return true;
    return false;
}

// ---------------------------------------------------------------------------
// Raid auto-shoutout + profile enrichment (2026-08-11 work order)
// ---------------------------------------------------------------------------
// Builds the context block Claude sees for a raid welcome, from whatever
// survived the fetch + clean pipeline in twitch_profile.js. Every bracketed
// field is OMITTED if empty (WO §3d) — `profile` itself is null whenever the
// enrichment fetch failed or the login didn't resolve (fail-open), in which
// case the welcome still fires on username + viewer count alone.
//
// Deliberately NOT wrapped with the SEND_USERNAME "Message from user..."
// prefix used on the trigger path — the first line already names the raider.
//
// ⛔ The profile block itself now lives in shoutout.js and is SHARED with the
// manual "SO <name>" command (14 Aug 2026). It was extracted rather than copied
// because the panel-handling instruction is load-bearing — three regex
// classifiers were tried before it and every one shipped gear lists and
// donation pitches into shoutouts — and a second copy would drift from this one.
//
// ⚠ The two paths differ in exactly one way, deliberately: this one FAILS OPEN
// (a raid is real and time-critical, so a failed fetch still produces a welcome
// from username + viewer count), and the manual one FAILS CLOSED. See shoutout.js.
function _buildRaidPrompt(username, viewers, profile) {
    const lines = [`[RAID] ${username} just raided the channel with ${viewers} viewers.`];
    lines.push(...profileLines(profile, _profileHelpers));
    lines.push("Give them a warm, in-character welcome and shoutout.");
    return lines.join("\n");
}

// init global variables
const MAX_LENGTH = 399
let file_context = "You are a helpful Twitch Chatbot."
let last_user_message = ""

// setup twitch bot
const channels = CHANNELS;
const channel = channels[0];
console.log("Channels: " + channels)

const bot = new TwitchBot(TWITCH_USER, TWITCH_AUTH, channels);

// setup claude operations
file_context = fs.readFileSync("./file_context.txt", 'utf8');
const claude_ops = new ClaudeOperations(file_context, ANTHROPIC_API_KEY, MODEL_NAME, HISTORY_LENGTH);

// setup serato now-playing poller (optional — only active if SERATO_PLAYLIST_ID is set)
const serato = SERATO_PLAYLIST_ID ? new SeratoOperations(SERATO_PLAYLIST_ID) : null;
if (serato) { serato.start(); console.log("Serato now-playing enabled for playlist " + SERATO_PLAYLIST_ID); }
else { console.log("SERATO_PLAYLIST_ID not set — now-playing disabled."); }

// setup twitch bot callbacks
bot.onConnected((addr, port) => {
    console.log(`* Connected to ${addr}:${port}`);

    // Start the unprompted-comment tick. ⛔ Here rather than at module construction:
    // nothing can be said before the bot is connected, and onConnected can fire again
    // on a reconnect — start() is idempotent, so a reconnect does not stack timers.
    if (_hypeChannelName) idleChatter.start(_hypeChannelName);

    // ⛔⛔ SETTLE _isLive BY ASKING, NOT BY WAITING. stream.online/offline are
    // TRANSITIONS: a process that starts mid-stream has already missed stream.online
    // and never sees it, so it treats a live channel as offline for the whole
    // broadcast — the 1-hour cadence instead of the 2-minute one.
    //
    // ⚠ Observed live 21 Aug 2026, on the very deploy that shipped idle_chatter: the
    // merge landed while Max was streaming and the bot went quiet for the rest of it.
    // This is not a rare restart — it is EVERY deploy made during a stream.
    //
    // ⛔ null means "could not determine" and is NOT offline — leave the flag alone in
    // that case and let EventSub correct it at the next transition.
    if (_hypeChannelName) {
        fetchStreamState(String(_hypeChannelName).replace(/^[#@]/, "")).then((st) => _applyStreamState(st, "boot"));
    }

    // join channels
    channels.forEach(channel => {
        console.log(`* Joining ${channel}`);
        console.log(`* Saying hello in ${channel}`)
    });
});

bot.onDisconnected((reason) => {
    console.log(`Disconnected: ${reason}`);
});

// Raid auto-shoutout + profile enrichment (2026-08-11 work order). tmi.js
// fires 'raided' once per inbound raid: (channel, username, viewers).
//
// Gating (WO §3e): respects the kill switch (same as every other Claude
// path) but deliberately has NO cooldown and NO viewer threshold — a raid is
// rare and non-spammy, and fake/tiny raids are not a concern (Max, 4 Jul).
// Do not route this through _cooldownActive.
bot.onRaided(async (channel, username, viewers) => {
    if (!_botEnabled) return; // kill switch: !mbstop mutes auto-welcomes too

    const raidedAt = Date.now();

    // Fail-open by contract (twitch_profile.js): resolves null on a network
    // error, a timeout, or an unknown login — never throws, never delays
    // past its own ~2s budget. The welcome below fires either way.
    const profile = await fetchRaiderProfile(username);

    const text = _buildRaidPrompt(username, viewers, profile);
    const response = await claude_ops.make_claude_call(text);

    // Hold the finished shoutout until RAID_SHOUTOUT_DELAY_SEC has elapsed
    // since the raid landed. The work above is already done, so this waits
    // only the REMAINDER — see the constant's note for why the fetch is not
    // what gets deferred.
    const remainingMs = RAID_SHOUTOUT_DELAY_SEC * 1000 - (Date.now() - raidedAt);
    if (remainingMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingMs));
    }

    // ⛔⛔ RE-CHECK THE KILL SWITCH. The check at the top of this handler was
    // taken up to 30 SECONDS AGO and !mbstop can land inside that window —
    // without this, telling the bot to shut up would still be followed by a
    // shoutout most of a minute later. This is the ONLY reason the delay
    // needed more than a bare setTimeout.
    if (!_botEnabled) {
        console.log(`[mind_b0t] raid shoutout for ${username} dropped — kill switch flipped during the ${RAID_SHOUTOUT_DELAY_SEC}s delay`);
        return;
    }

    // Same MAX_LENGTH splitter used by every other path that posts a Claude
    // response to chat.
    if (response.length > MAX_LENGTH) {
        const messages = chunkText(response, MAX_LENGTH);
        messages.forEach((message, index) => {
            setTimeout(() => {
                bot.say(channel, message);
            }, 1000 * index);
        });
    } else {
        bot.say(channel, response);
    }
});

// ---------------------------------------------------------------------------
// Sub + gift-sub thanks (2026-08-11 work order). ⛔ THANK-YOU, not a
// shoutout: no twitch_profile.js call, no fetch of any kind — see
// sub_thanks.js header for the full design (bulk-gift suppression via tag +
// timing guard, and the independent throttle/batch queue for the sub path,
// which is NOT gated by _cooldownActive — see sub_thanks.js and WO §5).
//
// isEnabled reads the same _botEnabled kill switch as every other Claude
// path (!mbstop silences sub thanks too), via a closure so it always sees
// the current value even though _botEnabled is reassigned later by the
// !mbstop/!mbstart handler below.
const subThanks = createSubThanks({
    say: (sayChannel, message) => bot.say(sayChannel, message),
    claudeCall: (text) => claude_ops.make_claude_call(text),
    isEnabled: () => _botEnabled,
    maxLength: MAX_LENGTH,
});

// Follower welcomes (14 Aug 2026). Unlike every other handler here this one is
// driven by a CHAT MESSAGE, not a tmi.js event — follows are not an IRC event
// and never have been, so there is nothing for bot.onFollow to hook. It watches
// for StreamElements' own follow announcement instead; see follow_thanks.js.
//
// ⛔ FOLLOW_ANNOUNCER is a security boundary, not configuration convenience:
// the trigger is a plain string any viewer could type. Only messages FROM this
// account are examined. Default "streamelements".
//
// ⛔ Deliberately NOT gated by _cooldownActive — Max, 14 Aug 2026, explicitly:
// no rate limiting and no cooldown on this path. Ten follows means ten replies.
const followThanks = createFollowThanks({
    say: (sayChannel, message) => bot.say(sayChannel, message),
    claudeCall: (text) => claude_ops.make_claude_call(text),
    isEnabled: () => _botEnabled,
    announcer: process.env.FOLLOW_ANNOUNCER || "streamelements",
    maxLength: MAX_LENGTH,
});

// Bits/cheers (14 Aug 2026). ⛔ Unlike follows, this one runs off the REAL
// event — a cheer is visible to us, a follow is not. So there is no third-party
// wording to depend on, nothing to break silently, and no announcer check.
//
// ⛔ Signature is (channel, tags, message), NOT the sub family's
// (channel, username, ...) — see twitch_bot.js onCheer and cheer_thanks.js.
const cheerThanks = createCheerThanks({
    say: (sayChannel, message) => bot.say(sayChannel, message),
    claudeCall: (text) => claude_ops.make_claude_call(text),
    isEnabled: () => _botEnabled,
    maxLength: MAX_LENGTH,
});

bot.onCheer((cheerChannel, tags, message) => {
    cheerThanks.onCheer(cheerChannel, tags, message);
});

// Watch Streaks (15 Aug 2026). Arrives as an IRC USERNOTICE with
// msg-id=viewermilestone — NOT available via EventSub, so this is the only path.
//
// ⛔ Signature is (msgid, channel, tags, msg): the msg-id comes FIRST, unlike
// every other handler here. See twitch_bot.js onUsernotice.
//
// ⚠ Ungated by _cooldownActive, like the raid welcome — Max publishes these
// manually, so he is already the filter on how many appear.
const watchStreak = createWatchStreak({
    say: (sayChannel, message) => bot.say(sayChannel, message),
    claudeCall: (text) => claude_ops.make_claude_call(text),
    isEnabled: () => _botEnabled,
    sayChunkedFn: sayChunked,
    maxLength: MAX_LENGTH,
});

bot.onUsernotice((msgid, noticeChannel, tags) => {
    watchStreak.onUsernotice(msgid, noticeChannel, tags);
});

// !kosmische · !berlinschool · !artists · !tranceroots (14 Aug 2026) — moved off
// StreamElements, where they were fixed strings. Generated fresh each firing,
// scoped rather than scripted; see topic_commands.js for what Max ruled may vary.
//
// ⚠ These DO take the shared cooldowns, unlike the follow and cheer paths. That
// is not a departure from his "no cooldown" instruction — that instruction was
// about event-driven replies nobody can spam. These are viewer-typed commands,
// SE gated them at 5s/15s, and !song (the other command path) is gated the same
// way. Preserving existing behaviour, not adding a rule.
// Manual "SO <name>" — the same fetch the raid path uses (14 Aug 2026).
//
// ⚠ cooldownActive/markFired are deliberately NO-OPS here: the trigger block
// that calls this has already checked the cooldown and marked the fire before
// stripping the token. The module keeps its own hooks so it is testable and so a
// future caller outside that block still gets gating — but wiring them here too
// would charge one message against the limit twice.
const shoutout = createShoutout({
    say: (sayChannel, message) => bot.say(sayChannel, message),
    claudeCall: (text) => claude_ops.make_claude_call(text),
    fetchProfile: (login) => fetchRaiderProfile(login),
    helpers: _profileHelpers,
    isEnabled: () => _botEnabled,
    // Same predicate the kill switch uses — one definition of "mod or
    // broadcaster", not a second one that can drift from it.
    isAllowed: (user) => _isModOrBroadcaster(user),
    cooldownActive: () => false,
    markFired: () => {},
    sayChunkedFn: sayChunked,
    maxLength: MAX_LENGTH,
});

// First-message-of-stream welcomes (15 Aug 2026). Max greets people by hand
// today and calls it "a huge pain in the ass" — this replaces that.
//
// ⛔ Twitch has NO per-stream marker, so the module tracks who it has seen and
// is reset by EventSub stream.online below. In memory, deliberately: his ruling
// is not to redeploy mid-stream rather than to persist it.
//
// ⚠ Deliberately NOT gated by _cooldownActive. It fires once per person per
// stream by construction, which is a tighter bound than any cooldown.
const chatWelcome = createChatWelcome({
    say: (sayChannel, message) => bot.say(sayChannel, message),
    claudeCall: (text) => claude_ops.make_claude_call(text),
    isEnabled: () => _botEnabled,
    broadcaster: String(_hypeChannelName || "").replace(/^#/, ""),
    delaySec: Number(process.env.WELCOME_DELAY_SEC ?? 5),
    sayChunkedFn: sayChunked,
    maxLength: MAX_LENGTH,
});

// ---------------------------------------------------------------------------
// LIVE / OFFLINE STATE (Max, 21 Aug 2026) — idle_chatter uses a different cooldown
// either side of this: 2 minutes live, 1 hour offline.
//
// ⛔ Set ONLY by EventSub stream.online / stream.offline below. He considered "5
// minutes after I raid out" as the offline signal and rejected it once shown that
// stream.offline is the actual fact, needs no scope, and does not fail on a stream
// that ends some other way.
//
// ⚠ Defaults FALSE — an unattended restart assumes offline until Twitch says
// otherwise, which errs toward the 1-hour cooldown rather than the 2-minute one.
// Cosmetic and accepted, same call as chat_welcome's seen-list (Max: "stop worrying
// about the restart case"). ⛔ If EventSub is not configured this NEVER becomes true,
// and the bot behaves as permanently offline — which is silent-ish, not noisy.
let _isLive = false;

// The stream's TITLE, which is Max's framing for the whole night ("Cyberium
// (Techno/Acid/Dark Trance) | ..."). ⛔ Different information from the track Serato
// reports: the SET versus the RECORD. idle_chatter uses it to comment on the set as a
// whole (Max, 21 Aug 2026: "I want comments about the set as awhgole").
//
// ⛔ Kept fresh from THREE places because no single one is sufficient:
//   boot            — a process starting mid-stream missed stream.online entirely
//   stream.online   — the normal case, title set before going live
//   channel.update  — the ONLY one that catches a retitle mid-stream
let _streamTitle = null;
let _streamGame = null;

function _applyStreamState(st, why) {
    if (!st) { console.log(`[idle_chatter] stream-state (${why}): undetermined, leaving as-is`); return; }
    _isLive = st.live;
    if (st.title) _streamTitle = st.title;
    if (st.game) _streamGame = st.game;
    console.log(`[idle_chatter] stream-state (${why}): ${st.live ? "LIVE" : "offline"}` +
                (st.title ? ` — "${st.title}"` : ""));
}

const idleChatter = createIdleChatter({
    say: (sayChannel, message) => bot.say(sayChannel, message),
    claudeCall: (text) => claude_ops.make_claude_call(text),
    isEnabled: () => _botEnabled,
    isLive: () => _isLive,
    nowPlaying: () => (serato ? serato.nowPlaying() : null),
    streamTitle: () => _streamTitle,
    sayChunkedFn: sayChunked,
    maxLength: MAX_LENGTH,
    quietWindowSec: Number(process.env.IDLE_QUIET_WINDOW_SEC ?? 120),
    quietMax: Number(process.env.IDLE_QUIET_MAX ?? 4),
    cooldownLiveSec: Number(process.env.IDLE_COOLDOWN_LIVE_SEC ?? 120),
    cooldownOfflineSec: Number(process.env.IDLE_COOLDOWN_OFFLINE_SEC ?? 3600),
});

// ⛔ EVERY outgoing message restarts the idle cooldown, whatever produced it — a
// shoutout, a hype-train line, a !song answer, a raid welcome. Max's rule is about
// Mind_B0t having spoken AT ALL, not about this module having spoken:
//     "the cooldown restarted after every mind_b0t comment. so if someone asks it a
//      question which it answers, the cooldown engages or restarts"
// Wrapping say() once here is why no other module needed touching.
const _botSay = bot.say.bind(bot);
bot.say = (sayChannel, message) => {
    idleChatter.markSpoke();
    return _botSay(sayChannel, message);
};

const topicCommands = createTopicCommands({
    say: (sayChannel, message) => bot.say(sayChannel, message),
    claudeCall: (text) => claude_ops.make_claude_call(text),
    isEnabled: () => _botEnabled,
    cooldownActive: (username) => _cooldownActive(username),
    markFired: (username) => _markFired(username),
    maxLength: MAX_LENGTH,
});

bot.onSubscription((subChannel, username, methods, message, tags) => {
    subThanks.onSubscription(subChannel, username, methods, message, tags);
});

bot.onResub((subChannel, username, streakMonths, message, tags, methods) => {
    subThanks.onResub(subChannel, username, streakMonths, message, tags, methods);
});

bot.onSubgift((subChannel, username, streakMonths, recipient, methods, tags) => {
    subThanks.onSubgift(subChannel, username, streakMonths, recipient, methods, tags);
});

bot.onSubmysterygift((subChannel, username, giftSubCount, methods, tags) => {
    subThanks.onSubmysterygift(subChannel, username, giftSubCount, methods, tags);
});

bot.onAnonSubgift((subChannel, streakMonths, recipient, methods, tags) => {
    subThanks.onAnonSubgift(subChannel, streakMonths, recipient, methods, tags);
});

bot.onAnonSubmysterygift((subChannel, giftSubCount, methods, tags) => {
    subThanks.onAnonSubmysterygift(subChannel, giftSubCount, methods, tags);
});

// connect bot
bot.connect(
    () => {
        console.log("Bot connected!");
    },
    (error) => {
        console.log("Bot couldn't connect!");
        console.log(error);
    }
);

// ---------------------------------------------------------------------------
// EventSub — hype trains (14 Aug 2026)
// ---------------------------------------------------------------------------
// ⛔ A hype train is NOT an IRC event, so tmi.js cannot see one. This is a
// SECOND connection to Twitch, with its own auth, alongside the chat socket.
//
// ⛔ IT NEEDS A TOKEN THE BOT DOES NOT ALREADY HAVE. WebSocket EventSub rejects
// app access tokens, and channel.hype_train.begin needs channel:read:hype_train
// granted BY THE BROADCASTER. TWITCH_AUTH belongs to mind_bot2 and cannot carry
// that scope for mind_prime's channel.
//
// ⛔ THE CREDENTIAL IS A REFRESH TOKEN, NOT AN ACCESS TOKEN. Measured on Max's
// live token, 14 Aug 2026: expires_in 13742 seconds — 3.8 hours. A static access
// token would work for one afternoon and then die on a 401 nobody sees, because
// the WEBSOCKET stays happily connected while the SUBSCRIPTION is what expires.
//
// ⭐ So this stays INERT until all three are set on Render. Absent them it logs
// once and does nothing — no throw, no retry, no effect on chat. A
// half-configured EventSub must never be able to take down the chat bot.
const EVENTSUB_CLIENT_ID = process.env.EVENTSUB_CLIENT_ID || "";
const EVENTSUB_CLIENT_SECRET = process.env.EVENTSUB_CLIENT_SECRET || "";
const EVENTSUB_REFRESH_TOKEN = process.env.EVENTSUB_REFRESH_TOKEN || "";
const _hypeChannel = Array.isArray(CHANNELS) && CHANNELS.length ? CHANNELS[0] : null;

if (EVENTSUB_CLIENT_ID && EVENTSUB_CLIENT_SECRET && EVENTSUB_REFRESH_TOKEN && _hypeChannel) {
    const hypeTrain = createHypeTrain({
        say: (sayChannel, message) => bot.say(sayChannel, message),
        channel: _hypeChannel,
        claudeCall: (text) => claude_ops.make_claude_call(text),
        isEnabled: () => _botEnabled,
        sayChunkedFn: sayChunked,
        maxLength: MAX_LENGTH,
    });

    const eventSub = createEventSub({
        clientId: EVENTSUB_CLIENT_ID,
        clientSecret: EVENTSUB_CLIENT_SECRET,
        refreshToken: EVENTSUB_REFRESH_TOKEN,
        broadcasterLogin: String(_hypeChannel).replace(/^#/, ""),
        subscriptions: [
            {type: "channel.hype_train.begin", version: "2"},
            // ⛔ stream.online needs NO scope — it is the reset signal for the
            // chat-welcome seen-list, not a data read.
            {type: "stream.online", version: "1"},
            // ⛔ stream.offline needs NO scope either. Added 21 Aug 2026 — it is the ONLY
            // thing that tells the bot a stream ended. Without it _isLive would latch true
            // after the first stream and never clear, so the 1-hour offline cooldown would
            // never apply and the bot would keep the 2-minute live cadence forever.
            {type: "stream.offline", version: "1"},
            // ⛔ channel.update needs NO scope, and it is the ONLY signal that catches a
            // RETITLE MID-STREAM. boot and stream.online both read the title once; if Max
            // changes it an hour in, only this tells the bot.
            {type: "channel.update", version: "2"},
        ],
        onNotification: (type, event) => {
            if (type === "stream.online") {
                _isLive = true;
                chatWelcome.reset("stream.online");
                // Refetch rather than trusting a stale title from boot — he usually sets it
                // just before going live, so the boot value can predate the change.
                fetchStreamState(String(_hypeChannel).replace(/^[#@]/, "")).then((st) => _applyStreamState(st, "stream.online"));
                return;
            }
            if (type === "channel.update") {
                // ⚠ The event carries the new values directly — no refetch needed, and using
                // them avoids a race where a refetch reads back the PREVIOUS title.
                if (event && event.title) _streamTitle = event.title;
                if (event && event.category_name) _streamGame = event.category_name;
                console.log(`[idle_chatter] channel.update — "${_streamTitle}"`);
                return;
            }
            if (type === "stream.offline") { _isLive = false; console.log("[idle_chatter] stream.offline — offline cadence"); return; }
            hypeTrain.onNotification(type, event);
        },
        WebSocketImpl: WebSocket,
        log: console.log,
    });

    eventSub.connect();
} else {
    console.log("[eventsub] disabled — set EVENTSUB_CLIENT_ID, EVENTSUB_CLIENT_SECRET and EVENTSUB_REFRESH_TOKEN to enable hype train messages");
}

bot.onMessage(async (channel, user, message, self) => {
    if (self) return;

    // ⛔⛔ `self` IS NOT A SENDER CHECK. [verified in node_modules/tmi.js/lib/client.js,
    // 21 Aug 2026] it is HARDCODED: false for every message arriving from the server
    // (line 1117) and true only for tmi.js's local echo of a message THIS process sent
    // (line 1405). It cannot tell you who sent an inbound message.
    //
    // ⇒ So a SECOND instance of this bot — which is what a Render deploy produces for
    // a moment, and what a stuck old instance produces indefinitely — sees the first
    // instance's messages as a stranger's.
    //
    // ⛔ AND MIND_B0T'S OWN EMOTE IS `mindbo7MindBot`, WHICH CONTAINS THE TRIGGER TOKEN
    // `mindbot`. Every message it posts therefore carries its own trigger. Two
    // instances plus that emote is an unbounded feedback loop, and it was observed
    // live on 21 Aug: the bot answered its own Europa weather report twice.
    // ⚠ The per-user cooldown used to bound this to one exchange per 10s. It was
    // removed the same day on Max's ruling that direct replies are never gated, which
    // is what turned a quirk into a loop. This guard is now the only thing stopping it.
    if (_isOwnAccount(user && user.username)) return;

    // Activity for the quiet measure. ⛔ FIRST and UNCONDITIONAL — it must count even
    // when !mbstop has muted the bot, and even when the message is a command, because
    // it measures THE ROOM, not the bot's workload. noteMessage drops known bots
    // itself (Max, 21 Aug 2026: count "only what humans say").
    idleChatter.noteMessage(user);

    // Follow welcomes, checked before any command parsing. Returns true only
    // when the message really was StreamElements' follow announcement, so a
    // normal chat line falls straight through at the cost of one string
    // compare. Awaited so a Claude failure inside cannot reject unhandled —
    // it swallows its own errors and logs them.
    if (await followThanks.onMessage(channel, user, message)) return;

    // ---------------------------------------------------------------------------
    // ⛔⛔ DO NOT CONVERSE WITH PHILO_B0T (Max, 30 Aug 2026: "it should not engage in
    // conversation with mind_b0t, and vice versa").
    //
    // [observed live 30 Aug 17:39] One !philo produced SEVEN bot messages: Philo_B0t
    // answered, Mind_B0t replied to its content, Mind_B0t then WELCOMED "@Philo_B0t",
    // and that @mention pulled Philo_B0t back for three more. It terminated on
    // cooldowns rather than running away, but it should not have started.
    //
    // ⛔⛔ PLACEMENT IS LOAD-BEARING — THIS MUST STAY *BELOW* followThanks.
    // follow_thanks reads STREAMELEMENTS' chat announcements to detect follows, and
    // its own comment calls that sender check "a security boundary, not a tidiness
    // rule". A blanket ignore-all-bots guard at the top of this handler -- the
    // obvious fix, and the one Philo_B0t itself uses -- would SILENTLY KILL FOLLOW
    // THANK-YOUS. Announcer-reading paths must keep seeing bot messages.
    //
    // ⇒ Named account, not a category. Everything below here is conversational:
    //   welcome, topic commands, !song, channel points, and the trigger reply.
    if (String((user && user.username) || "").toLowerCase() === PHILO_ACCOUNT) return;

    const _fmsg = String(message || "").trim().toLowerCase();
    // ⛔ ANOTHER BOT'S COMMAND IS NOT CHAT (Max, 30 Aug 2026).
    // [observed live 17:51] Max typed "!philo" and Mind_B0t answered it -- "Ooh,
    // philosophical vibes incoming!" -- because the message came from a HUMAN and was
    // not directed at Mind_B0t, so it reached the reply-to-undirected-comments path.
    // The bot-to-bot guard above cannot catch this: the sender is Max, not Philo_B0t.
    // ⇒ A command addressed to another bot is traffic, not conversation. Named
    //   commands only -- NOT all "!" messages, because those include StreamElements
    //   commands and Mind_B0t's own !song.
    if (FOREIGN_COMMANDS.some(c => _fmsg === c || _fmsg.startsWith(c + " "))) return;

    // ⛔ A MESSAGE ADDRESSED TO PHILO_B0T IS NOT ADDRESSED TO YOU (Max, 30 Aug 2026:
    // "mind_b0t needs to not respond to any comments addressing philo_bot as that
    // gets confusing").
    // [observed live 18:20] Max typed "@pb tell us about Hiss" and Mind_B0t answered
    // it — @pb is Philo_B0t's trigger, so to Mind_B0t it read as an ordinary
    // undirected comment and reached the reply path. Two bots answering one question
    // is the confusion.
    // ⚠ UNLESS IT ALSO ADDRESSES YOU. "@mb and @pb, thoughts?" is addressed to both,
    // and going silent there would be a worse bug than the one being fixed.
    if (PHILO_TRIGGER_REGEX.test(message) && !TRIGGER_REGEX.test(message)) return;

    // First-message-of-stream welcome. ⛔ Does NOT return — the message must
    // still reach command handling below. Max wants the command answered too;
    // the welcome's own 5s delay is what puts it second.
    chatWelcome.onMessage(channel, user, message);

    // Topic commands, checked before the general command parsing below. Matches
    // on the first token only, so an ordinary chat line costs one lookup.
    if (await topicCommands.onMessage(channel, user, message)) return;

    const _msg = message.trim().toLowerCase();

    // !song (post-S3 enrichment, 3 Jul 2026) — now a Claude-enriched answer instead
    // of a bare "Now playing: ..." string, since the artist/track are already on
    // Max's screen. Now respects the kill switch AND the shared cooldowns (it's an
    // LLM call now, sharing the same rate-limit maps as the trigger path) — no
    // longer exempt. Trailing text after "!song" (e.g. "!song foo") is ignored,
    // same as before.
    if (_msg === "!song" || _msg.startsWith("!song ")) {
        if (!_botEnabled) return; // kill switch: silent, same as the trigger path
        if (_cooldownActive(user.username)) return; // rate-limited: drop silently
        _markFired(user.username);

        const t = serato ? serato.nowPlaying() : null;
        if (!t) {
            // No live set — plain fallback, no Claude call.
            bot.say(channel, "No track is playing right now.");
            return;
        }

        const songText = "[Now playing on stream: " + t + "] A viewer used the !song command — tell the chat what's playing and give your take on this track.";
        const songResponse = await claude_ops.make_claude_call(songText);

        // split response if it exceeds twitch chat message length limit
        // send multiples messages with a delay in between (same splitter as the trigger path)
        if (songResponse.length > MAX_LENGTH) {
            const songMessages = chunkText(songResponse, MAX_LENGTH);
            songMessages.forEach((message, index) => {
                setTimeout(() => {
                    bot.say(channel, message);
                }, 1000 * index);
            });
        } else {
            bot.say(channel, songResponse);
        }
        return;
    }

    // Stage 3 — kill switch. Mod/broadcaster-only; short-circuits before the
    // trigger check. Non-mods invoking it are ignored silently.
    if (_msg === "!mbstop" || _msg === "!mbstart") {
        if (!_isModOrBroadcaster(user)) return;
        _botEnabled = (_msg === "!mbstart");
        console.log(`[mind_b0t] Claude trigger path ${_botEnabled ? "ENABLED" : "DISABLED"} by ${user.username}`);
        return;
    }

    // S3 nit fix: gate behind the kill switch (and the shared cooldowns) so !mbstop
    // mutes this path too — previously it called Claude unconditionally whenever
    // channel points were enabled. Off by default (ENABLE_CHANNEL_POINTS), so no
    // live-impact change unless Max turns channel points on.
    if (_botEnabled && ENABLE_CHANNEL_POINTS) {
        console.log(`The message id is ${user["msg-id"]}`);
        if (user["msg-id"] === "highlighted-message" && !_cooldownActive(user.username)) {
            _markFired(user.username);
            console.log(`The message is ${message}`);
            const response = await claude_ops.make_claude_call(message);
            bot.say(channel, response);
        }
    }

    // Stage 3 — broader triggering: fire on any trigger token appearing
    // anywhere in the message (replaces the old prefix-only COMMAND_NAME
    // startsWith match). Gated by the kill switch and the silent cooldowns.
    // ⛔ Computed ONCE and reused below. A message that mentioned Mind_B0t must not
    // also fall through to the unsolicited-reply path at the end of this handler —
    // the trigger block does not return on its success path, so without this flag the
    // bot answers a mention and then answers it AGAIN. Live that is masked by the idle
    // cooldown; OFFLINE, where replies are ungated, it would double-post every time.
    // (TRIGGER_REGEX is deliberately non-global, so .test() is stateless and safe to
    // reuse — see the note on TRIGGER_REGEX_STRIP_ALL above.)
    const _wasDirected = TRIGGER_REGEX.test(message);

    if (_botEnabled && _wasDirected) {
        // ⛔⛔ NO COOLDOWN CHECK HERE — Max, 21 Aug 2026: "Mind_b0t can always reply to
        // direct comments to it, or direct replies to it, there shold be no limit for
        // that." The `_cooldownActive` gate that stood here was removed on that ruling.
        // ⚠ He was told what it was doing first: every trigger is a Claude call, and
        // this was the only thing bounding how many a busy chat can spend. Ten people
        // mentioning the bot cost one call before and cost ten now. That is his call.
        //
        // ⚑ _markFired is KEPT so the OTHER cooldowned paths (!song, topic commands)
        // still see this as recent activity. Raised with Max 21 Aug 2026; he left it to
        // this seat ("go with your recomendation") and it stays.
        // ⇒ The consequence, stated so nobody re-opens it blind: mentioning Mind_B0t
        // still suppresses that user's own !song briefly. That is COOLDOWN_PER_USER_SEC
        // = 10s and COOLDOWN_GLOBAL_SEC = 5s, not the 2-minute idle cooldown — the two
        // are unrelated, and conflating them is what made this look worth changing.
        _markFired(user.username);

        // Strip the matched trigger token so Claude gets a clean message.
        let text = message.replace(TRIGGER_REGEX_STRIP_ALL, "").replace(/\s+/g, ' ').trim();

        // "SO <name>" is a real command now, with the same profile fetch the raid
        // path uses, instead of six words handed to a generic chatbot (14 Aug 2026).
        // ⛔ Checked AFTER the token is stripped — the raw message still contains
        // the trigger, and matching against that would need the pattern to know
        // about trigger tokens, which is the wrong module's business.
        // ⚠ _markFired has already run above, so the shoutout path must NOT mark
        // again; one message must cost one cooldown, not two.
        if (await shoutout.onTriggered(channel, user, text)) return;

        if (SEND_USERNAME) {
            text = "Message from user " + user.username + ": " + text
        }

        // music-aware: prepend the current track if a set is live
        const _np = serato ? serato.nowPlaying() : null;
        if (_np) {
            text = "[Now playing on stream: " + _np + "] " + text;
        }

        // make claude call
        const response = await claude_ops.make_claude_call(text);

        // split response if it exceeds twitch chat message length limit
        // send multiples messages with a delay in between
        if (response.length > MAX_LENGTH) {
            const messages = chunkText(response, MAX_LENGTH);
            messages.forEach((message, index) => {
                setTimeout(() => {
                    bot.say(channel, message);
                }, 1000 * index);
            });
        } else {
            bot.say(channel, response);
        }
    }

    // ⇒ NOT directed at Mind_B0t. During a quiet stretch it answers anyway (Max,
    // 21 Aug 2026: "reply to a new comment made by another chatter when it happens").
    //
    // ⛔⛔ THE GUARD IS LOAD-BEARING, NOT DEFENSIVE. The trigger block above does NOT
    // return on its success path, so reaching this line does not mean the message was
    // unaddressed. An earlier version of this comment asserted that it did, and it was
    // simply wrong: a mention would be answered by the trigger path and then answered
    // again here. Live the idle cooldown hides it (bot.say -> markSpoke fires first);
    // offline, where replies are ungated by design, it double-posts every time.
    //
    // ⚠ NOT awaited — a Claude call must not delay the handler returning, exactly as
    // the welcome path avoids blocking !song behind one. It swallows its own errors.
    if (!_wasDirected) idleChatter.maybeReplyTo(channel, user, message);
});

app.ws('/check-for-updates', (ws, req) => {
    ws.on('message', (message) => {
        // Handle WebSocket messages (if needed)
    });
});

// setup bot
const messages = [
    {role: "system", content: "You are a helpful Twitch Chatbot."}
];

console.log("GPT_MODE is " + GPT_MODE)
console.log("History length is " + HISTORY_LENGTH)
console.log("Model Name:" + MODEL_NAME)

app.use(express.json({extended: true, limit: '1mb'}))
app.use('/public', express.static('public'))

app.all('/', (req, res) => {
    console.log("Just got a request!")
    res.render('pages/index');
    //res.sendFile(process.env.RENDER_SRC_ROOT + '/index.ejs')
    //res.send('Yo!')
})

if (process.env.GPT_MODE === "CHAT"){
    fs.readFile("./file_context.txt", 'utf8', function(err, data) {
        if (err) throw err;
        console.log("Reading context file and adding it as system level message for the agent.")
        messages[0].content = data;
    });
} else {
    fs.readFile("./file_context.txt", 'utf8', function(err, data) {
        if (err) throw err;
        console.log("Reading context file and adding it in front of user prompts:")
        file_context = data;
        console.log(file_context);
    });
}

app.get('/gpt/:text', async (req, res) => {

    //The agent should receive Username:Message in the text to identify conversations with different users in his history.
    const text = req.params.text

    // define function to check history length and perform bot response
    const answer_question = async (answer) => {
        if (answer.length > MAX_LENGTH) {
            const messages = chunkText(answer, MAX_LENGTH);
            messages.forEach((message, index) => {
                setTimeout(() => {
                    bot.say(channel, message);
                }, 1000 * index);
            });
        } else {
            bot.say(channel, answer);
        }
    }

    let answer = ""
    if (GPT_MODE === "CHAT") {
        //CHAT MODE EXECUTION
        answer = await claude_ops.make_claude_call(text);
    } else if(GPT_MODE === "PROMPT") {
        //PROMPT MODE EXECUTION

        // create prompt based on file_context and the user prompt
        let prompt = file_context;
        prompt += "\n\nUser: " + text + "\nAgent:"
        answer = await claude_ops.make_claude_call_completion(prompt);
    } else {
        //ERROR MODE EXECUTION
        console.log("ERROR: GPT_MODE is not set to CHAT or PROMPT. Please set it as environment variable.")
    }

    // send response
    await answer_question(answer)

    res.send(answer)
})

// make app always listening to twitch chat and get new messages starting with !gpt on port 3000
const server = app.listen(3000, () => {
    console.log('Server running on port 3000');
});

const wss = expressWsInstance.getWss();
// const wss = appWithWebSocket.ws

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        // Handle client messages (if needed)
    });
});

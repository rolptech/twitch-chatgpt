import express from 'express';
import fs from 'fs';

import expressWs from 'express-ws';

import {job} from './keep_alive.js';

import {ClaudeOperations} from './claude_operations.js';
import {SeratoOperations} from './serato_operations.js';
import {TwitchBot} from './twitch_bot.js';
import {fetchRaiderProfile, cleanTitle, cleanDescription, relativeTimePhrase, extractPanelText} from './twitch_profile.js';
import {createSubThanks} from './sub_thanks.js';

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
const TRIGGER_TOKENS = ["@Mind_B0t", "mindbot", "mindb0t", "mind_b0t", "mind_bot", "@mb"];

function _triggerTokenToPattern(tok) {
    const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // defensive; no metachars in current tokens
    const lead = esc.startsWith("@") ? "(?<![\\w@])" : "\\b"; // "@token" must not be glued to a preceding word char or another "@"
    const trail = "\\b(?!\\.\\w)"; // standard word boundary, but refuse to match into a ".tld"-shaped URL/domain suffix
    return `${lead}${esc}${trail}`;
}

const TRIGGER_REGEX = new RegExp(TRIGGER_TOKENS.map(_triggerTokenToPattern).join("|"), "i");
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
function _buildRaidPrompt(username, viewers, profile) {
    const lines = [`[RAID] ${username} just raided the channel with ${viewers} viewers.`];

    if (profile) {
        const description = cleanDescription(profile.description);
        if (description) {
            lines.push(`[About them: ${description}]`);
        }

        // Panel text is deliberately UNFILTERED beyond mechanical cleanup —
        // see the long note in twitch_profile.js. The instruction below is
        // the filter, and it has to stay attached to the data: three regex
        // classifiers were tried first and all of them shipped gear lists and
        // donation pitches into shoutouts. Claude does this reliably; regex
        // does not.
        const panelText = extractPanelText(profile.panels);
        if (panelText) {
            lines.push(
                `[Raw text from their channel panels — may include chat rules, gear lists, ` +
                `donation appeals or link labels. Use ONLY what genuinely describes them as ` +
                `a DJ/streamer (genre, aliases, what they play, where they're from). Ignore ` +
                `everything else, and never repeat donation appeals or link names: ${panelText}]`
            );
        }

        if (profile.stream && profile.stream.id) {
            lines.push(`[They are LIVE right now.]`);
        }

        const lastBroadcast = profile.lastBroadcast;
        const title = lastBroadcast ? cleanTitle(lastBroadcast.title) : "";
        if (title) {
            const category = lastBroadcast.game && lastBroadcast.game.name
                ? ` in ${lastBroadcast.game.name}`
                : "";
            const when = relativeTimePhrase(lastBroadcast.startedAt);
            const whenPart = when ? `, ${when}` : "";
            lines.push(`[Their last stream: "${title}"${category}${whenPart}]`);
        }
    }

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
        const messages = response.match(new RegExp(`.{1,${MAX_LENGTH}}`, "g"));
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

bot.onMessage(async (channel, user, message, self) => {
    if (self) return;

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
            const songMessages = songResponse.match(new RegExp(`.{1,${MAX_LENGTH}}`, "g"));
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
    if (_botEnabled && TRIGGER_REGEX.test(message)) {
        if (_cooldownActive(user.username)) return; // rate-limited: drop silently, post nothing

        _markFired(user.username);

        // Strip the matched trigger token so Claude gets a clean message.
        let text = message.replace(TRIGGER_REGEX_STRIP_ALL, "").replace(/\s+/g, ' ').trim();

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
            const messages = response.match(new RegExp(`.{1,${MAX_LENGTH}}`, "g"));
            messages.forEach((message, index) => {
                setTimeout(() => {
                    bot.say(channel, message);
                }, 1000 * index);
            });
        } else {
            bot.say(channel, response);
        }
    }
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
            const messages = answer.match(new RegExp(`.{1,${MAX_LENGTH}}`, "g"));
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

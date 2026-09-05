// map_promo.js — Mind_B0t says one fact about The Twitch DJ Network Map roughly every
// 15 minutes, unprompted, while the stream is live.
//
// ⛔⛔ THIS IS DELIBERATELY NOT idle_chatter, AND THE DIFFERENCE IS THE WHOLE POINT.
//   idle_chatter speaks only when chat has gone QUIET, and doubles its own cooldown every
//   time it speaks (4 → 8 → 16 → 32 min) because Max asked in August for less unprompted
//   talking. ⇒ A map fact on that mechanism would appear a few times an hour at best, only
//   into silence, and less often the longer the stream ran.
//   ⇒ Max, 4 Sep 2026, told this: "this will be temporary, but yes for now I want it
//     actively promoting the map in that fashion". ⇒ Fixed cadence, busy chat or not.
//
// ⚠ TEMPORARY BY HIS WORD. To switch it off: set MAP_PROMO_ENABLED=false in Render, or
//   delete the createMapPromo block in index.js. Nothing else depends on this file.
//
// WHAT IT DOES NOT DO, each for a reason:
//   ⛔ It does not run when the stream is OFFLINE. Promoting to an empty room posts into
//     nothing and would run all night, every night.
//   ⛔ It does not ignore !mbstop. A kill switch that some paths honour and others do not
//     is not a kill switch — that lesson is already in this repo's history.
//   ⛔ It does not talk over itself. If the bot has spoken very recently the tick is
//     skipped rather than queued, so a promo never lands on the back of a shoutout.
//   ⛔ It does not let the model invent the fact. Claude is handed ONE fact, verbatim,
//     and asked to say it in character. The facts below are Max's own published words.

// ⛔⛔ EVERY FACT HERE IS PUBLIC — each one is on djnetworkmap.com, in its Questions or
//   How-it-works copy. Nothing internal, nothing measured, nothing unpublished.
//   ⇒ IF YOU ADD ONE, IT MUST ALREADY BE ON THE SITE. The bot is the site's voice in
//     chat, not a second source that knows more than the site does.
//   ⚠ AND NO COUNTS. "6,169 DJs" is true for one build and wrong after the next.
const FACTS = [
    "The map shows the DJs streaming on Twitch and how they are connected to each other.",
    "Connection strength on the map comes from public signals — raids, shoutouts, mod and VIP status, shelf endorsements, shared teams, and more.",
    "On the map, recent activity counts for more than old activity.",
    "A dot's inner colour is the cluster a DJ belongs to; the ring around it is their genre family.",
    "The big names you see zoomed out mark what a neighbourhood has in common — not what everyone under them is.",
    "Genres on the map come from stream titles and tags, so what you put in your own title shapes where you land.",
    "The map changes over time as new data comes in — DJs move, connections appear and fade.",
    "Where a DJ sits is a snapshot of what was known on the build date, not a fixed address.",
    "To be drawn, a DJ has to be in the Twitch DJ program and stream often enough, to enough people, over the last year.",
    "You can search a DJ by name, then add a second name to see the connections the two of them share.",
    "There is a DJ MAP mode that shows one DJ's own personal network map.",
    "Every position on the map is computed — the layout is worked out by the maths, not decided.",
    "It is a hobby project, it is free, and it will never be commercialised.",
    "The map is for entertainment purposes only, and it is built by statistical methods whose accuracy cannot be guaranteed.",
    "The map is made for a computer screen — on a phone the controls are too small to use.",
];

const URL = "djnetworkmap.com";

const DEFAULT_INTERVAL_SEC = 900;   // 15 minutes, Max's number
const DEFAULT_JITTER_SEC = 180;     // ⇒ "around every 15 minutes" — 12 to 18, never on the clock
const DEFAULT_QUIET_AFTER_SPEAKING_SEC = 60;
const DEFAULT_TICK_SEC = 15;

export function createMapPromo({
    say,
    claudeCall,
    isEnabled,          // ⇒ !mbstop
    isLive,
    sayChunkedFn,
    maxLength,
    lastSpokeAt,        // () => epoch ms of the bot's last message, from index.js's say() wrapper
    log = console.log,
    intervalSec = DEFAULT_INTERVAL_SEC,
    jitterSec = DEFAULT_JITTER_SEC,
    quietAfterSpeakingSec = DEFAULT_QUIET_AFTER_SPEAKING_SEC,
    tickSec = DEFAULT_TICK_SEC,
    enabled = true,
    random = Math.random,
    now = () => Date.now(),
} = {}) {
    let _timer = null;
    let _channel = null;
    let _nextDue = 0;
    let _inFlight = false;

    // ⛔ SHUFFLED QUEUE, NOT A RANDOM PICK. A random pick repeats within a few draws and
    //   the same viewers are in chat all night — they notice. This plays every fact once
    //   before any repeats, and reshuffles when the pack runs out.
    let _bag = [];

    function _nextFact() {
        if (_bag.length === 0) {
            _bag = FACTS.map((_, i) => i);
            for (let i = _bag.length - 1; i > 0; i--) {
                const j = Math.floor(random() * (i + 1));
                [_bag[i], _bag[j]] = [_bag[j], _bag[i]];
            }
        }
        return FACTS[_bag.pop()];
    }

    function _schedule() {
        const jitter = Math.floor((random() * 2 - 1) * jitterSec * 1000);
        _nextDue = now() + intervalSec * 1000 + jitter;
    }

    async function _fire() {
        if (_inFlight) return false;
        _inFlight = true;
        try {
            const fact = _nextFact();
            // ⇒ The fact is handed over verbatim and the model is told to relay it, not to
            //   elaborate. It knows about the map from file_context.txt; this stops it
            //   reaching for anything it half-remembers and stating it as fact.
            const prompt =
                `Nobody asked. Unprompted, tell the chat about Mind_Prime's website ` +
                `The Twitch DJ Network Map at ${URL}, using EXACTLY this fact and adding ` +
                `no other claims about the map: "${fact}" ` +
                `Say it in your own voice, keep it short, and include the address ${URL}.`;
            const response = await claudeCall(prompt);
            if (!response) return false;

            // ⛔ THE ADDRESS IS GUARANTEED IN CODE, NOT LEFT TO THE MODEL. A promo that
            //   drops or mangles the URL is the one failure that makes the whole thing
            //   pointless, and it would look like a good message.
            const text = response.includes(URL) ? response : `${response} ${URL}`;

            if (sayChunkedFn) sayChunkedFn(say, _channel, text, maxLength);
            else say(_channel, text);
            log(`[map_promo] posted a map fact`);
            return true;
        } catch (err) {
            // Fail-quiet: ambient promotion is never worth surfacing to chat.
            log(`[map_promo] suppressed error: ${err && err.message}`);
            return false;
        } finally {
            _inFlight = false;
        }
    }

    async function _tick() {
        if (!enabled) return;
        if (!_channel) return;
        if (isEnabled && !isEnabled()) return;   // !mbstop
        if (isLive && !isLive()) return;         // offline: do not post into an empty room
        if (now() < _nextDue) return;

        // ⇒ Skip, do not queue. If the bot has just spoken, the promo waits for the next
        //   window rather than stacking a second message onto the first.
        if (lastSpokeAt) {
            const since = now() - (lastSpokeAt() || 0);
            if (since < quietAfterSpeakingSec * 1000) return;
        }

        _schedule();
        await _fire();
    }

    function start(channel) {
        if (!enabled) {
            log(`[map_promo] disabled — not starting`);
            return;
        }
        _channel = channel;
        _schedule();
        if (_timer) clearInterval(_timer);
        _timer = setInterval(() => { _tick().catch(() => {}); }, tickSec * 1000);
        if (_timer.unref) _timer.unref();
        log(`[map_promo] started on ${channel} — every ~${intervalSec / 60} min, live only`);
    }

    function stop() {
        if (_timer) clearInterval(_timer);
        _timer = null;
        _channel = null;
    }

    return {start, stop, _tick, _nextFact, FACTS};
}

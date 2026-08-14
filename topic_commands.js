// topic_commands.js
//
// !kosmische · !berlinschool · !artists · !tranceroots
//
// Moved off StreamElements 14 Aug 2026 (Max: "I want to make those mind_b0t
// commands instead"). On SE these were fixed strings; here they are generated
// fresh each time.
//
// ---------------------------------------------------------------------------
// ⛔ HOW MUCH MAY VARY — Max ruled this in three steps and the final shape is
// NOT one of the two options I put to him.
//
// I offered: (a) his text fixed, only phrasing varies — which I recommended and
// he picked; (b) free rein. He overrode (a) at once — "wait, I want some variety
// to the facts too." I then asked whether his text was a FLOOR every answer must
// cover, or a SEED it could wander from. He rejected that framing too:
//
//   "you should be able to provide enough context in the prompt for Claude to
//    choose facts that don't go too far afield"
//
// ⇒ ⭐ So the control is neither a required core nor an open field. It is SCOPE.
// Each topic below carries `inScope` and `drift`, and the prompt spends its words
// describing the TERRITORY rather than listing permitted facts. Claude picks
// freely inside a well-drawn fence.
//
// ⛔ WHY THAT IS ACTUALLY THE RIGHT ANSWER, not just his preference: a floor
// makes every answer repeat the same opening for regulars, and a bare seed drifts
// — !kosmische wanders into Can's funk end, or general ambient history, and stops
// being about the thing the command names. Scope fixes the failure both options
// have, from opposite directions.
//
// ⛔ WHAT DOES NOT VARY IS TRUTHFULNESS. "Vary which facts you surface" is not
// "vary the facts". The prompt draws that line in terms, because the failure it
// prevents is a confident invented album title or date going out in Max's chat
// under his name, to an audience that came for exactly this subject and will
// know. He accepted the risk of unvetted claims; he did not ask for fiction,
// and those are different things.
//
// ⇒ If a future change loosens the accuracy clause or widens `drift`, that is a
// decision, not a tidy-up. It needs him.
//
// ---------------------------------------------------------------------------
// LENGTH: "make it 50% longer than the SE responses" (Max, 14 Aug 2026).
// DERIVED per command from its own anchor rather than hardcoded, because the
// four originals are not the same size — !berlinschool and !tranceroots are
// ~495 chars, !artists ~355 — so one fixed number would stretch two of them and
// crop the others. Deriving it also keeps the target correct if he edits an
// anchor later, instead of silently drifting from a constant nobody updates.
//
// ⚠ CONSEQUENCE HE SHOULD EXPECT: 1.5x lands most of these ABOVE this bot's
// MAX_LENGTH of 399, so they arrive as TWO chat messages a second apart. The SE
// versions were single messages. This is the splitter every Claude path already
// uses — the raid shoutouts read the same way — not a fault.
//
// COOLDOWNS: these keep the SAME 5s global / 15s per-user shape SE had, via the
// injected cooldown hooks. ⚠ That is preserving existing behaviour, not adding
// a rule — Max's "no cooldown" instruction was about follows and bits, which
// fire on events nobody can spam. These are viewer-typed commands, and !song
// (the existing command path) is gated the same way.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_LENGTH = 399;

// Max's StreamElements text, verbatim as of 14 Aug 2026, except where noted.
export const TOPICS = {
    "!kosmische": {
        focus: "Kosmische Musik — what it is, where and when it came from",
        anchor: 'Kosmische Musik is a broad, overarching term for the experimental music scene that emerged across West Germany in the late 1960s and early 1970s. It was originally coined in 1971 by Edgar Froese of Tangerine Dream. While often used interchangeably with "Krautrock," Kosmische specifically emphasizes "spacy" ambient soundscapes, themes of otherworldliness.',
        inScope: "the West German experimental scene of roughly 1968-1978 and its cosmic/synthesizer end: the artists, records, studios, labels and producers of that scene; how the term relates to and differs from Krautrock; the gear and studio methods that made the sound; the places it happened",
        drift: "the rock and funk end of Krautrock where that is the whole answer rather than a contrast; ambient history that is not German and not of this period; modern electronic or EDM lineage, which is what !tranceroots is for",
    },
    "!berlinschool": {
        focus: "Berlin School — its defining musical characteristics",
        anchor: 'Berlin School is centered primarily on Berlin-based artists like Tangerine Dream & Klaus Schulze, defined by a heavy reliance on analog step-sequencers to create hypnotic, multi-layered rhythmic patterns that evolve slowly over long-form compositions. Berlin School tracks often use the "pulsing" nature of the synthesizers themselves to drive the rhythm, and are characterized by a "spacey" and meditative atmosphere that served as a direct precursor to modern ambient, trance, and new-age music.',
        inScope: "what the music actually DOES — sequencer patterns, gear, structure, how a long piece unfolds, the specific records that define it, and the artists working in that idiom then and since",
        drift: "general ambient or new-age history with no sequencer lineage; roll-calls of artists with nothing about the music, which is what !artists is for",
    },
    "!artists": {
        // ⚠ "Michael Honig" in the SE original is corrected to "Michael Hoenig"
        // here (Tangerine Dream; "Departure from the Northern Wasteland").
        // Flagged to Max 14 Aug 2026 and not objected to. Seeding the misspelling
        // would have taught it to the generator on every firing.
        focus: "the artists of the Kosmische/Berlin School sound, original and next-generation",
        anchor: "The Kosmische/Berlin School sound was defined by German acts like Klaus Schulze, Tangerine Dream/Edgar Froese, Ashra, Harald Grosskopf, Michael Hoenig and fellow travelers Jean-Michel Jarre, Vangelis, and Brian Eno. Next Gen Berlin School artists include Steve Roach, Pete Namlook, Martin Sturtzer, Node, Mark Shreeve/Redshift, Kitaro, and many others.",
        inScope: "people who actually made this music — the original German figures, their fellow travellers, and the later artists genuinely working in the idiom; a defining record or a line about what each one brought is better than a bare list",
        drift: "artists from adjacent genres with no real Kosmische/Berlin School connection; padding the list with modern EDM or trance names, which belong in !tranceroots",
    },
    "!tranceroots": {
        focus: "how Kosmische/Berlin School prefigured and influenced Trance",
        anchor: "Kosmische/Berlin School music's use of long-form, hypnotic sequencing, gradual harmonic evolution, repetitive arpeggios and slowly unfolding structures prefigured Trance's build-and-release logic and sense of ecstatic drift. Trance artists such as Cosmic Baby, Paul van Dyk, Sasha, Talla 2XLC, L.S.G., and Solarstone have explicitly cited Berlin School influences, translating its analog futurism and motorik pulse into club-oriented, beat-driven forms while preserving its transcendental intent.",
        inScope: "the LINE between the two — structural inheritance (sequencing, build-and-release, long-form), artists who have explicitly cited the influence, and the German and Frankfurt/Berlin routes by which it travelled into club music",
        drift: "general trance history with no Berlin School thread running through it; describing either genre on its own, which is what the other three commands are for",
    },
};

// Max asked for "50% longer than the SE responses". Rounded to the nearest 10
// so the prompt reads as a target rather than spurious precision.
export function _targetChars(command) {
    const a = TOPICS[command];
    if (!a) return 0;
    return Math.round((a.anchor.length * 1.5) / 10) * 10;
}

export function matchTopic(message) {
    if (typeof message !== "string") return null;
    const first = message.trim().toLowerCase().split(/\s+/)[0];
    return Object.prototype.hasOwnProperty.call(TOPICS, first) ? first : null;
}

export function createTopicCommands({
    say,
    claudeCall,
    isEnabled = () => true,
    cooldownActive = () => false,   // (username) => boolean
    markFired = () => {},           // (username) => void
    maxLength = DEFAULT_MAX_LENGTH,
    log = console.log,
    setTimeoutFn = setTimeout,
} = {}) {
    if (typeof say !== "function") throw new Error("createTopicCommands requires a `say` function");
    if (typeof claudeCall !== "function") throw new Error("createTopicCommands requires a `claudeCall` function");

    function _buildPrompt(command) {
        const t = TOPICS[command];
        return [
            `A viewer in a Twitch DJ stream typed ${command}. The streamer plays this music live; the people reading know the genre. Answer it: explain ${t.focus}.`,
            `The channel's own reference text on this topic — ACCURATE, and it sets the depth and register:`,
            `---\n${t.anchor}\n---`,
            `⭐ Do NOT paraphrase that back. Write a FRESH answer every time and vary the SUBSTANCE, not just the wording: lead with a different aspect and bring in different artists, records or details than the reference uses. Someone firing this twice in a night should learn something new the second time.`,
            `IN SCOPE — choose freely from: ${t.inScope}.`,
            `⛔ TOO FAR AFIELD — do not drift into: ${t.drift}.`,
            `⛔ Vary WHICH TRUE FACTS you surface — never invent one. No made-up album titles, dates, personnel or quotes. If you are not confident something is correct, leave it out and say something you are sure of instead. This goes out in the streamer's chat under his name, to an audience that will notice.`,
            `Aim for about ${_targetChars(command)} characters — roughly half again as long as the reference text, so use the extra room for substance rather than padding. No lists, no links, no markdown. Conversational, knowledgeable, enthusiastic without being breathless.`,
        ].join("\n");
    }

    function _sayChunked(channel, text) {
        if (text.length > maxLength) {
            const parts = text.match(new RegExp(`.{1,${maxLength}}`, "g"));
            parts.forEach((part, index) => setTimeoutFn(() => say(channel, part), 1000 * index));
        } else {
            say(channel, text);
        }
    }

    async function onMessage(channel, user, message) {
        const command = matchTopic(message);
        if (!command) return false;
        if (!isEnabled()) return true;      // consumed, but silent — kill switch

        const username = (user && user.username) || "";
        if (cooldownActive(username)) return true;  // consumed, rate-limited, silent
        markFired(username);

        try {
            const response = await claudeCall(_buildPrompt(command));
            if (response && String(response).trim()) _sayChunked(channel, String(response).trim());
        } catch (err) {
            log("[mind_b0t] topic-command error:", err && err.message ? err.message : err);
        }
        return true;
    }

    return { onMessage, matchTopic, _buildPrompt, commands: Object.keys(TOPICS) };
}

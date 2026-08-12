// twitch_profile.js
//
// Raid-welcome profile enrichment (11 Aug 2026 work order:
// "Mind_B0t — Raid auto-shoutout + Twitch-profile enrichment").
//
// One anonymous GraphQL POST to Twitch's public gql endpoint, using the same
// public web Client-ID every scanner on the mount already uses (Max's ruling,
// 11 Aug 2026 — no app to register, nothing new to add to Render).
//
// ⛔ FAIL-OPEN CONTRACT — this is the whole point of this module. A raid is
// time-sensitive and the welcome is what matters, not the enrichment. On ANY
// failure (network error, timeout, non-2xx, malformed body, or an unknown
// login) fetchRaiderProfile() resolves `null` — it never throws, and the
// caller proceeds to the Claude call without profile context.
//
// ⛔⛔ An unknown Twitch login does NOT throw — Twitch's GQL returns
// `{"data":{"user":null}}` for it (measured 11 Aug against the live
// endpoint). A try/catch alone does not cover that path; the `?? null`
// below is load-bearing, not defensive boilerplate.

const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"; // public web client id — same value every Twitch scanner on this mount uses (see scan_shelves_api.py / scan_followers.py)
const GQL_ENDPOINT = "https://gql.twitch.tv/gql";

// ⛔ Do not raise this "to be safe" — measured 11 Aug: 43-180ms observed
// against this same budget, ~10x headroom. The budget exists to protect the
// raid welcome, not the enrichment — a raid arriving while this fetch stalls
// is exactly the case the timeout is for.
const FETCH_TIMEOUT_MS = 2000;

// ⛔ `panels` returns the INTERFACE type `Panel`, which exposes only `id` and
// `type`. The readable content lives on the concrete `DefaultPanel`, so the
// inline fragment below is REQUIRED — asking for `panels { title }` directly
// fails GraphQL validation with `Cannot query field "title" on type "Panel"`,
// and Twitch then returns a top-level `errors` array with NO `data` key.
// (Measured against the live endpoint, 11 Aug 2026.)
//
// ⚠ That failure is SILENT here by construction: `body?.data?.user` resolves
// `undefined` -> `null` -> fail-open, no enrichment, no chat error. Correct
// behaviour, but it means an edit that breaks this fragment would quietly
// strip ALL enrichment — description and last-broadcast too, not just panels.
const PROFILE_QUERY = `
query RaiderProfile($login: String!) {
  user(login: $login) {
    login
    displayName
    description
    panels {
      id
      ... on DefaultPanel {
        title
        description
      }
    }
    lastBroadcast {
      title
      startedAt
      game { name }
    }
    stream { id }
  }
}`;

// Fetch the raider's public profile. Resolves the user object on success,
// `null` on an unknown login OR any failure. Never rejects.
export async function fetchRaiderProfile(login) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const r = await fetch(GQL_ENDPOINT, {
            method: "POST",
            headers: {
                "Client-ID": CLIENT_ID,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ query: PROFILE_QUERY, variables: { login } }),
            signal: controller.signal,
        });

        if (!r.ok) return null;

        const body = await r.json();
        // data.user is null for an unknown login — not an error, just no profile.
        return body?.data?.user ?? null;
    } catch (error) {
        // Network error, abort/timeout, malformed JSON — fail open, no chat error.
        console.error("[mind_b0t] profile enrichment failed, proceeding without it:", error.message);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------------------
// Field cleaning (WO §3c) — measured against seven real channels, 11 Aug.
// Both rules below exist because of a specific observed string; both are
// deliberately conservative because fivearah's title
// ("Twitch DJs Synthwave/Indie Dance Raid Train") is clean and is the ONLY
// usable signal for that channel — a greedy strip destroys it.
// ---------------------------------------------------------------------------

// Strip @handles from anywhere in the string. Example that forced this rule:
// vlouue's live title "STUDIOO AND @decentraland / …" — echoing that pings
// an unrelated account from Max's channel.
function _stripHandles(text) {
    return text.replace(/@\w+/g, "").replace(/\s{2,}/g, " ").trim();
}

// Strip a TRAILING run of command/hashtag/exclaim-wrapped noise tokens —
// e.g. "!latexfund !wtf !socials !tip", "#808 #808ONTWITCH",
// "❗DCL❗EXTRA❗SUPPORT". Deliberately trailing-only and deliberately narrow
// so ordinary title text is never touched — this is what keeps fivearah's
// title intact.
//
// A token counts as noise if it STARTS with !, # (commands/hashtags are
// always prefix-shaped), OR CONTAINS ❗ anywhere. The ❗-contains widening
// was needed against real data: vlouue's live title on 11 Aug was actually
// "...LA DJ QUEBECOISE  😈❗DCL❗EXTRA❗SUPPORT" — the emoji ❗ block, i.e. the
// exact noise string named in the work order, glued to a leading 😈 with no
// separating space, so a strict startsWith(❗) missed the whole token. ❗ is
// specific enough (a heavy-exclamation emoji, not the ASCII "!") that
// "contains" doesn't risk ordinary title punctuation the way it would for
// "!" or "#".
function _stripTrailingNoise(text) {
    const tokens = text.split(/\s+/).filter(Boolean);
    const isNoise = (tok) => /^[!#]/.test(tok) || tok.includes("❗");
    while (tokens.length && isNoise(tokens[tokens.length - 1])) {
        tokens.pop();
    }
    return tokens.join(" ").trim();
}

// Clean up a dangling separator left behind after handle/noise removal
// (e.g. "STUDIOO AND / …" -> trailing "/" with nothing after it).
function _stripTrailingSeparators(text) {
    return text.replace(/[\s/|,-]+$/g, "").trim();
}

export function cleanTitle(title) {
    if (!title) return "";
    let t = _stripHandles(title);
    t = _stripTrailingNoise(t);
    t = _stripTrailingSeparators(t);
    return t;
}

// Truncate only — observed description length range was 0-256 chars, so this
// is a guard against an outlier, not a transform (WO §3c).
export function cleanDescription(description, maxLen = 300) {
    if (!description) return "";
    const d = description.trim();
    return d.length > maxLen ? d.slice(0, maxLen).trim() : d;
}

// ---------------------------------------------------------------------------
// Panel ("About" section) bio extraction.
//
// WHY THIS EXISTS: `description` is a single short field and plenty of DJs
// leave it thin or generic while putting the real substance in a panel.
// Measured case that motivated the build — cephy__, 11 Aug 2026:
//   description : "Purveyor of the unheard- Dj, musician, poet, writer, gamer..."
//   panel[0]    : "...I am a *musician* and *DJ* within the **ebm/gothic**
//                  music genre. I record music under the names Cephy, N.0V8
//                  and Beneath Stygian wings. Available for remixes..."
// The genre, the aliases and the collab hook are ALL panel-only.
//
// ⛔ MEASURED YIELD, 59 channels sampled at random from the 12,246-name spine:
// 43/59 have any panel at all, and 24/59 (41%) yield any usable text. This is
// EXPECTED to return "" for most raiders — not a failure; the prompt builder
// simply omits the line.
//
// ⛔⛔ THIS FUNCTION DOES NOT DECIDE WHAT A BIO IS. It does mechanical cleanup
// only — flatten markdown, drop bullet-lists, drop shorts, cap length — and
// hands the rest to Claude, which is already in the loop and is told in the
// prompt to use only what describes the streamer.
//
// That split was arrived at by measurement, not preference. Three heuristic
// bio-classifiers were built and tested against the 59-channel sample on
// 11 Aug 2026:
//   list-guard only          39% coverage — picked promo panels, DIY
//                                           changelogs, "go follow my team"
//   + first-person >= 2      10% coverage — picked PC spec lists and a
//                                           donation pitch; 3 of 6 were bios
//   + second-person penalty  14% coverage — same failures
// ⇒ Every added rule was individually correct and the output stayed wrong,
// which means the MECHANISM was wrong: a regex cannot tell a bio from a gear
// list, and the model trivially can. Cost of handing it over: ~128 prompt
// tokens vs ~75. ⚠ Do not "improve" this by adding a classifier back.
// ---------------------------------------------------------------------------

const PANEL_SCAN_DEPTH = 3;   // panels past the third are consistently links/socials/schedules
// ⚠ Counts ALL words, deliberately. An earlier version counted only words of
// >2 chars to avoid inflating on "I am a" — but that discards "DJ", which is
// the single most informative token a DJ's bio can contain, and it dropped
// "I am a DJ from Sydney playing happy hardcore and UK hardcore" entirely.
// Measured on the 59-channel sample: >2-char>=8 and all-words>=10 give the
// SAME 24/59 coverage, and all-words keeps that sentence. Same yield, fewer
// false drops, simpler rule.
const PANEL_MIN_WORDS = 10;   // below this it's a caption or a link label — not worth the tokens
const PANEL_MAX_CHARS = 500;

// Markdown -> flat prose. Panels are markdown and a raw dump reads as noise to
// Claude: image blobs, URL soup, blockquote carets.
function _flattenPanelMarkdown(text) {
    return text
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")   // images: drop entirely
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links: keep the label, drop the URL
        .replace(/https?:\/\/\S+/g, " ")         // bare URLs
        .replace(/^\s*>+\s?/gm, "")              // blockquote carets (cephy__ wraps his bio in one)
        .replace(/[*_`~]/g, "")                  // emphasis / code marks
        .replace(/\s+/g, " ")
        .trim();
}

// The one content rule that IS mechanical and does survive: bullet-shaped
// panels are never prose about the streamer. Chat rules, schedules, gear
// lists and socials are all bullet-shaped; bios are not. Dropping them is
// pure token saving, not judgement — Claude would have ignored them anyway.
//
// Worked case: cephy__'s panel[1] is his chat rules ("Avoid racism, sexism...
// No Bible-Thumping Soothsayers") and it has MORE words than his actual bio
// in panel[0]. Structural detection, never a keyword blacklist.
function _looksLikeList(rawText) {
    const bulletLines = rawText
        .split(/\r?\n/)
        .filter((line) => /^\s*>?\s*([-*•+]|\d+[.)])\s+/.test(line));
    return bulletLines.length >= 3;
}

// Cut to a word boundary — a mid-word truncation in the prompt reads as
// corrupted input. (Same class of problem as the shoutout that was being cut
// off mid-sentence, fixed 11 Aug in 05be366.)
function _capAtWordBoundary(text, maxLen) {
    if (text.length <= maxLen) return text;
    const cut = text.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > maxLen * 0.5 ? cut.slice(0, lastSpace) : cut).trim();
}

// Flattened text of the first few panels, joined, capped. "" when there is
// nothing worth sending. Panels are kept in the streamer's own order — that
// order is their choice and it usually puts the bio first.
export function extractPanelText(panels, {
    scanDepth = PANEL_SCAN_DEPTH,
    minWords = PANEL_MIN_WORDS,
    maxChars = PANEL_MAX_CHARS,
} = {}) {
    if (!Array.isArray(panels)) return "";

    const parts = [];
    for (const panel of panels.slice(0, scanDepth)) {
        const raw = panel && panel.description;
        if (!raw || !raw.trim()) continue;
        if (_looksLikeList(raw)) continue;

        const flat = _flattenPanelMarkdown(raw);
        if (flat.split(" ").filter(Boolean).length < minWords) continue;
        parts.push(flat);
    }
    if (!parts.length) return "";
    return _capAtWordBoundary(parts.join(" | "), maxChars);
}

// startedAt -> a relative phrase, never a raw date (WO §3d: "say 'earlier
// today' vs 'a while back'"). Observed cases: fivearah streamed 6 hours ago
// ("earlier today"); pleasanthiss streamed months ago ("a while back"). The
// WO gave those two buckets by example, not an exhaustive scale — the
// "recently" middle bucket below fills the multi-day gap between them and is
// this builder's own call, flagged in the report rather than assumed silent.
export function relativeTimePhrase(startedAt) {
    if (!startedAt) return null;
    const started = new Date(startedAt);
    if (Number.isNaN(started.getTime())) return null;
    const hoursAgo = (Date.now() - started.getTime()) / 3600000;
    if (hoursAgo < 24) return "earlier today";
    if (hoursAgo < 24 * 14) return "recently";
    return "a while back";
}

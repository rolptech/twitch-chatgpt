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

const PROFILE_QUERY = `
query RaiderProfile($login: String!) {
  user(login: $login) {
    login
    displayName
    description
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

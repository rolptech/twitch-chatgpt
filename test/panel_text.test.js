// Tests for extractPanelText (channel "About" panels -> raid-shoutout context).
//
// Fixtures are REAL panel payloads captured from Twitch's GQL endpoint on
// 11 Aug 2026, not invented shapes.

import test from "node:test";
import assert from "node:assert/strict";
import { extractPanelText } from "../twitch_profile.js";

// cephy__ — the channel this feature was built and verified against.
// panel[0] is his bio (wrapped in a markdown blockquote); panel[1] is his
// chat rules and has MORE words than the bio; panels 2-5 are empty.
const CEPHY_PANELS = [
    {
        id: "1",
        title: null,
        description:
            "> Hello, my name is **Cephy** and I am  a *musician* and *DJ* within the   **ebm/gothic** music genre.\n" +
            "I record music under the names Cephy, N.0V8 and Beneath Stygian wings. Available for remixes within these genres.",
    },
    {
        id: "2",
        title: null,
        description:
            ">- Grab yourself a nice drink!\n>- Avoid racism, sexism, and other forms of discrimination.\n" +
            ">- Avoid talking about religion or politics.\n>- Be kind.\n>- Respect other members of the community.\n" +
            ">- No Bible-Thumping Soothsayers\n>- Please don't do things that would make me make new rules.",
    },
    { id: "3", title: "Tips", description: "" },
    { id: "4", title: null, description: "" },
];

test("cephy__: keeps the bio panel and strips its blockquote/emphasis markup", () => {
    const out = extractPanelText(CEPHY_PANELS);
    assert.match(out, /my name is Cephy and I am a musician and DJ within the ebm\/gothic music genre/);
    assert.match(out, /N\.0V8 and Beneath Stygian wings/);
    assert.ok(!out.includes(">"), "blockquote carets survived");
    assert.ok(!out.includes("**"), "emphasis marks survived");
});

test("⛔ cephy__: the chat-rules panel is excluded even though it has MORE words than the bio", () => {
    const out = extractPanelText(CEPHY_PANELS);
    assert.ok(!/racism|sexism|Soothsayers|Be kind/.test(out),
        "rules panel leaked into the shoutout context");
});

test("bullet-shaped panels (rules, schedules, gear lists) are dropped; prose is not", () => {
    const gearList = [{
        id: "1",
        description: "- CPU: Ryzen 7 3700X\n- GPU: RTX 3060Ti\n- RAM: 32 GB\n- Mixer: DJM-900",
    }];
    assert.equal(extractPanelText(gearList), "");

    // Two bullets is under the threshold — still treated as prose.
    const twoBullets = [{
        id: "1",
        description: "I play liquid drum and bass every Thursday night from Manchester.\n- since 2019\n- vinyl only",
    }];
    assert.match(extractPanelText(twoBullets), /liquid drum and bass/);
});

test("markdown links keep their label, images and bare URLs are dropped", () => {
    const panels = [{
        id: "1",
        description:
            "![banner](https://static-cdn.jtvnw.net/x.png) I am a hard techno DJ from Berlin playing " +
            "every weekend, catch my sets on [My Youtube](https://youtube.com/@x) or https://soundcloud.com/x",
    }];
    const out = extractPanelText(panels);
    assert.match(out, /hard techno DJ from Berlin/);
    assert.match(out, /My Youtube/, "link label should survive");
    assert.ok(!out.includes("http"), "a URL survived into the prompt");
    assert.ok(!out.includes("banner"), "image alt text survived");
});

test("multiple prose panels are joined in the streamer's own order", () => {
    const panels = [
        { id: "1", description: "I am a DJ from Sydney playing happy hardcore and UK hardcore." },
        { id: "2", description: "I have been streaming music on this channel since early 2019, most weeknights." },
    ];
    const out = extractPanelText(panels);
    assert.match(out, /^I am a DJ from Sydney/);
    assert.ok(out.includes(" | "), "panels should be separated");
    assert.ok(out.indexOf("Sydney") < out.indexOf("2019"), "panel order not preserved");
});

test("returns '' for the no-usable-panel cases — this is the majority path, not a failure", () => {
    assert.equal(extractPanelText([]), "", "no panels");
    assert.equal(extractPanelText(undefined), "", "panels field absent");
    assert.equal(extractPanelText(null), "", "panels null");
    assert.equal(extractPanelText([{ id: "1", description: "" }]), "", "empty description");
    assert.equal(extractPanelText([{ id: "1", description: "   " }]), "", "whitespace only");
    assert.equal(extractPanelText([{ id: "1" }]), "", "no description key");
    assert.equal(extractPanelText([null, undefined]), "", "null panel entries");
    assert.equal(extractPanelText([{ id: "1", description: "Follow me!" }]), "", "too short to be worth tokens");
    assert.equal(
        extractPanelText([{ id: "1", description: "[Twitter](https://x.com/a) [Discord](https://discord.gg/b)" }]),
        "",
        "link-only panel should not qualify once URLs are stripped",
    );
});

test("only the first three panels are scanned", () => {
    const panels = [
        { id: "1", description: "- a\n- b\n- c\n- d" },
        { id: "2", description: "- a\n- b\n- c\n- d" },
        { id: "3", description: "- a\n- b\n- c\n- d" },
        { id: "4", description: "I am a DJ and this panel should never be reached by the scan." },
    ];
    assert.equal(extractPanelText(panels), "");
});

test("long panel text is capped at a word boundary, never mid-word", () => {
    const long = "I am a techno DJ ".repeat(80);
    const out = extractPanelText([{ id: "1", description: long }]);
    assert.ok(out.length <= 500, `expected <= 500 chars, got ${out.length}`);
    assert.ok(!out.endsWith(" "), "trailing whitespace");
    // The final token must be a whole word from the source, not a fragment.
    const lastWord = out.split(" ").pop();
    assert.ok(["I", "am", "a", "techno", "DJ"].includes(lastWord),
        `truncated mid-word: ...${out.slice(-25)}`);
});

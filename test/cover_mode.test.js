// test/cover_mode.test.js
//
// Run with: node --test
//
// Cover mode (Max, 4 Sep 2026): !coverstart / !coverend, mod-and-broadcaster only, so he
// can flip it from anywhere. The bot gets more active, says it is covering while he takes
// a break, and thanks raiders on his behalf.
//
// ⛔ NO AUTO-OFF, of any kind. Not a timer, and not the stream ending — his words:
//   "no auto off, so that if necessary I can start an autoplay setlist and have it keep
//   going until I turn it off myself", and "don't worry about stopping it if the stream
//   ends". There is deliberately no test asserting it switches itself off, because doing
//   so would be a bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoverMode } from '../cover_mode.js';
import { createIdleChatter } from '../idle_chatter.js';

function makeHarness(opts = {}) {
    const sayCalls = [];
    const claudePrompts = [];
    const logs = [];
    let botEnabled = opts.botEnabled ?? true;

    const instance = createCoverMode({
        say: (channel, message) => sayCalls.push({ channel, message }),
        claudeCall: async (text) => {
            claudePrompts.push(text);
            if (opts.claudeThrows) throw new Error('claude is down');
            return opts.claudeReply ?? 'robot voice';
        },
        isEnabled: () => botEnabled,
        maxLength: 400,
        log: (m) => logs.push(m),
    });

    return { instance, sayCalls, claudePrompts, logs, setBotEnabled: (v) => { botEnabled = v; } };
}

test('starts off', () => {
    assert.equal(makeHarness().instance.isOn(), false);
});

test('!coverstart turns it on and announces it', async () => {
    const h = makeHarness();
    await h.instance.turnOn('#mind_prime');
    assert.equal(h.instance.isOn(), true);
    assert.equal(h.sayCalls.length, 1);
    assert.match(h.claudePrompts[0], /break/i);
});

test('!coverend turns it off and hands back', async () => {
    const h = makeHarness();
    await h.instance.turnOn('#mind_prime');
    await h.instance.turnOff('#mind_prime');
    assert.equal(h.instance.isOn(), false);
    assert.equal(h.sayCalls.length, 2);
    assert.match(h.claudePrompts[1], /back/i);
});

// ⇒ He may hit it twice from a phone without seeing the first land.
test('turning it on twice announces once', async () => {
    const h = makeHarness();
    await h.instance.turnOn('#mind_prime');
    await h.instance.turnOn('#mind_prime');
    assert.equal(h.sayCalls.length, 1);
    assert.equal(h.instance.isOn(), true);
});

test('turning it off when it is already off says nothing', async () => {
    const h = makeHarness();
    await h.instance.turnOff('#mind_prime');
    assert.equal(h.sayCalls.length, 0);
});

// ⛔ Told to shut up, the bot shuts up — cover or no cover.
test('!mbstop suppresses the announcement but the mode still flips', async () => {
    const h = makeHarness({ botEnabled: false });
    await h.instance.turnOn('#mind_prime');
    assert.equal(h.sayCalls.length, 0);
    assert.equal(h.instance.isOn(), true, 'state must still change, or the switch lies');
});

// ⛔ The state change is committed before the announcement, so a Claude outage cannot
//   leave the switch disagreeing with what chat was told.
test('a Claude failure still leaves the mode on', async () => {
    const h = makeHarness({ claudeThrows: true });
    await assert.doesNotReject(() => h.instance.turnOn('#mind_prime'));
    assert.equal(h.instance.isOn(), true);
    assert.equal(h.sayCalls.length, 0);
});

test('the context line is empty when off and present when on', async () => {
    const h = makeHarness();
    assert.equal(h.instance.contextLine(), '');
    await h.instance.turnOn('#mind_prime');
    assert.match(h.instance.contextLine(), /away|break/i);
});

// Max, 4 Sep 2026: "in this mode it should thank raiders and apologize for my temporary absence"
test('the raid line is empty when off and apologises when on', async () => {
    const h = makeHarness();
    assert.equal(h.instance.raidLine(), '');
    await h.instance.turnOn('#mind_prime');
    assert.match(h.instance.raidLine(), /apolog/i);
    assert.match(h.instance.raidLine(), /raid/i);
});

// ── the two dials it loosens, tested through idle_chatter itself ────────────────────

function makeChatter(covering) {
    let clock = 1_000_000;
    const chatter = createIdleChatter({
        say: () => {},
        claudeCall: async () => 'ok',
        isEnabled: () => true,
        isLive: () => true,
        now: () => clock,
        random: () => 0,
        isCovering: () => covering,
        coverCooldownSec: () => 45,
        quietMax: 4,
        quietWindowSec: 120,
        cooldownLiveSec: 240,
    });
    return { chatter, advance: (s) => { clock += s * 1000; } };
}

// ⇒ A busy room is normally a reason to stay out of it. While he is away it is not.
test('a busy room blocks a reply normally, and does not while covering', async () => {
    for (const who of ['a', 'b', 'c', 'd', 'e']) makeChatter(false).chatter.noteMessage(who);

    const off = makeChatter(false);
    for (const who of ['a', 'b', 'c', 'd', 'e']) off.chatter.noteMessage(who);
    assert.equal(await off.chatter.maybeReplyTo('#c', { username: 'zoe' }, 'hi'), false);

    const on = makeChatter(true);
    for (const who of ['a', 'b', 'c', 'd', 'e']) on.chatter.noteMessage(who);
    on.advance(300);   // clear the cooldown from construction
    assert.notEqual(await on.chatter.maybeReplyTo('#c', { username: 'zoe' }, 'hi'), false);
});

// ⛔ Answering another bot is a machine talking to a machine. Cover mode does not change it.
test('still refuses to answer another bot while covering', async () => {
    const on = makeChatter(true);
    on.advance(300);
    assert.equal(await on.chatter.maybeReplyTo('#c', { username: 'streamelements' }, 'hi'), false);
});

test('the cover cooldown is flat and short, not the 4-8-16-32 ladder', () => {
    const h = makeHarness();
    assert.equal(h.instance.coverCooldownSec(), 45);
});

// test/eventsub.test.js
//
// Run with: node --test
//
// Protocol tests for eventsub.js against SYNTHETIC frames in the exact envelope
// documented at dev.twitch.tv/docs/eventsub/handling-websocket-events (verified
// 14 Aug 2026, not from memory). No socket, no network, no credentials — the
// WebSocket class and fetch are both injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventSub } from '../eventsub.js';

function welcome(id = 'sess_1', keepalive = 10) {
    return JSON.stringify({
        metadata: { message_id: 'm1', message_type: 'session_welcome', message_timestamp: 'now' },
        payload: { session: { id, status: 'connected', keepalive_timeout_seconds: keepalive, reconnect_url: null } },
    });
}

function notification(type, event) {
    return JSON.stringify({
        metadata: { message_id: 'm2', message_type: 'notification', message_timestamp: 'now' },
        payload: { subscription: { type, status: 'enabled' }, event },
    });
}

function makeHarness(opts = {}) {
    const posted = [];
    const logs = [];
    let subscribeCalls = 0;
    const fetchImpl = async (url, init) => {
        posted.push({ url, init });
        if (String(url).includes('oauth2/token')) {
            if (opts.refreshFails) return { ok: false, status: 400, text: async () => '{"message":"invalid"}' };
            return {
                ok: true,
                json: async () => ({
                    access_token: `at_${posted.filter((p) => String(p.url).includes('oauth2/token')).length}`,
                    ...(opts.rotatesRefresh ? { refresh_token: 'a_new_refresh_token' } : {}),
                }),
            };
        }
        if (String(url).includes('/users')) {
            return { ok: true, json: async () => ({ data: [{ id: '12345', login: 'mind_prime' }] }) };
        }
        subscribeCalls += 1;
        if (opts.subscribeFails) {
            return { ok: false, status: 401, text: async () => '{"message":"missing scope"}' };
        }
        // Expire once, then succeed — the ordinary "token aged out" path.
        if (opts.expiresOnce && subscribeCalls === 1) {
            return { ok: false, status: 401, text: async () => '{"message":"invalid oauth token"}' };
        }
        return { ok: true, json: async () => ({ data: [{ id: 'sub_1' }] }) };
    };
    const notified = [];
    const instance = createEventSub({
        clientId: 'cid',
        clientSecret: 'csec',
        refreshToken: 'a_refresh_token',
        broadcasterLogin: 'mind_prime',
        subscriptions: [{ type: 'channel.hype_train.begin', version: '2' }],
        onNotification: (type, event) => {
            notified.push({ type, event });
            if (opts.handlerThrows) throw new Error('handler exploded');
        },
        WebSocketImpl: class { constructor() {} on() {} close() {} },
        fetchImpl,
        log: (...a) => logs.push(a.join(' ')),
        setTimeoutFn: () => 1,
        clearTimeoutFn: () => {},
        ...opts.overrides,
    });
    return { instance, posted, logs, notified };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test('a welcome subscribes, with the session id in the transport', async () => {
    const h = makeHarness();
    h.instance._handle(welcome('sess_abc'));
    await settle();

    const sub = h.posted.find((p) => String(p.url).includes('/eventsub/subscriptions'));
    assert.ok(sub, 'must POST a subscription');
    const body = JSON.parse(sub.init.body);
    assert.equal(body.type, 'channel.hype_train.begin');
    assert.equal(body.version, '2');
    assert.deepEqual(body.transport, { method: 'websocket', session_id: 'sess_abc' });
    assert.deepEqual(body.condition, { broadcaster_user_id: '12345' });
});

test('the broadcaster login is resolved to an id before subscribing', async () => {
    const h = makeHarness();
    h.instance._handle(welcome());
    await settle();
    const order = h.posted.map((p) => String(p.url));
    const userAt = order.findIndex((u) => u.includes('/users?login=mind_prime'));
    const subAt = order.findIndex((u) => u.includes('/eventsub/subscriptions'));
    assert.ok(userAt >= 0, 'must look the broadcaster up');
    assert.ok(userAt < subAt, 'the id is needed for the subscription condition');
    // ⚠ The token mint precedes both — that ordering is asserted separately.
    assert.ok(order[0].includes('oauth2/token'));
});

test('⛔ a session_reconnect does NOT re-subscribe — Twitch carries them over', async () => {
    const h = makeHarness();
    h.instance._handle(welcome('sess_1'));
    await settle();
    const afterFirst = h.posted.filter((p) => String(p.url).includes('/eventsub/subscriptions')).length;

    h.instance._handle(JSON.stringify({
        metadata: { message_type: 'session_reconnect' },
        payload: { session: { id: 'sess_1', reconnect_url: 'wss://new' } },
    }));
    h.instance._handle(welcome('sess_2'));   // the handover welcome
    await settle();

    const afterReconnect = h.posted.filter((p) => String(p.url).includes('/eventsub/subscriptions')).length;
    assert.equal(afterReconnect, afterFirst, 'resubscribing here would DUPLICATE every subscription');
});

test('⛔ but a FRESH session after a handover does subscribe again', async () => {
    // Getting this backwards is silent in both directions: duplicates one way,
    // total deafness the other.
    const h = makeHarness();
    h.instance._handle(welcome('sess_1'));
    await settle();
    h.instance._handle(JSON.stringify({
        metadata: { message_type: 'session_reconnect' },
        payload: { session: { reconnect_url: 'wss://new' } },
    }));
    h.instance._handle(welcome('sess_2'));   // handover — no subscribe
    await settle();
    const before = h.posted.filter((p) => String(p.url).includes('/eventsub/subscriptions')).length;

    h.instance._handle(welcome('sess_3'));   // a genuinely new session
    await settle();
    const after = h.posted.filter((p) => String(p.url).includes('/eventsub/subscriptions')).length;
    assert.equal(after, before + 1, 'a fresh session must re-subscribe or the bot goes deaf');
});

test('a notification is dispatched with its type and event', () => {
    const h = makeHarness();
    h.instance._handle(notification('channel.hype_train.begin', { id: 'train_1', level: 2 }));
    assert.deepEqual(h.notified, [{ type: 'channel.hype_train.begin', event: { id: 'train_1', level: 2 } }]);
});

test('⛔ a throwing handler does not take down the socket', () => {
    const h = makeHarness({ handlerThrows: true });
    assert.doesNotThrow(() => h.instance._handle(notification('channel.hype_train.begin', { id: 'x' })));
    assert.ok(h.logs.some((l) => /handler error/.test(l)));
});

test('⛔ a failed subscribe is LOUD, not swallowed', async () => {
    // A 401 means the token lacks the scope and the feature is simply dead.
    // Continuing quietly leaves a bot that looks connected and never fires.
    const h = makeHarness({ subscribeFails: true });
    h.instance._handle(welcome());
    await settle();
    assert.ok(h.logs.some((l) => /SUBSCRIBE FAILED/.test(l)), 'must log the failure');
    assert.ok(h.logs.some((l) => /401/.test(l)), 'must include the status');
});

test('a revocation is logged as feature-dead', () => {
    const h = makeHarness();
    h.instance._handle(JSON.stringify({
        metadata: { message_type: 'revocation' },
        payload: { subscription: { type: 'channel.hype_train.begin', status: 'authorization_revoked' } },
    }));
    assert.ok(h.logs.some((l) => /REVOKED/.test(l)));
    assert.ok(h.logs.some((l) => /authorization_revoked/.test(l)));
});

test('a keepalive is accepted and does nothing else', () => {
    const h = makeHarness();
    assert.doesNotThrow(() => h.instance._handle(JSON.stringify({
        metadata: { message_type: 'session_keepalive' }, payload: {},
    })));
    assert.equal(h.notified.length, 0);
});

test('an unparseable or unknown frame is ignored, not fatal', () => {
    const h = makeHarness();
    assert.doesNotThrow(() => h.instance._handle('not json at all'));
    assert.doesNotThrow(() => h.instance._handle(JSON.stringify({ metadata: { message_type: 'wat' }, payload: {} })));
    assert.ok(h.logs.some((l) => /unparseable/.test(l)));
    assert.ok(h.logs.some((l) => /unknown message_type/.test(l)));
});

test('the session id is exposed after welcome', () => {
    const h = makeHarness();
    h.instance._handle(welcome('sess_xyz'));
    assert.equal(h.instance.sessionId, 'sess_xyz');
});

test('constructor rejects a missing WebSocket implementation', () => {
    assert.throws(() => createEventSub({ fetchImpl: async () => ({}) }), /requires a `WebSocketImpl`/);
});

// --- token lifecycle ----------------------------------------------------

test('⛔ it refreshes before the first call — no access token is configured', async () => {
    // The credential is a REFRESH token. Max's live access token reported
    // expires_in 13742 (3.8 hours) on 14 Aug 2026; a static one would have
    // worked for an afternoon and then died on a 401 nobody would see.
    const h = makeHarness();
    h.instance._handle(welcome());
    await settle();
    assert.ok(String(h.posted[0].url).includes('oauth2/token'), 'must mint a token first');
    const body = h.posted[0].init.body;
    assert.match(body, /grant_type=refresh_token/);
    assert.match(body, /refresh_token=a_refresh_token/);
});

test('the minted token is used as the Bearer on API calls', async () => {
    const h = makeHarness();
    h.instance._handle(welcome());
    await settle();
    const api = h.posted.find((p) => String(p.url).includes('/users'));
    assert.equal(api.init.headers.Authorization, 'Bearer at_1');
});

test('⛔ an expired token is refreshed and the call retried ONCE', async () => {
    const h = makeHarness({ expiresOnce: true });
    h.instance._handle(welcome());
    await settle();
    const tokenCalls = h.posted.filter((p) => String(p.url).includes('oauth2/token')).length;
    assert.equal(tokenCalls, 2, 'one initial mint, one refresh after the 401');
    assert.ok(h.logs.some((l) => /401 — refreshing/.test(l)));
    assert.ok(h.logs.some((l) => /subscribed channel.hype_train.begin/.test(l)), 'the retry must succeed');
});

test('⛔ a 401 that SURVIVES a refresh is not retried forever — it is a missing scope', async () => {
    const h = makeHarness({ subscribeFails: true });
    h.instance._handle(welcome());
    await settle();
    const subCalls = h.posted.filter((p) => String(p.url).includes('/eventsub/subscriptions')).length;
    assert.equal(subCalls, 2, 'exactly one retry, then give up and report');
    assert.ok(h.logs.some((l) => /SUBSCRIBE FAILED/.test(l)));
});

test('⛔ a rotated refresh token is reported LOUDLY — it cannot be persisted here', async () => {
    // Render env is not writable from the process, so a rotation survives until
    // the next restart and then fails. Invisible unless it is shouted about.
    const h = makeHarness({ rotatesRefresh: true });
    h.instance._handle(welcome());
    await settle();
    assert.ok(h.logs.some((l) => /ROTATED THE REFRESH TOKEN/.test(l)));
    assert.ok(h.logs.some((l) => /Update EVENTSUB_REFRESH_TOKEN on Render/.test(l)));
});

test('a failed refresh is reported, not swallowed', async () => {
    const h = makeHarness({ refreshFails: true });
    h.instance._handle(welcome());
    await settle();
    assert.ok(h.logs.some((l) => /subscribe error|token refresh failed/.test(l)));
});

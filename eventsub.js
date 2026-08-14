// eventsub.js
//
// Twitch EventSub over WebSocket. Built 14 Aug 2026 so Mind_B0t can see hype
// trains, which are NOT an IRC event — the same gap that forced follow_thanks.js
// to scrape StreamElements' chat announcement.
//
// [verified against dev.twitch.tv/docs/eventsub/handling-websocket-events, this
// turn, not from memory]
//
// ---------------------------------------------------------------------------
// THE PROTOCOL, and the three parts that bite
//
// Every message is {metadata: {message_id, message_type, message_timestamp},
// payload: {}}. Five message types: session_welcome, session_keepalive,
// notification, session_reconnect, revocation.
//
//   1. ⛔ TEN SECONDS TO SUBSCRIBE. Twitch: "By default, you have 10 seconds
//      from the time you receive the Welcome message to subscribe to an event"
//      or it closes the connection. So the subscribe POST fires immediately on
//      welcome, not after any other setup.
//
//   2. ⛔ SUBSCRIPTIONS CARRY OVER A session_reconnect, AND ONLY THAT. Twitch
//      hands over an existing session; re-subscribing there would duplicate every
//      subscription. But after a DROP, the new session is fresh and subscriptions
//      must be created again. One boolean decides it, and getting it backwards is
//      silent in both directions — duplicates on one side, deafness on the other.
//
//   3. ⛔ KEEPALIVE IS A WATCHDOG, NOT DECORATION. The welcome carries
//      keepalive_timeout_seconds (default 10). If nothing arrives within that
//      window the connection is dead, and a dead socket does not necessarily
//      emit 'close' — it can sit there looking connected forever. Any message
//      resets the timer, not just keepalives.
//
// ---------------------------------------------------------------------------
// ⛔ WHY `ws` AND NOT THE GLOBAL WebSocket: package.json sets engines
// {"node": ">=18"} and lists ws as a DIRECT dependency. Global WebSocket only
// became stable in Node 22, so on a Render instance running 18 or 20 the global
// is absent or flagged. `ws` costs nothing here because it is already required.
//
// ⛔ AUTH IS A USER TOKEN, NOT AN APP TOKEN. WebSocket EventSub rejects app
// access tokens outright, and channel.hype_train.begin needs
// channel:read:hype_train granted BY THE BROADCASTER. The bot's existing chat
// oauth belongs to mind_bot2 and cannot carry it — this needs a separate token
// authorised on Max's own account. See the README note this PR adds.
// ---------------------------------------------------------------------------

const WSS_URL = "wss://eventsub.wss.twitch.tv/ws";
const SUBSCRIPTIONS_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";
const USERS_URL = "https://api.twitch.tv/helix/users";

// Backoff for reconnects after a drop. Capped — a bot that is down should keep
// trying at a sane interval, not give up and not hammer.
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000];

export function createEventSub({
    clientId,
    accessToken,                       // USER token for the broadcaster
    broadcasterLogin,                  // resolved to an id at connect time
    subscriptions = [],                // [{type, version}] — condition is filled in
    onNotification = () => {},         // (type, event) => void
    WebSocketImpl,
    fetchImpl = globalThis.fetch,
    log = console.log,
    url = WSS_URL,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
} = {}) {
    if (!WebSocketImpl) throw new Error("createEventSub requires a `WebSocketImpl`");
    if (typeof fetchImpl !== "function") throw new Error("createEventSub requires `fetchImpl`");

    let _ws = null;
    let _sessionId = null;
    let _broadcasterId = null;
    let _keepaliveTimer = null;
    let _backoffIndex = 0;
    let _stopped = false;
    // ⛔ See header §2. True only when the NEXT welcome belongs to a fresh
    // session; a session_reconnect hands over existing subscriptions.
    let _needsSubscribe = true;
    // Twitch sends this in the welcome; 10s is its documented default and the
    // value used until the first welcome arrives.
    let _lastKeepaliveSeconds = 10;

    function _headers() {
        return {
            "Client-Id": clientId,
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
        };
    }

    async function _resolveBroadcasterId() {
        if (_broadcasterId) return _broadcasterId;
        const res = await fetchImpl(`${USERS_URL}?login=${encodeURIComponent(broadcasterLogin)}`, {
            headers: _headers(),
        });
        if (!res.ok) throw new Error(`user lookup failed: ${res.status}`);
        const body = await res.json();
        const user = body && body.data && body.data[0];
        if (!user) throw new Error(`no such user: ${broadcasterLogin}`);
        _broadcasterId = user.id;
        log(`[eventsub] broadcaster ${broadcasterLogin} = ${_broadcasterId}`);
        return _broadcasterId;
    }

    async function _subscribeAll() {
        const id = await _resolveBroadcasterId();
        for (const sub of subscriptions) {
            const body = {
                type: sub.type,
                version: sub.version,
                condition: sub.condition || { broadcaster_user_id: id },
                transport: { method: "websocket", session_id: _sessionId },
            };
            const res = await fetchImpl(SUBSCRIPTIONS_URL, {
                method: "POST", headers: _headers(), body: JSON.stringify(body),
            });
            if (res.ok) {
                log(`[eventsub] subscribed ${sub.type} v${sub.version}`);
            } else {
                // ⛔ LOUD. A 401 means the token lacks the scope and the feature is
                // simply dead — silently continuing would leave a bot that looks
                // connected and never fires.
                const text = await res.text().catch(() => "");
                log(`[eventsub] ⛔ SUBSCRIBE FAILED ${sub.type}: ${res.status} ${text.slice(0, 300)}`);
            }
        }
    }

    function _armKeepalive(seconds) {
        clearTimeoutFn(_keepaliveTimer);
        // Grace on top of Twitch's stated timeout — a late keepalive is normal,
        // a missing one is not.
        const ms = (Number(seconds) || 10) * 1000 + 5000;
        _keepaliveTimer = setTimeoutFn(() => {
            log("[eventsub] keepalive missed — reconnecting");
            _reconnect();
        }, ms);
    }

    function _reconnect(nextUrl) {
        if (_stopped) return;
        clearTimeoutFn(_keepaliveTimer);
        try { if (_ws) _ws.close(); } catch (_) { /* already gone */ }
        _ws = null;
        const delay = nextUrl ? 0 : BACKOFF_MS[Math.min(_backoffIndex, BACKOFF_MS.length - 1)];
        if (!nextUrl) _backoffIndex += 1;
        setTimeoutFn(() => connect(nextUrl || url), delay);
    }

    function _handle(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch (err) {
            log("[eventsub] unparseable frame, ignoring");
            return;
        }
        const type = msg && msg.metadata && msg.metadata.message_type;
        const payload = (msg && msg.payload) || {};

        // ⛔ ANY message proves the socket is alive, not just keepalives.
        if (_keepaliveTimer) _armKeepalive(_lastKeepaliveSeconds);

        switch (type) {
            case "session_welcome": {
                const session = payload.session || {};
                _sessionId = session.id;
                _lastKeepaliveSeconds = session.keepalive_timeout_seconds || 10;
                _armKeepalive(_lastKeepaliveSeconds);
                _backoffIndex = 0;
                log(`[eventsub] connected, session ${_sessionId}`);
                if (_needsSubscribe) {
                    // ⛔ Immediately — 10-second window. See header §1.
                    _subscribeAll().catch((err) => log("[eventsub] ⛔ subscribe error:", err.message));
                } else {
                    log("[eventsub] reconnect handover — subscriptions carried over, not recreated");
                    _needsSubscribe = true; // the NEXT fresh connect must subscribe
                }
                break;
            }
            case "session_keepalive":
                break;
            case "notification": {
                const subType = payload.subscription && payload.subscription.type;
                try {
                    onNotification(subType, payload.event || {});
                } catch (err) {
                    // A handler throwing must never take down the socket.
                    log("[eventsub] handler error:", err && err.message ? err.message : err);
                }
                break;
            }
            case "session_reconnect": {
                const nextUrl = (payload.session && payload.session.reconnect_url) || null;
                log("[eventsub] server asked us to reconnect");
                _needsSubscribe = false;   // header §2
                _reconnect(nextUrl);
                break;
            }
            case "revocation": {
                const s = payload.subscription || {};
                log(`[eventsub] ⛔ SUBSCRIPTION REVOKED: ${s.type} (${s.status}) — this feature is now dead until fixed`);
                break;
            }
            default:
                log(`[eventsub] unknown message_type: ${type}`);
        }
    }

    function connect(target = url) {
        if (_stopped) return;
        log(`[eventsub] connecting to ${target}`);
        const ws = new WebSocketImpl(target);
        _ws = ws;

        ws.on("message", (data) => _handle(data.toString()));
        ws.on("error", (err) => log("[eventsub] socket error:", err && err.message ? err.message : err));
        ws.on("close", (code) => {
            log(`[eventsub] socket closed (${code})`);
            if (ws === _ws) _reconnect();
        });
        return ws;
    }

    function stop() {
        _stopped = true;
        clearTimeoutFn(_keepaliveTimer);
        try { if (_ws) _ws.close(); } catch (_) { /* already gone */ }
        _ws = null;
    }

    return { connect, stop, _handle, get sessionId() { return _sessionId; } };
}

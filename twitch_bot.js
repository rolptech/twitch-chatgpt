// Import tmi.js module
import tmi from 'tmi.js';

export class TwitchBot {
    constructor(bot_username, oauth_token, channels) {
        this.channels = channels;
        this.client = new tmi.client({
            connection: {
                reconnect: true,
                secure: true
            },
            identity: {
                username: bot_username,
                password: oauth_token
            },
            channels: this.channels
        });
    }

    addChannel(channel) {
        // Check if channel is already in the list
        if (!this.channels.includes(channel)) {
            this.channels.push(channel);
            // Use join method to join a channel instead of modifying the channels property directly
            this.client.join(channel);
        }
    }

    connect() {
        // Use async/await syntax to handle promises
        (async () => {
            try {
                // Await for the connection to be established
                await this.client.connect();
            } catch (error) {
                // Handle any errors that may occur
                console.error(error);
            }
        })();
    }

    disconnect() {
        // Use async/await syntax to handle promises
        (async () => {
            try {
                // Await for the connection to be closed
                await this.client.disconnect();
            } catch (error) {
                // Handle any errors that may occur
                console.error(error);
            }
        })();
    }

    onMessage(callback) {
        this.client.on('message', callback);
    }

    onConnected(callback) {
        this.client.on('connected', callback);
    }

    onDisconnected(callback) {
        this.client.on('disconnected', callback);
    }

    onRaided(callback) {
        this.client.on('raided', callback);
    }

    // Sub + gift-sub thanks (11 Aug 2026 work order) — mirrors onRaided's
    // shape exactly, one passthrough per tmi.js sub-family event. tmi.js
    // internally emits both 'subscription' and 'sub' (and both 'resub' and
    // 'subanniversary') for the same USERNOTICE; we only need to listen on
    // one alias of each pair.
    onSubscription(callback) {
        this.client.on('subscription', callback);
    }

    onResub(callback) {
        this.client.on('resub', callback);
    }

    onSubgift(callback) {
        this.client.on('subgift', callback);
    }

    onSubmysterygift(callback) {
        this.client.on('submysterygift', callback);
    }

    onAnonSubgift(callback) {
        this.client.on('anonsubgift', callback);
    }

    onAnonSubmysterygift(callback) {
        this.client.on('anonsubmysterygift', callback);
    }

    // Bits/cheers (14 Aug 2026). ⛔ NOT a USERNOTICE like the sub family above —
    // verified in tmi.js@1.8.5 lib/client.js:1089, a cheer is a PRIVMSG that
    // carries a `bits` tag:
    //
    //     if(_.hasOwn(message.tags, 'bits')) {
    //         this.emit('cheer', channel, message.tags, msg);
    //     }
    //
    // So the callback shape is (channel, tags, message) — three args, NOT the
    // (channel, username, ...) shape every handler above uses. The cheerer is in
    // tags, not a positional argument, and getting that wrong yields a silently
    // undefined username rather than an error.
    onCheer(callback) {
        this.client.on('cheer', callback);
    }

    // Watch Streaks and anything else Twitch adds to USERNOTICE (15 Aug 2026).
    //
    // ⭐ tmi.js@1.8.5 has named cases for eleven msg-ids and nothing else, but it
    // does NOT drop the rest — lib/client.js:783:
    //
    //     // All other msgid events should be emitted under a usernotice event
    //     default:
    //         this.emit('usernotice', msgid, channel, tags, msg);
    //
    // ⇒ So a Watch Streak (msg-id=viewermilestone) is reachable without touching
    // tmi.js or waiting for EventSub support, which does not exist for it.
    //
    // ⛔ Callback shape is (msgid, channel, tags, msg) — the msg-id comes FIRST,
    // ahead of the channel. Every other handler in this class starts with channel.
    onUsernotice(callback) {
        this.client.on('usernotice', callback);
    }

    say(channel, message) {
        // Use async/await syntax to handle promises
        (async () => {
            try {
                // Await for the message to be sent
                await this.client.say(channel, message);
            } catch (error) {
                // Handle any errors that may occur
                console.error(error);
            }
        })();
    }

    whisper(username, message) {
        // Use async/await syntax to handle promises
        (async () => {
            try {
                // Await for the message to be sent
                await this.client.whisper(username, message);
            } catch (error) {
                // Handle any errors that may occur
                console.error(error);
            }
        })();
    }

    ban(channel, username, reason) {
        // Use async/await syntax to handle promises
        (async () => {
            try {
                // Await for the user to be banned
                await this.client.ban(channel, username, reason);
            } catch (error) {
                // Handle any errors that may occur
                console.error(error);
            }
        })();
    }

    unban(channel, username) {
        // Use async/await syntax to handle promises
        (async () => {
            try {
                // Await for the user to be unbanned
                await this.client.unban(channel, username);
            } catch (error) {
                // Handle any errors that may occur
                console.error(error);
            }
        })();
    }

    clear(channel) {
        // Use async/await syntax to handle promises
        (async () => {
            try {
                // Await for the chat to be cleared
                await this.client.clear(channel);
            } catch (error) {
                // Handle any errors that may occur
                console.error(error);
            }
        })();
    }

    color(channel, color) {
        // Use async/await syntax to handle promises
        (async () => {
            try {
                // Await for the color to be changed
                await this.client.color(channel, color);
            } catch (error) {
                // Handle any errors that may occur
                console.error(error);
            }
        })();
    }

    commercial(channel, seconds) {
        // Use async/await syntax to handle promises
        (async () => {
            try {
                // Await for the commercial to be played
                await this.client.commercial(channel, seconds);
            } catch (error) {
                // Handle any errors that may occur
                console.error(error);
            }
        })();
    }
}

import express from 'express';
import fs from 'fs';

import expressWs from 'express-ws';

import {job} from './keep_alive.js';

import {ClaudeOperations} from './claude_operations.js';
import {SeratoOperations} from './serato_operations.js';
import {TwitchBot} from './twitch_bot.js';

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
let COMMAND_NAME = process.env.COMMAND_NAME // comma separated list of commands to trigger bot (e.g. !gpt, !chat)
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

    // !song / !np — direct now-playing lookup, no Claude call
    const _msg = message.trim().toLowerCase();
    if (_msg === "!song" || _msg === "!np" || _msg.startsWith("!song ") || _msg.startsWith("!np ")) {
        const t = serato ? serato.nowPlaying() : null;
        bot.say(channel, t ? ("Now playing: " + t) : "No track is playing right now.");
        return;
    }

    if (ENABLE_CHANNEL_POINTS) {
        console.log(`The message id is ${user["msg-id"]}`);
        if (user["msg-id"] === "highlighted-message") {
            console.log(`The message is ${message}`);
            const response = await claude_ops.make_claude_call(message);
            bot.say(channel, response);
        }
    }
    // check if message is a command started with !COMMAND_NAME (e.g. !gpt) in lower-cased
    if (message.toLowerCase().startsWith(COMMAND_NAME)) {
        let text = message.slice(COMMAND_NAME.length);

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

# dsh-discord-autoreply

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that answers your friends' Discord messages with DeepSeek and puts each answer in that chat's message box. You read it, edit it if you like, and press Enter yourself.

- Every incoming message and image is shown in a DSH session named `Discord · <chat>`, one session per chat, so you can see the conversation and the answers. A chat's session is created as soon as you open that chat in Discord.
- Answers are in Hong Kong-style colloquial Cantonese mixed with English, matching the friend's mix. Friends who provoke get roasted.
- Archive a session in DSH to start that chat fresh; archived plugin sessions are deleted for good after 24 hours.
- Uses `deepseek-flash` with reasoning off, so answers come back in a few seconds.
- Messages and images go only to DeepSeek, through your DSH account.
- Your own messages and bot messages are ignored.
- If several answers arrive before you send, each starts on a new line in the box.

## How it works

```
Discord PTB window ──(DevTools, 127.0.0.1:9230)──► plugin inside DSH ──► DSH session (deepseek-flash)
        ▲                                                  │
        └──── answer placed in that chat's message box ◄───┘
```

- **Discord side.** Discord PTB is started with a DevTools port bound to `127.0.0.1`. The plugin injects [page-bridge.js](page-bridge.js), which uses BetterDiscord's `BdApi.Webpack` to subscribe to Discord's own `MESSAGE_CREATE` events. Answers go into the message box through Discord's own draft store. No Discord token is read or stored.
- **DSH side.** [index.js](index.js) is a Cordis plugin loaded by DSH. It creates one DSH session per Discord chat with the tool-less `discord` agent preset, sends each message (plus images) as a prompt, and delivers the finished answer when the turn ends.
- **Safety.** Friends' messages are untrusted input. The Discord sessions have DSH's global tools hidden, and a tool guard refuses any tool call from them, including tools other plugins attach to every session (shell, terminals, teammates).

## Requirements

- Windows with Discord **PTB** and BetterDiscord installed
- DeepSeek Harness desktop, signed in to a DeepSeek account
- No npm packages: the plugin uses only Node built-ins that ship with DSH

## Setup

1. Put this folder at `~/.dsh/profiles/desktop/plugins/discord-autoreply`.
2. Append [cordis.patch.example.yml](cordis.patch.example.yml) to `~/.dsh/profiles/desktop/cordis.patch.yml`. DSH picks it up without a restart.
3. Start Discord with [start-discord-ptb.cmd](start-discord-ptb.cmd). It restarts Discord PTB with the DevTools port. If Discord is started any other way, the plugin waits and reconnects once the port appears.

## Configuration

Set these under the `discord-autoreply` entry in `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `channels` | `[]` | Empty: answer in whichever chat is open in Discord. Otherwise only these channel IDs (right-click a chat → Copy Channel ID). |
| `delivery` | `draft` | `draft`: the answer goes into the message box and you press Enter. `send`: posted as you automatically (riskier for your account, see below). |
| `model` / `provider` | `deepseek-flash` / `deepseek-account` | Model used for answers. |
| `reasoningEffort` | `off` | `off`, `low`, `high` or `max`. |
| `replyPrefix` | `''` | Text put before every answer, for example `🤖 `. |
| `apiPort` | `18790` | Local control API port; `0` turns it off. |
| `archiveRetentionHours` | `24` | Archived plugin sessions are deleted after this long. |
| `devtoolsUrl` | `http://127.0.0.1:9230` | Where Discord's DevTools port listens. |

To change the reply style (language, how hard it roasts), edit the persona `prefix` in the `preset-discord` entry. Existing chat sessions may keep the persona they started with; archive a chat's session to get a fresh one.

### Deleting sessions

DSH can archive sessions but has no delete. The plugin records when one of its sessions gets archived and, after `archiveRetentionHours`, removes the session's folder under `~/.dsh/sessions`. A session DSH still has loaded is removed after the next DSH start. Only sessions this plugin created are ever deleted.

## Local control API

The API listens on `http://127.0.0.1:18790` and is meant for future tools, such as a Discord bot or scripts. It accepts only local requests with JSON bodies. Requests that carry a browser `Origin` header are rejected, so web pages can't drive it.

| Route | Body | Does |
|---|---|---|
| `GET /status` | | Connection state, delivery mode, watched chats, chat→session map |
| `POST /ask` | `{ channelId, text, author?, imageUrls? }` | Treats the text as a message in that chat; the answer is delivered as usual |
| `POST /answer` | `{ channelId, messageId }` | Answers one existing message; Discord must have it loaded, for example a chat you viewed recently |
| `POST /draft` | `{ channelId, text }` | Puts text straight into that chat's message box |
| `POST /delete-session` | `{ sessionId }` | Archives one of the plugin's sessions now and deletes it as soon as DSH releases it |
| `POST /send` | `{ channelId, text }` | Posts as you. Returns 403 unless `delivery: send` |

```bash
curl -s http://127.0.0.1:18790/status
```

```bash
curl -s -X POST http://127.0.0.1:18790/ask -H "Content-Type: application/json" -d "{\"channelId\":\"123\",\"text\":\"why is the sky blue\"}"
```

## Caveats

- **Discord rules.** Discord's rules forbid automating a user account. Draft mode keeps the actual sending in your hands, but the client is still being scripted. `delivery: send` carries more risk.
- **Local DevTools port.** While Discord runs with the port open, any program on this PC can control your Discord session through it. Only run it on a PC you trust.
- **Answers from DSH typing.** Anything you type yourself into a `Discord ·` session in DSH also gets its answer delivered to that chat. You can use this to steer it.
- **Memory plugins.** Memory plugins such as dsh-mnemon still add their memory snapshot to these sessions. A friend could ask the model to repeat it, so don't keep anything private there while this runs.
- **Discord updates.** The bridge depends on Discord's internal modules (`MESSAGE_CREATE`, `DraftStore`, `ComponentDispatch`) and on BetterDiscord. A Discord update may need small fixes in `page-bridge.js`.

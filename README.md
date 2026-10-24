# DSH-Discord-AutoReply

**English** · [廣東話](README.zh-HK.md) · [简体中文](README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin, written in TypeScript, that answers your friends' Discord messages with DeepSeek and puts each answer in that chat's message box. You read it, edit it if you like, and press Enter yourself.

> [!WARNING]
> **Using this plugin can get your Discord account banned.**
> Automating a user account is against Discord's Terms of Service, and Discord enforces that actively. Automated activity is detectable, and the outcome can be a warning, a temporary restriction, or a permanent ban that takes your servers, your DMs and your message history with it.
>
> Draft mode keeps the final Enter press in your hands, but it does **not** make the automation allowed or invisible: the Discord client is still being scripted from outside.
>
> **Run it only on an account you are prepared to lose.** The author is not responsible for any warning, restriction or ban. If that risk is not acceptable to you, do not install this plugin.

- Every incoming message and image is shown in a DSH session named `Discord · <chat>`, one session per chat, so you can see the conversation and the answers. A chat's session is created as soon as you open that chat in Discord.
- DeepSeek sees the conversation, not just one message: each request includes up to the last 10 chat messages it hasn't seen yet, with yours marked `Me`, so it stays on topic and writes in your voice.
- Answers copy **your own** texting style, from a generic local style file built from your recent messages. They're in Hong Kong-style colloquial Cantonese mixed with English, following the friend's mix. The default attitude is rude: every answer has a put-down in it, and friends who provoke get a vicious, profanity-heavy roast. Laughter is always normalized to `xd`.
- Links are removed before anything reaches DSH, because many sites (YouTube, for example) can't be reached from there. A message that is only a link gets no answer.
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

- **Discord side.** Discord PTB is started with a DevTools port bound to `127.0.0.1`. The plugin injects the page bridge ([page-bridge.ts](page-bridge.ts), shipped prebuilt as `dist/page-bridge.js`), which uses BetterDiscord's `BdApi.Webpack` to subscribe to Discord's own `MESSAGE_CREATE` events. Answers go into the message box through Discord's own draft store. No Discord token is read or stored.
- **DSH side.** [index.ts](index.ts) is a Cordis plugin loaded by DSH. It creates one DSH session per Discord chat with the tool-less `discord` agent preset, sends each message (plus images) as a prompt, and delivers the finished answer when the turn ends. [persona.ts](persona.ts) builds that preset's system prompt from the base persona plus your style file.
- **Safety.** Friends' messages are untrusted input. The Discord sessions have DSH's global tools hidden, and a tool guard refuses any tool call from them, including tools other plugins attach to every session (shell, terminals, teammates).

## Requirements

- Windows with Discord **PTB** and BetterDiscord installed
- DeepSeek Harness desktop, signed in to a DeepSeek account
- No npm dependencies: only Node built-ins that ship with DSH

## Install

It's a regular DSH plugin package (`dsh.bundle.patch` in [package.json](package.json)), so it shows up in DSH's plugin list as **Discord Auto-Reply**, with an on/off toggle.

1. In DSH, open **Settings → Plugins → Add plugin** and enter one of:
   - `github:Test-Plus-XD/DSH-Discord-AutoReply` to install from GitHub.
   - the absolute path of a local clone, e.g. `C:\Users\<you>\code\DSH-Discord-AutoReply`. DSH links the folder, so edits there apply after a reload.
2. Start Discord with [start-discord-ptb.cmd](start-discord-ptb.cmd). It restarts Discord PTB with the DevTools port. If Discord is started any other way, the plugin waits and reconnects once the port appears.
3. Create your style file (next section). Without it, answers use only the generic persona.

Turn it off or on with its toggle in the plugin list, which adds or removes the bundle from your profile. Uninstall it there too. Don't also mount its rows in your profile's own `cordis.patch.yml`, or the ids collide.

Your data lives in `~/.dsh/discord-autoreply/` (`state.json`, `style.local.md`, the sessions' working folder), so updates and reinstalls keep it.

## Your style file

`~/.dsh/discord-autoreply/style.local.md` holds instructions describing how *you* text. It stays on your PC because it's built from your private chats. [persona.ts](persona.ts) appends it to the persona and re-reads it whenever it changes, so edits apply to the next answer without a reload.

To build or refresh it:

1. Open a chat in Discord where you talk a lot.
2. Fetch the latest 30 messages of the open chat. `mine: true` marks yours:

   ```bash
   curl -s "http://127.0.0.1:18790/recent?limit=30"
   ```

3. Write `style.local.md` from **your** messages only, as generic habits: typical length, language choice, slang, how you laugh, punctuation and emoji habits, and tone. Leave out topics and full example sentences, because the model parrots them in every chat; the live chat context already shows it your real lines. Don't copy friends' messages into it. A coding agent can do this step for you (see [CLAUDE.md](CLAUDE.md)).

## Configuration

The defaults are in the bundle's [cordis.patch.yml](cordis.patch.yml). To change one, override it by id in your profile's `~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
- id: discord-autoreply
  config:
    channels: ['123456789012345678']
```

| Key | Default | Meaning |
|---|---|---|
| `channels` | `[]` | Empty: answer in whichever chat is open in Discord. Otherwise only these channel IDs (right-click a chat → Copy Channel ID). |
| `delivery` | `draft` | `draft`: the answer goes into the message box and you press Enter. `send`: posted as you automatically (**much higher ban risk**, see the warning at the top). |
| `model` / `provider` | `deepseek-flash` / `deepseek-account` | Model used for answers. |
| `reasoningEffort` | `off` | `off`, `low`, `high` or `max`. |
| `replyPrefix` | `''` | Text put before every answer, for example `🤖 `. |
| `stripLinks` | `true` | Remove links before messages reach DSH; link-only messages are ignored. |
| `contextMessages` | `10` | Earlier chat messages sent with each request (only ones the session hasn't seen); `0` turns it off. |
| `apiPort` | `18790` | Local control API port; `0` turns it off. |
| `archiveRetentionHours` | `24` | Archived plugin sessions are deleted after this long. |
| `devtoolsUrl` | `http://127.0.0.1:9230` | Where Discord's DevTools port listens. |

The general reply rules (Cantonese/English mixing, how hard it roasts) are the persona `prefix` in the `preset-discord` entry. It sets the roast level (rude by default, vicious when provoked) and one hard limit: no slurs, nothing aimed at race, religion, gender, sexuality or disability, no threats and no death or self-harm jokes. Tone it down or up there. Your personal style goes in `style.local.md`, and wins where the two conflict. Changes to the style file apply right away. A change to the persona `prefix` only reaches chats whose session starts after it: archive a chat's session in DSH (or `POST /delete-session`) to restart it.

### Deleting sessions

DSH can archive sessions but has no delete. The plugin records when one of its sessions gets archived and, after `archiveRetentionHours`, removes the session's folder under `~/.dsh/sessions`. A session DSH still has loaded is removed after the next DSH start. Only sessions this plugin created are ever deleted.

## Local control API

The API listens on `http://127.0.0.1:18790` and is meant for future tools, such as a Discord bot or scripts. It accepts only local requests, with JSON bodies for POST. Requests that carry a browser `Origin` header are rejected, so web pages can't drive it.

| Route | Input | Does |
|---|---|---|
| `GET /status` | | Connection state, delivery mode, watched chats, chat→session map |
| `GET /recent` | `?channelId=&limit=30` | Latest loaded messages of a chat (default: the open chat), with `mine` marking yours |
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

## Development

The sources are the `.ts` files in the repo root; DSH loads the prebuilt JavaScript in `dist/`. After editing, rebuild with:

```bash
node build.ts
```

The build uses Node's own type stripping (Node 22.18+), so there's nothing to install. `dist/` is committed because GitHub installs land in `node_modules`, where Node won't strip types at load time.

## License

[MIT](LICENSE)

## Caveats

- **Ban risk.** The warning at the top is the short version. `delivery: send` is riskier than draft mode, but draft mode only makes the automation less visible. It does not make it allowed: the account, not the plugin, pays for it.
- **Local DevTools port.** While Discord runs with the port open, any program on this PC can control your Discord session through it. Only run it on a PC you trust.
- **Answers from DSH typing.** Anything you type yourself into a `Discord ·` session in DSH also gets its answer delivered to that chat. You can use this to steer it.
- **Memory plugins.** Memory plugins such as dsh-mnemon still add their memory snapshot to these sessions. A friend could ask the model to repeat it, so don't keep anything private there while this runs.
- **Discord updates.** The bridge depends on Discord's internal modules (`MESSAGE_CREATE`, `DraftStore`, `ComponentDispatch`) and on BetterDiscord. A Discord update may need small fixes in `page-bridge.ts`.

[![Assisted by Claude Code](https://img.shields.io/badge/assisted_by-Claude-D97757?style=flat-square&logo=claude&logoColor=white)](https://claude.com/claude-code)
[![Assisted by DeepSeek Harness](https://img.shields.io/badge/assisted_by-大肥魚-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://www.deepseek.com/harness)

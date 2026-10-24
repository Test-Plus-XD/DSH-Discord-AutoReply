# CLAUDE.md

DSH (DeepSeek Harness) plugin that bridges the Discord PTB desktop client to DSH sessions. See README.md for user-facing docs.

## Layout

- `index.js` — Cordis plugin (ESM, `export apply/name/inject`), loaded by DSH from the profile's `cordis.patch.yml` as `./plugins/discord-autoreply/index.js`. Contains the DevTools client (`DiscordPage`), DSH session handling and the localhost API (`startApi`).
- `page-bridge.js` — a single expression evaluated inside Discord's page. It is re-read from disk on every injection, and each injection replaces any earlier copy (`window.__dshDiscordBridge.stop()`).
- `cordis.patch.example.yml` — the profile patch: the `discord` agent preset and the plugin entry. Keep it in sync with the live patch at `~/.dsh/profiles/desktop/cordis.patch.yml`.
- `state.json` (gitignored) — channelId → DSH sessionId map. `sessions/` (gitignored) — cwd for the Discord sessions.

## Runtime facts (verified on DSH desktop, Electron Node 24)

- Host services used: `ctx.sessionController.create/prompt/rename/resolveAgent`, `ctx.sessionController.agents.selectForNextRequest` (per-session model; `selectModel` would overwrite the user's global default, so don't use it), `ctx.tools.guard`, `agent.ctx.tools.restrict`.
- Session events arrive via `ctx.on('session/event', (session, event))`. Answers are `assistant/message` text parts; deliver on `turn/end` with `reason.kind === 'completed'`.
- Prompt images are `{ type: 'image', data: <canonical base64>, mediaType }`. The declared type must match the bytes, so sniff the magic bytes; Discord's `content_type` lies.
- deepseek-flash supports images; reasoning efforts are `off|low|high|max`.
- Global tools from other plugins (dsh-ops shell, agent teams, mnemon) attach to every agent. Some are agent-scoped and can't be `restrict`ed, so the `tools.guard` is the real safety boundary. Never weaken it: Discord messages are untrusted.

## Discord internals (via BetterDiscord `BdApi.Webpack`)

- Events: the dispatcher module with `subscribe/dispatch/unsubscribe` (`searchExports: true`), event `MESSAGE_CREATE`; skip `optimistic`, your own messages and bots.
- Sending: `getByKeys('sendMessage','editMessage').sendMessage(channelId, msg, undefined, {})`. The 4th argument is required, or it throws on `.nonce`.
- Drafts: `DraftStore.getDraft(id, 0)`. For the open chat use `ComponentDispatch.dispatchToLastSubscribed('INSERT_TEXT', { plainText, rawText })`; for other chats use `DraftActions.changeDraft(id, text, 0)`.

## Development

- DSH hot-reloads the plugin only when the patch file's content changes; a timestamp touch is not enough. To reload, toggle `enabled` in the live patch.
- Check behaviour without touching real chats: call the `__dshDiscordEmit` binding with a fake channel ID through DevTools, or `POST /ask` to the API, then read the session log (`~/.dsh/sessions/...plugins-discord-autoreply-sessions.../session.v4.jsonl.zstd`, made of concatenated zstd frames).
- Never send test messages to real chats; use draft delivery or fake channel IDs, and clear test drafts afterwards.
- No npm dependencies; Node built-ins only (global `fetch`/`WebSocket`, `node:http`).
- Don't commit `state.json`: it contains chat names.

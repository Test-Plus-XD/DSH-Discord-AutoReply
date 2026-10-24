# CLAUDE.md

DSH (DeepSeek Harness) plugin that bridges the Discord PTB desktop client to DSH sessions. See README.md for user-facing docs. GitHub: `Test-Plus-XD/DSH-Discord-AutoReply` (private).

## Layout

It's a DSH plugin package: `package.json` → `dsh.bundle.patch` → `cordis.patch.yml`. The bundle patch inserts the `discord` agent preset (`preset-discord`) and the plugin (`discord-autoreply`) by package name: `dsh-discord-autoreply` and `dsh-discord-autoreply/persona`, both from `exports`. The DSH plugin list shows it from the profile's dependencies, with its title from `locale/*.json` `meta` and its icon from `package.json` `icon`. The toggle adds or removes the name in the profile's `dsh.profile.bundles`.

- `index.ts` — plugin entry (`export name/inject/apply`). It handles the DSH sessions, the tool guard, archive cleanup and the API routes.
- `discord-page.ts` — DevTools Protocol client (`DiscordPage`). Injects the page bridge (prebuilt `page-bridge.js` next to it in `dist/`, else `page-bridge.ts` stripped at runtime) and calls bridge methods.
- `page-bridge.ts` — runs inside Discord's page. After type stripping it must remain a **single expression** (the IIFE), because it is evaluated with `Runtime.evaluate`. It is re-read on every injection, and each injection replaces any earlier copy (`window.__dshDiscordBridge.stop()`).
- `persona.ts` — replaces `@deepseek-ai/dsh-persona` inside the `discord` preset. It registers the complete `deployment:persona-prefix` section with a text **function**: the base prefix plus `style.local.md`, re-read when the file's mtime changes.
- `api.ts` — localhost HTTP API (`startApi`, `HttpError`). GET handlers get the query as input, POST handlers get the JSON body.
- `paths.ts` — `DATA_DIR` = `~/.dsh/discord-autoreply`, which holds `state.json` (channelId → sessionId map, owned sessions, archive times; contains chat names), `style.local.md` (the user's style, from private chats) and `sessions/` (the cwd for the Discord sessions). Never write user data inside the package: GitHub installs live in `node_modules` and get replaced on update.
- `types.ts` — shared types, plus minimal declarations for the DSH host services used (DSH ships none).
- `build.ts` → `dist/` (committed). `locale/`, `icon.svg` — plugin list metadata.

## TypeScript rules

- Edit the `.ts` sources, then run `node build.ts`. It strips the types with `node:module`'s `stripTypeScriptTypes`, rewrites `./x.ts` imports to `./x.js`, and writes `dist/`. Commit `dist/` together with the sources. DSH loads `dist/` because Node won't strip types under `node_modules`, which is where a GitHub install puts the package.
- Nothing type-checks the code; `tsconfig.json` is only for editors.
- Use only erasable syntax: no `enum`, `namespace`, parameter properties or `<T>x` casts. Use `import type` for types, and give relative imports a `.ts` extension, written as `from './x.ts'` so the build's rewrite matches.
- Smoke-test `dist/` before reloading DSH: `node --check dist/*.js`, `import()` `dist/index.js` and `dist/persona.js` with plain Node, and evaluate `dist/page-bridge.js` with a fake `window` (it returns `waiting-for-discord`).

## Style file step (`style.local.md`)

When asked to (re)build the user's reply style:

1. Make sure Discord shows the chat to learn from (ask the user to open it), then `GET http://127.0.0.1:18790/recent?limit=30`. Decode the response as UTF-8; PowerShell's `Invoke-RestMethod` garbles Chinese, so read the raw bytes.
2. Analyse only messages with `mine: true` (the logged-in Discord user). Image-only messages count as "replies with memes".
3. Write `~/.dsh/discord-autoreply/style.local.md` as **generic** instructions to the model: length and rhythm, language choice (matching the friend's language, Cantonese particles, Chinglish), laughter (always `xd`, with more x's for more laughter, never `lol`/`haha`), punctuation and emoji habits, and tone. Include **no topics, games, stories or full sample sentences**: the model parrots them into every chat. Live chat context (`contextMessages`) already gives it the user's real lines. End with a "Using the chat context" section: copy the `Me` lines' style without repeating them, and stay on the chat's topic. Keep it under about 30 lines. Never put friends' messages, names or IDs in it. Don't use HTML comments, because they reach the model when DSH has an older `persona.ts` loaded.
4. No reload is needed. Check it with `POST /ask` to a **fake** channel ID, read the newest `system/message` (it must contain `# How the user writes`) and the replies, then `POST /delete-session` for the test session. Parse the log with `JSON.parse`; regexes over the escaped JSON give false negatives.

## Runtime facts (verified on DSH desktop, Electron Node 24)

- Host services used: `ctx.sessionController.create/prompt/rename/resolveAgent`, `ctx.sessionController.agents.selectForNextRequest` (per-session model; `selectModel` would overwrite the user's global default, so don't use it), `ctx.tools.guard`, `agent.ctx.tools.restrict`, `ctx.systemPrompt.section`.
- A section marked `complete: true` replaces the whole system prompt, so separately registered sections are dropped. That is why the style goes inside the persona section rather than in its own.
- Session events arrive via `ctx.on('session/event', (session, event))`. Answers are `assistant/message` text parts; deliver on `turn/end` with `reason.kind === 'completed'`.
- Prompt images are `{ type: 'image', data: <canonical base64>, mediaType }`. The declared type must match the bytes, so sniff the magic bytes; Discord's `content_type` lies.
- Message text is passed through `stripLinks()` (config `stripLinks`): URLs never reach DSH, and a message left empty with no images is ignored.
- `normalizeLaughter()` runs on every answer in `deliver()`: `lol/lmao/lmfao/rofl/haha/哈哈` become `xd`. The prompt alone doesn't hold, because the model slips back into `lol`.
- Roast level lives in the persona `prefix` (bundle `cordis.patch.yml`), not in `style.local.md`, which describes how the user writes plus local, personal exceptions that never go in the repo. The prefix keeps one hard limit (no slurs or attacks on race, religion, gender, sexuality or disability, no threats, no death or self-harm jokes); keep it when changing the tone. The model sometimes dodges a provocation by echoing the previous message, and the user reviews every draft before sending.
- Chat context (`chatContext()`): each prompt is prefixed with up to `contextMessages` earlier messages from `bridge.recent()`. Only messages newer than the chat's `state.sessions[id].lastMessageId` and older than the message being answered are included, comparing snowflakes as `BigInt`. The user's lines are labelled `Me`, images and stickers become placeholders, and links are stripped. `markSeen()` advances the cursor after each prompt. API messages with non-snowflake IDs get no context.
- deepseek-flash supports images; reasoning efforts are `off|low|high|max`.
- Global tools from other plugins (dsh-ops shell, agent teams, mnemon) attach to every agent. Some are agent-scoped and can't be `restrict`ed, so the `tools.guard` is the real safety boundary. Never weaken it: Discord messages are untrusted.

## Discord internals (via BetterDiscord `BdApi.Webpack`)

- Events: the dispatcher module with `subscribe/dispatch/unsubscribe` (`searchExports: true`), event `MESSAGE_CREATE`; skip `optimistic`, your own messages and bots.
- Sending: `getByKeys('sendMessage','editMessage').sendMessage(channelId, msg, undefined, {})`. The 4th argument is required, or it throws on `.nonce`.
- Drafts: `DraftStore.getDraft(id, 0)`. For the open chat use `ComponentDispatch.dispatchToLastSubscribed('INSERT_TEXT', { plainText, rawText })`; for other chats use `DraftActions.changeDraft(id, text, 0)`.
- There are two ComponentDispatch instances, and the first match is the popout one. Pick the instance where `hasSubscribers('INSERT_TEXT')` is true, or the insert silently does nothing.
- Chat switches: `CHANNEL_SELECT` on the dispatcher; read the chat id from `SelectedChannelStore` on the next tick.
- Messages: `MessageStore.getMessage(channelId, messageId)` and `MessageStore.getMessages(channelId).toArray()` (only messages Discord has loaded).

## Session lifecycle

- `state.owned` lists every session the plugin created. Only these get the tool guard, and only these are ever deleted.
- DSH has no session delete API, only `workspaceRegistry.archiveSession/unarchiveSession`. The sweep, which runs every 10 minutes and 30 s after load, records when it first sees a session archived. After `archiveRetentionHours` it `rm`s `~/.dsh/sessions/<group>/<sessionId>` and drops the id from the archive set, but only once `ctx.agents.get(id)` is undefined. Live agents hold the log and are never disposed by the session controller, so they go after a DSH restart.
- `archivedAt: 0` means delete as soon as possible (`POST /delete-session`).
- An archived chat session is never reused; `sessionFor` creates a new one.
- A live session keeps the preset composition it was created with. Persona `prefix` changes and the persona → `persona.ts` switch only reach sessions created afterwards (verified: an older session kept the old prompt). After changing the preset, reset the chat sessions with `POST /delete-session`; the context feature refills the history.
- `DraftActions.clearDraft(channelId, 0)` also empties the open chat's message box. Use it to remove test drafts.

## Development

- DSH reloads the plugin only when its configuration changes; a timestamp touch is not enough. After `node build.ts`, reload by toggling the plugin off and on in DSH's plugin list, or by changing a config override for `discord-autoreply` in the profile's `cordis.patch.yml`.
- The preset keeps the `persona.ts` module it loaded first. Code changes there need a DSH restart, while style file and persona `prefix` changes don't.
- Changing only `page-bridge.ts` doesn't reload anything. Re-inject it by reloading the plugin, or evaluate the stripped file over DevTools.
- Check behaviour without touching real chats: `POST /ask` to a fake channel ID, then read the session log (`~/.dsh/sessions/...discord-autoreply-sessions.../session.v4.jsonl.zstd`, made of concatenated zstd frames).
- Never send test messages to real chats; use draft delivery or fake channel IDs, and clear test drafts afterwards.
- No npm dependencies; Node built-ins only (global `fetch`/`WebSocket`, `node:http`, `node:module`).

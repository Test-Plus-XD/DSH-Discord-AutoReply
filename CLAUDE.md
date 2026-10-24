# CLAUDE.md

DSH (DeepSeek Harness) plugin that bridges the Discord PTB desktop client to DSH sessions. See README.md for user-facing docs. GitHub: `Test-Plus-XD/DSH-Discord-AutoReply` (private).

## Layout

- `index.ts` — Cordis plugin entry (`export name/inject/apply`), loaded by DSH from the profile's `cordis.patch.yml` as `./plugins/discord-autoreply/index.ts`. It handles the DSH sessions, the tool guard, archive cleanup and the API routes.
- `discord-page.ts` — DevTools Protocol client (`DiscordPage`). Strips and injects `page-bridge.ts`, and calls bridge methods.
- `page-bridge.ts` — runs inside Discord's page. After type stripping it must remain a **single expression** (the IIFE), because it is evaluated with `Runtime.evaluate`. It is re-read on every injection, and each injection replaces any earlier copy (`window.__dshDiscordBridge.stop()`).
- `persona.ts` — replaces `@deepseek-ai/dsh-persona` inside the `discord` preset. It registers the complete `deployment:persona-prefix` section with a text **function**: the base prefix plus `style.local.md`, re-read when the file's mtime changes.
- `api.ts` — localhost HTTP API (`startApi`, `HttpError`). GET handlers get the query as input, POST handlers get the JSON body.
- `types.ts` — shared types, plus minimal declarations for the DSH host services used (DSH ships none).
- `cordis.patch.example.yml` — the profile patch: the `discord` preset and the plugin entry. Keep it in sync with the live patch at `~/.dsh/profiles/desktop/cordis.patch.yml`.
- Gitignored: `state.json` (channelId → sessionId map, owned sessions, archive times; contains chat names), `sessions/` (cwd for the Discord sessions), `style.local.md` (the user's style, built from private chats).

## TypeScript rules

- No compiler and no build step. DSH's Electron Node 24 imports `.ts` natively (`process.features.typescript === 'strip'`), and `node:module`'s `stripTypeScriptTypes` handles the page bridge. Nothing type-checks the code; `tsconfig.json` is only for editors.
- Use only erasable syntax: no `enum`, `namespace`, parameter properties or `<T>x` casts. Use `import type` for types, and give relative imports a `.ts` extension.
- Before reloading DSH, smoke-test outside it with Node 26: strip each file with `stripTypeScriptTypes`, `node --check` the output, and `import()` `index.ts` and `persona.ts`.

## Style file step (`style.local.md`)

When asked to (re)build the user's reply style:

1. Make sure Discord shows the chat to learn from (ask the user to open it), then `GET http://127.0.0.1:18790/recent?limit=30`. Decode the response as UTF-8; PowerShell's `Invoke-RestMethod` garbles Chinese, so read the raw bytes.
2. Analyse only messages with `mine: true` (the logged-in Discord user). Image-only messages count as "replies with memes".
3. Write `style.local.md` as **generic** instructions to the model: length and rhythm, language choice (matching the friend's language, Cantonese particles, Chinglish), laughter (always `xd`, with more x's for more laughter, never `lol`/`haha`), punctuation and emoji habits, and tone. Include **no topics, games, stories or full sample sentences**: the model parrots them into every chat. Live chat context (`contextMessages`) already gives it the user's real lines. End with a "Using the chat context" section: copy the `Me` lines' style without repeating them, and stay on the chat's topic. Keep it under about 30 lines. Never put friends' messages, names or IDs in it. Don't use HTML comments, because they reach the model when DSH has an older `persona.ts` loaded.
4. No reload is needed. Check it with `POST /ask` to a **fake** channel ID, read the newest `system/message` (it must contain `# How the user writes`) and the replies, then `POST /delete-session` for the test session. Parse the log with `JSON.parse`; regexes over the escaped JSON give false negatives.

## Runtime facts (verified on DSH desktop, Electron Node 24)

- Host services used: `ctx.sessionController.create/prompt/rename/resolveAgent`, `ctx.sessionController.agents.selectForNextRequest` (per-session model; `selectModel` would overwrite the user's global default, so don't use it), `ctx.tools.guard`, `agent.ctx.tools.restrict`, `ctx.systemPrompt.section`.
- A section marked `complete: true` replaces the whole system prompt, so separately registered sections are dropped. That is why the style goes inside the persona section rather than in its own.
- Session events arrive via `ctx.on('session/event', (session, event))`. Answers are `assistant/message` text parts; deliver on `turn/end` with `reason.kind === 'completed'`.
- Prompt images are `{ type: 'image', data: <canonical base64>, mediaType }`. The declared type must match the bytes, so sniff the magic bytes; Discord's `content_type` lies.
- Message text is passed through `stripLinks()` (config `stripLinks`): URLs never reach DSH, and a message left empty with no images is ignored.
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

- DSH reloads the plugin only when the patch file's **content** changes; a timestamp touch is not enough. To reload `index.ts` and its imports, toggle `enabled` in the live patch.
- The preset keeps the `persona.ts` module it loaded first. Code changes there need a DSH restart, while style file and persona `prefix` changes don't.
- Changing only `page-bridge.ts` doesn't reload anything. Re-inject it by reloading the plugin, or evaluate the stripped file over DevTools.
- Check behaviour without touching real chats: `POST /ask` to a fake channel ID, then read the session log (`~/.dsh/sessions/...plugins-discord-autoreply-sessions.../session.v4.jsonl.zstd`, made of concatenated zstd frames).
- Never send test messages to real chats; use draft delivery or fake channel IDs, and clear test drafts afterwards.
- No npm dependencies; Node built-ins only (global `fetch`/`WebSocket`, `node:http`, `node:module`).

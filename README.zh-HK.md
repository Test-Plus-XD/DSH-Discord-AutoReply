# DSH-Discord-AutoReply

[English](README.md) · **廣東話** · [简体中文](README.zh-CN.md)

一個用 TypeScript 寫嘅 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）plugin，會用 DeepSeek 覆你朋友嘅 Discord 訊息，再將每個答案放入嗰個 chat 嘅訊息輸入框。你自己睇一次，想改就改，最後自己撳 Enter。

> [!WARNING]
> **用呢個 plugin，有可能令你個 Discord 帳戶俾人封。**
> 自動化一個 user 帳戶係違反 Discord 嘅 Terms of Service，而 Discord 係真係會執法嘅。自動化活動係偵測得到，後果可以係警告、暫時限制，或者永久封號——連你嘅 servers、DM 同訊息記錄都會一齊冇埋。
>
> Draft mode 只係將最後撳 Enter 嗰下留喺你手，但**唔會**令呢啲自動化變成允許，亦唔會令佢隱形：個 Discord client 依然係俾外面嘅程式操控緊。
>
> **只係喺你輸得起嘅帳戶上面用。** 任何警告、限制或者封號，作者都唔負責。如果呢個風險你接受唔到，就唔好裝呢個 plugin。

- 每個收到嘅訊息同圖片，都會喺一個叫 `Discord · <chat>` 嘅 DSH session 度顯示，每個 chat 一個 session，等你睇到成段對話同啲答案。你喺 Discord 一開嗰個 chat，佢個 session 就會即刻開好。
- DeepSeek 睇到嘅係成段對話，唔淨係一條訊息：每個 request 都會帶埋佢未睇過嘅 chat 訊息，最多最近 10 條，你自己嗰啲會標住 `Me`，所以佢會貼題，亦會用你嘅口吻寫。
- 啲答案會跟**你自己**嘅打字風格，嚟自一個本地嘅 generic style 檔，個檔係用你最近嘅訊息砌出嚟嘅。語言係港式口語廣東話撈英文，跟返個朋友撈幾多。預設態度係串：每個答案都一定有句踩低人嘅說話，而撩你嘅朋友就會收到一個狠毒、粗口連發嘅 roast。笑聲一律 normalize 做 `xd`。
- 任何嘢去到 DSH 之前，啲 link 都會被拎走，因為好多網站（例如 YouTube）喺嗰邊都去唔到。淨係得一條 link 嘅訊息唔會有答案。
- 喺 DSH archive 咗個 session，就可以等嗰個 chat 由頭嚟過；archive 咗嘅 plugin session 過咗 24 個鐘就會永久刪除。
- 用 `deepseek-flash`，reasoning 熄咗，所以幾秒鐘就有答案。
- 訊息同圖片淨係會經你嘅 DSH 帳戶送去 DeepSeek。
- 你自己嘅訊息同 bot 嘅訊息都會被無視。
- 如果你未 send，就已經嚟咗幾個答案，每個都會喺輸入框度另起一行。

## 點樣運作

```
Discord PTB window ──(DevTools, 127.0.0.1:9230)──► plugin inside DSH ──► DSH session (deepseek-flash)
        ▲                                                  │
        └──── answer placed in that chat's message box ◄───┘
```

- **Discord 嗰邊。** Discord PTB 開嘅時候會綁一個 DevTools port 去 `127.0.0.1`。Plugin 會 inject 個 page bridge（[page-bridge.ts](page-bridge.ts)，prebuilt 好嘅版本係 `dist/page-bridge.js`），佢用 BetterDiscord 嘅 `BdApi.Webpack` 去 subscribe Discord 自己嘅 `MESSAGE_CREATE` event。啲答案會經 Discord 自己嘅 draft store 放入訊息輸入框。成個過程唔會讀取或者儲存任何 Discord token。
- **DSH 嗰邊。** [index.ts](index.ts) 係一個由 DSH 載入嘅 Cordis plugin。佢會用冇 tools 嘅 `discord` agent preset，幫每個 Discord chat 開一個 DSH session，將每條訊息（連圖片）當 prompt 送去，喺 turn 完咗嗰陣將砌好嘅答案送出去。[persona.ts](persona.ts) 就會用 base persona 加你嘅 style 檔，去砌嗰個 preset 嘅 system prompt。
- **安全。** 朋友嘅訊息係 untrusted input。呢啲 Discord session 收埋咗 DSH 嘅 global tools，而個 tool guard 會拒絕任何由佢哋發出嘅 tool call，包括其他 plugin 掛去每個 session 嘅 tools（shell、terminals、teammates）。

## 環境要求

- Windows，裝好 Discord **PTB** 同 BetterDiscord
- DeepSeek Harness desktop，登入咗一個 DeepSeek 帳戶
- 冇 npm dependency：淨係用 DSH 跟機嘅 Node built-ins

## 安裝

佢係一個普通嘅 DSH plugin package（`dsh.bundle.patch` 喺 [package.json](package.json) 度），所以會喺 DSH 嘅 plugin 列表以 **Discord Auto-Reply** 出現，有個 on/off toggle。

1. 喺 DSH 開 **Settings → Plugins → Add plugin**，然後入其中一個：
   - `github:Test-Plus-XD/DSH-Discord-AutoReply`，由 GitHub 裝。
   - 本地 clone 嘅 absolute path，例如 `C:\Users\<you>\code\DSH-Discord-AutoReply`。DSH 會 link 嗰個 folder，所以喺嗰度改嘅嘢，reload 之後就生效。
2. 用 [start-discord-ptb.cmd](start-discord-ptb.cmd) 開 Discord。佢會帶住 DevTools port 重開 Discord PTB。如果你用其他方法開 Discord，plugin 會等，見到個 port 出現就會自己 reconnect。
3. 整好你嘅 style 檔（下一節）。冇呢個檔，答案就淨係用 generic persona。

喺 plugin 列表用佢個 toggle 開關，佢會喺你嘅 profile 加或者刪個 bundle。要 uninstall 都係喺嗰度做。唔好另外喺你自己 profile 嘅 `cordis.patch.yml` 度 mount 佢啲 row，唔係啲 id 會撞。

你啲 data 存放喺 `~/.dsh/discord-autoreply/`（`state.json`、`style.local.md`、啲 session 嘅工作 folder），所以 update 或者重裝都會保留返。

## 你嘅 style 檔

`~/.dsh/discord-autoreply/style.local.md` 入面係一啲指令，描述**你**點樣打字。佢淨係留喺你部 PC，因為佢係用你啲私人 chat 砌出嚟嘅。[persona.ts](persona.ts) 會將佢 append 落 persona，每次佢有變就重新讀一次，所以改完下一個答案就即刻生效，唔使 reload。

要砌或者更新佢：

1. 喺 Discord 開一個你成日傾偈嘅 chat。
2. 攞返個 open chat 最新 30 條訊息。`mine: true` 就係你自己嗰啲：

   ```bash
   curl -s "http://127.0.0.1:18790/recent?limit=30"
   ```

3. 淨係用**你**嘅訊息去寫 `style.local.md`，寫成 generic 嘅習慣：通常幾長、用邊種語言、有咩 slang、你點笑、標點同 emoji 習慣，仲有語氣。唔好寫入啲話題同完整例句，因為個 model 會喺每個 chat 照抄出嚟；live chat context 本身已經俾咗你真實嗰啲句子。唔好將朋友嘅訊息抄入去。呢步可以搵個 coding agent 幫你做（睇 [CLAUDE.md](CLAUDE.md)）。

## 設定

預設值喺個 bundle 嘅 [cordis.patch.yml](cordis.patch.yml)。要改其中一個，就喺你 profile 嘅 `~/.dsh/profiles/desktop/cordis.patch.yml` 度按 id override 佢：

```yaml
- id: discord-autoreply
  config:
    channels: ['123456789012345678']
```

| Key | 預設 | 意思 |
|---|---|---|
| `channels` | `[]` | 空：喺 Discord 開住邊個 chat 就覆邊個。否則只限呢啲 channel ID（右 click 個 chat → Copy Channel ID）。 |
| `delivery` | `draft` | `draft`：答案放入訊息輸入框，你自己撳 Enter。`send`：自動以你嘅身份 post 出去（**封號風險高好多**，睇返上面個警告）。 |
| `model` / `provider` | `deepseek-flash` / `deepseek-account` | 用嚟答嘢嘅 model。 |
| `reasoningEffort` | `off` | `off`、`low`、`high` 或者 `max`。 |
| `replyPrefix` | `''` | 每個答案前面加嘅字，例如 `🤖 `。 |
| `stripLinks` | `true` | 訊息去到 DSH 之前抽走啲 link；淨係得 link 嘅訊息會被無視。 |
| `contextMessages` | `10` | 每個 request 連埋一齊送嘅之前 chat 訊息（只限個 session 未見過嘅）；`0` 就熄咗佢。 |
| `apiPort` | `18790` | 本地 control API port；`0` 就熄咗佢。 |
| `archiveRetentionHours` | `24` | archive 咗嘅 plugin session 幾耐之後會刪。 |
| `devtoolsUrl` | `http://127.0.0.1:9230` | Discord 嘅 DevTools port 喺邊度聽。 |

整體回覆規則（廣東話/英文點撈、串得有幾狠）係 `preset-discord` 嗰個 entry 入面嘅 persona `prefix`。佢定咗 roast 嘅程度（預設係串，俾人撩就會狠），同埋一條硬底線：唔可以有 slur，唔可以針對種族、宗教、性別、性取向或者殘疾，唔可以威脅，亦唔可以開死亡或者自殘嘅玩笑。想收細或者加大個力度就喺嗰度改。你個人嘅 style 就放喺 `style.local.md`，兩邊有衝突嘅時候以佢為準。改 style 檔即刻生效。改 persona `prefix` 就淨係影響之後先開 session 嘅 chat：喺 DSH archive 嗰個 chat 嘅 session（或者 `POST /delete-session`）嚟重開佢。

### 刪除 session

DSH 可以 archive session，但係冇 delete。Plugin 會記低自己邊個 session 幾時俾人 archive 咗，過咗 `archiveRetentionHours` 之後，就刪走 `~/.dsh/sessions` 下面嗰個 session 嘅 folder。如果 DSH 仲 load 住個 session，就要等下次 DSH 開機先刪到。淨係會刪呢個 plugin 自己開嘅 session。

## 本地 control API

個 API 喺 `http://127.0.0.1:18790` 聽，係留俾將來嘅工具用，例如一個 Discord bot 或者 script。佢淨係接受本地 request，POST 要俾 JSON body。帶住瀏覽器 `Origin` header 嘅 request 會俾 reject，所以網頁操控唔到佢。

| Route | Input | 做咩 |
|---|---|---|
| `GET /status` | | 連線狀態、delivery mode、而家睇緊嘅 chat、chat→session 對照表 |
| `GET /recent` | `?channelId=&limit=30` | 一個 chat 最新 load 咗嘅訊息（預設：開住嗰個 chat），`mine` 標住你自己嗰啲 |
| `POST /ask` | `{ channelId, text, author?, imageUrls? }` | 當段字係嗰個 chat 嘅一條訊息；答案照平時咁送 |
| `POST /answer` | `{ channelId, messageId }` | 覆一條現有嘅訊息；Discord 要 load 咗嗰條先得，例如你啱啱睇過嘅 chat |
| `POST /draft` | `{ channelId, text }` | 直接將段字放入嗰個 chat 嘅訊息輸入框 |
| `POST /delete-session` | `{ sessionId }` | 即刻 archive plugin 其中一個 session，DSH 一放返就刪 |
| `POST /send` | `{ channelId, text }` | 以你嘅身份 post。除非 `delivery: send`，否則回 403 |

```bash
curl -s http://127.0.0.1:18790/status
```

```bash
curl -s -X POST http://127.0.0.1:18790/ask -H "Content-Type: application/json" -d "{\"channelId\":\"123\",\"text\":\"why is the sky blue\"}"
```

## 開發

啲 source 就係 repo root 嘅 `.ts` 檔；DSH load 嘅係 `dist/` 入面 prebuilt 好嘅 JavaScript。改完之後用呢句 rebuild：

```bash
node build.ts
```

個 build 用 Node 自己嘅 type stripping（Node 22.18+），所以乜都唔使裝。`dist/` 有 commit 入 repo，因為 GitHub 裝落嘅嘢會入住 `node_modules`，而 Node 喺嗰度 load 嘅時候唔會 strip types。

## 授權條款

[MIT](LICENSE)

## 注意事項

- **封號風險。** 上面個警告係短版。`delivery: send` 比 draft mode 更加險，但 draft mode 只係令啲自動化冇咁顯眼。佢唔會令件事變成允許：要找數嘅係個帳戶，唔係個 plugin。
- **本地 DevTools port。** Discord 開住個 port 行緊嘅時候，呢部 PC 上面任何程式都可以經佢控制你嘅 Discord session。淨係喺你信得過嘅 PC 度行。
- **喺 DSH 打字一樣有答案。** 你自己喺 DSH 一個 `Discord ·` session 入面打嘅嘢，佢個答案一樣會送去嗰個 chat。你可以用呢招引導佢。
- **Memory plugin。** 好似 dsh-mnemon 呢類 memory plugin 一樣會將佢哋嘅 memory snapshot 加落呢啲 session。朋友可以叫個 model 複述返出嚟，所以行緊呢個 plugin 嘅時候，唔好喺嗰度放任何私人嘢。
- **Discord update。** 個 bridge 依賴 Discord 嘅內部 module（`MESSAGE_CREATE`、`DraftStore`、`ComponentDispatch`）同 BetterDiscord。Discord 一 update，`page-bridge.ts` 可能要做啲小修正。

[![Assisted by Claude Code](https://img.shields.io/badge/assisted_by-Claude-D97757?style=flat-square&logo=claude&logoColor=white)](https://claude.com/claude-code)
[![Assisted by DeepSeek Harness](https://img.shields.io/badge/assisted_by-大肥魚-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://www.deepseek.com/harness)

# DSH-Discord-AutoReply

[English](README.md) · [廣東話](README.zh-HK.md) · **简体中文**

一个用 TypeScript 写的 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）plugin：用 DeepSeek 回复朋友们发在 Discord 上的消息，并把每一条回复放进那个聊天的输入框。你看一遍，想改就改，最后自己按 Enter 发送。

> [!WARNING]
> **使用这个插件可能让你的 Discord 账号被封。**
> 自动化操作个人账号违反 Discord 服务条款，而 Discord 对此查处很积极。自动化行为是可以被检测到的，后果可能是警告、临时限制，也可能是永久封禁——连你的服务器、私信和消息记录一起失去。
>
> 草稿模式把最后那一次 Enter 留给你自己按，但这**并不**意味着这种自动化被允许了，也不意味着它隐形：Discord 客户端仍然在被外部脚本操控。
>
> **请只在你准备好失去的账号上运行它。** 作者不对任何警告、限制或封禁负责。如果你无法接受这个风险，就不要安装这个插件。

- 每条收到的消息和图片都会显示在一个名为 `Discord · <chat>` 的 DSH session 里，每个聊天一个 session，这样你能看到对话和回复。只要你在 Discord 里打开某个聊天，它对应的 session 就会立刻创建。
- DeepSeek 看到的不只是一条消息，而是整段对话：每次请求都会带上它还没看过的最近最多 10 条聊天消息，其中你的消息标记为 `Me`，所以它能紧扣话题，用你的口吻来写。
- 回复会模仿**你自己**的聊天风格，依据是一份根据你最近的消息生成的通用本地风格文件。回复用的是夹杂英文的港式粤语口语，中英比例跟着对方走。默认态度是粗鲁的：每条回复都带一句损人的话，被惹到的朋友会被狠狠毒舌一番，脏话连篇。笑声一律统一为 `xd`。
- 链接会在内容到达 DSH 之前被移除，因为很多网站（比如 YouTube）从那边访问不了。只有链接、没有其他内容的消息不会得到回复。
- 在 DSH 里归档一个 session，就能让那个聊天重新开始；被插件归档的 session 会在 24 小时后被永久删除。
- 使用 `deepseek-flash` 并关闭 reasoning，所以几秒钟就能收到回复。
- 消息和图片只会通过你的 DSH 账号发往 DeepSeek。
- 你自己发的消息和机器人消息会被忽略。
- 如果你还没发送就来了好几条回复，它们会在输入框里各占一行。

## 工作原理

```
Discord PTB window ──(DevTools, 127.0.0.1:9230)──► plugin inside DSH ──► DSH session (deepseek-flash)
        ▲                                                  │
        └──── answer placed in that chat's message box ◄───┘
```

- **Discord 一侧。** Discord PTB 启动时会绑定一个监听 `127.0.0.1` 的 DevTools 端口。插件会注入 page bridge（[page-bridge.ts](page-bridge.ts)，以预构建的 `dist/page-bridge.js` 形式随包提供），它通过 BetterDiscord 的 `BdApi.Webpack` 订阅 Discord 自己的 `MESSAGE_CREATE` 事件。回复通过 Discord 自己的草稿存储进入输入框。整个过程不会读取或保存任何 Discord token。
- **DSH 一侧。** [index.ts](index.ts) 是一个由 DSH 加载的 Cordis plugin。它为每个 Discord 聊天创建一个 DSH session，使用不带工具的 `discord` agent preset，把每条消息（连同图片）作为 prompt 发送，并在这一轮结束时投递完成的回复。[persona.ts](persona.ts) 用基础 persona 加上你的风格文件来构建该 preset 的 system prompt。
- **安全性。** 朋友们发来的消息是不可信输入。这些 Discord session 会隐藏 DSH 的全局工具，并且有一个 tool guard 拒绝来自它们的任何工具调用，包括其他插件附加到每个 session 上的工具（shell、终端、teammate）。

## 要求

- Windows 系统，已安装 Discord **PTB** 和 BetterDiscord
- DeepSeek Harness 桌面版，已登录 DeepSeek 账号
- 没有 npm 依赖：只用随 DSH 一起提供的 Node 内置模块

## 安装

它是一个标准的 DSH plugin 包（[package.json](package.json) 里的 `dsh.bundle.patch`），所以会出现在 DSH 的 plugin 列表里，名称是 **Discord Auto-Reply**，带一个开/关开关。

1. 在 DSH 里打开 **Settings → Plugins → Add plugin**，然后输入以下之一：
   - `github:Test-Plus-XD/DSH-Discord-AutoReply`：从 GitHub 安装。
   - 本地克隆的绝对路径，例如 `C:\Users\<you>\code\DSH-Discord-AutoReply`。DSH 会把这个文件夹以链接方式挂载，所以里面的改动重新加载后就会生效。
2. 用 [start-discord-ptb.cmd](start-discord-ptb.cmd) 启动 Discord。它会带着 DevTools 端口重启 Discord PTB。如果 Discord 是用别的方式启动的，插件会等待，端口一出现就重新连接。
3. 创建你的风格文件（见下一节）。没有它，回复只会使用通用 persona。

在 plugin 列表里用它的开关来开启或关闭，开关会把 bundle 加入或移出你的 profile。卸载也在那里做。不要再把它的条目挂进你自己 profile 的 `cordis.patch.yml`，否则 id 会冲突。

你的数据保存在 `~/.dsh/discord-autoreply/`（`state.json`、`style.local.md`、sessions 的工作目录），所以更新和重装都会保留它。

## 你的风格文件

`~/.dsh/discord-autoreply/style.local.md` 里是描述*你*怎么发消息的说明。它只留在你的电脑上，因为它是从你的私人聊天里整理出来的。[persona.ts](persona.ts) 会把它追加到 persona 后面，并在文件变化时重新读取，所以改完不用重新加载，下一条回复就会生效。

要生成或更新它：

1. 在 Discord 里打开一个你聊得很多的聊天。
2. 获取当前打开聊天的最近 30 条消息。`mine: true` 标记你发的消息：

   ```bash
   curl -s "http://127.0.0.1:18790/recent?limit=30"
   ```

3. 只根据**你自己的**消息来写 `style.local.md`，写成通用习惯：典型长度、语言选择、俚语、你怎么笑、标点和 emoji 习惯，以及语气。不要写话题和完整的例句，因为模型会在每个聊天里原样复读它们；实时聊天上下文已经会把你的真实句子展示给它。不要把朋友的消息抄进去。可以让 coding agent 帮你做这一步（见 [CLAUDE.md](CLAUDE.md)）。

## 配置

默认值在 bundle 的 [cordis.patch.yml](cordis.patch.yml) 里。要改哪一项，就在你 profile 的 `~/.dsh/profiles/desktop/cordis.patch.yml` 里按 id 覆盖它：

```yaml
- id: discord-autoreply
  config:
    channels: ['123456789012345678']
```

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `channels` | `[]` | 为空：在 Discord 里当前打开的那个聊天中回复。否则只回复这些频道 ID（右键聊天 → Copy Channel ID）。 |
| `delivery` | `draft` | `draft`：回复进入输入框，由你按 Enter 发送。`send`：自动以你的身份发出（**封号风险高得多**，见顶部的警告）。 |
| `model` / `provider` | `deepseek-flash` / `deepseek-account` | 用于回复的模型。 |
| `reasoningEffort` | `off` | `off`、`low`、`high` 或 `max`。 |
| `replyPrefix` | `''` | 每条回复前面加的文字，例如 `🤖 `。 |
| `stripLinks` | `true` | 在消息到达 DSH 之前移除链接；只有链接的消息会被忽略。 |
| `contextMessages` | `10` | 每次请求附带的更早聊天消息（只包含该 session 还没看过的）；`0` 表示关闭。 |
| `apiPort` | `18790` | 本地控制 API 端口；`0` 表示关闭。 |
| `archiveRetentionHours` | `24` | 插件归档的 session 在过了这么久之后被删除。 |
| `devtoolsUrl` | `http://127.0.0.1:9230` | Discord 的 DevTools 端口监听的地址。 |

通用的回复规则（粤语与英文混用、毒舌有多狠）是 `preset-discord` 条目里的 persona `prefix`。它设定毒舌程度（默认粗鲁，被惹到时变恶毒）和一条硬性底线：不许用歧视性称呼，不许针对种族、宗教、性别、性取向或残障，不许威胁，也不许开死亡或自残的玩笑。想调轻或调重就在那里改。你的个人风格写在 `style.local.md` 里，两者冲突时以它为准。改风格文件会立刻生效。改 persona `prefix` 只对之后才开始 session 的聊天生效：在 DSH 里归档该聊天的 session（或调用 `POST /delete-session`）就能让它重新开始。

### 删除 session

DSH 可以归档 session，但没有删除功能。插件会记录自己的某个 session 什么时候被归档，并在 `archiveRetentionHours` 之后删除该 session 在 `~/.dsh/sessions` 下的文件夹。DSH 仍加载着的 session 会在下一次 DSH 启动之后被删除。只有这个插件创建的 session 才会被删除。

## 本地控制 API

API 监听 `http://127.0.0.1:18790`，是留给以后工具用的，比如 Discord 机器人或脚本。它只接受本机请求，POST 用 JSON body。带浏览器 `Origin` header 的请求会被拒绝，所以网页没法操纵它。

| 路由 | 输入 | 作用 |
|---|---|---|
| `GET /status` | | 连接状态、投递模式、正在监视的聊天、chat→session 映射 |
| `GET /recent` | `?channelId=&limit=30` | 某个聊天已加载的最新消息（默认：当前打开的聊天），`mine` 标记你发的 |
| `POST /ask` | `{ channelId, text, author?, imageUrls? }` | 把这段文字当作该聊天里的一条消息；回复照常投递 |
| `POST /answer` | `{ channelId, messageId }` | 回复一条已存在的消息；Discord 必须已经加载了它，比如你最近看过的聊天 |
| `POST /draft` | `{ channelId, text }` | 把文字直接放进那个聊天的输入框 |
| `POST /delete-session` | `{ sessionId }` | 立刻归档插件的一个 session，并在 DSH 释放它后马上删除 |
| `POST /send` | `{ channelId, text }` | 以你的身份发送。除非 `delivery: send`，否则返回 403 |

```bash
curl -s http://127.0.0.1:18790/status
```

```bash
curl -s -X POST http://127.0.0.1:18790/ask -H "Content-Type: application/json" -d "{\"channelId\":\"123\",\"text\":\"why is the sky blue\"}"
```

## 开发

源码是仓库根目录里的 `.ts` 文件；DSH 加载的是 `dist/` 里预构建的 JavaScript。改完之后用下面的命令重新构建：

```bash
node build.ts
```

构建用的是 Node 自带的类型擦除（Node 22.18+），所以不需要安装任何东西。`dist/` 会被提交，因为从 GitHub 安装的包会落到 `node_modules` 里，而 Node 在加载时不会对那里做类型擦除。

## 许可证

[MIT](LICENSE)

## 注意事项

- **封号风险。** 顶部的警告只是一个简版。`delivery: send` 比草稿模式风险更高，但草稿模式只是让自动化不那么显眼，并不会让它变得被允许：付出代价的是账号，不是插件。
- **本地 DevTools 端口。** 当 Discord 带着这个端口运行时，这台电脑上的任何程序都能通过它控制你的 Discord 会话。只在你信任的电脑上这样运行。
- **在 DSH 里打字也会产生回复。** 你自己在 DSH 的 `Discord ·` session 里输入的任何内容，其回复也会投递到那个聊天。你可以用这个方法来引导它。
- **Memory 插件。** 像 dsh-mnemon 这样的 memory 插件仍然会把它的记忆快照加进这些 session。朋友可以让模型把它复述出来，所以在它运行期间不要在那里保存任何私密内容。
- **Discord 更新。** bridge 依赖 Discord 的内部模块（`MESSAGE_CREATE`、`DraftStore`、`ComponentDispatch`）以及 BetterDiscord。一次 Discord 更新可能需要你对 `page-bridge.ts` 做点小修补。

[![Assisted by Claude Code](https://img.shields.io/badge/assisted_by-Claude-D97757?style=flat-square&logo=claude&logoColor=white)](https://claude.com/claude-code)
[![Assisted by DeepSeek Harness](https://img.shields.io/badge/assisted_by-大肥魚-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://www.deepseek.com/harness)

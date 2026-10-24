// Runs inside the Discord window: discord-page.ts strips the types and evaluates this
// file over DevTools. It reports new messages and chat switches through the
// `__dshDiscordEmit` binding and exposes `window.__dshDiscordBridge`:
// `draft` puts text into a chat's message box (you press Enter), `send` posts it,
// `getMessage` reads one loaded message, `recent` lists a chat's latest messages.
// The file must stay a single expression (the IIFE below) after type stripping.

/** Discord's internal modules are untyped; these describe only what is used. */
type Store = Record<string, any>
interface Bridge {
  ready: boolean
  timer?: ReturnType<typeof setInterval>
  stop?: () => void
  send?: (channelId: string, content: string) => Promise<unknown>
  draft?: (channelId: string, text: string) => 'inserted' | 'drafted'
  getMessage?: (channelId: string, messageId: string) => unknown
  recent?: (channelId: string | null, limit: number) => unknown
}
interface BridgeWindow {
  __dshDiscordBridge?: Bridge
  __dshDiscordEmit(payload: string): void
  BdApi?: { Webpack: Store }
}

(() => {
  const win = window as unknown as BridgeWindow
  // Replace any earlier copy so plugin updates take effect without reloading Discord.
  try { win.__dshDiscordBridge?.stop?.() } catch {}
  clearInterval(win.__dshDiscordBridge?.timer)
  const state: Bridge = win.__dshDiscordBridge = { ready: false }

  const start = (): boolean => {
    const W = win.BdApi?.Webpack
    if (!W) return false
    const dispatcher: Store = W.getModule((m: Store) => typeof m?.subscribe === 'function' && typeof m?.dispatch === 'function' && typeof m?.unsubscribe === 'function', { searchExports: true })
    const actions: Store = W.getByKeys('sendMessage', 'editMessage')
    const users: Store = W.getStore('UserStore')
    const channels: Store = W.getStore('ChannelStore')
    const selected: Store = W.getStore('SelectedChannelStore')
    const messages: Store = W.getStore('MessageStore')
    const drafts: Store = W.getStore('DraftStore')
    const draftActions: Store = W.getModule((m: Store) => typeof m?.changeDraft === 'function' && typeof m?.clearDraft === 'function', { searchExports: true })
    // Discord has several ComponentDispatch instances; the chat box listens on the one with INSERT_TEXT.
    const componentDispatch = (): Store | undefined => ((W.getModule((m: Store) => typeof m?.dispatchToLastSubscribed === 'function', { searchExports: true, first: false }) ?? []) as Store[])
      .find(m => m.hasSubscribers?.('INSERT_TEXT'))
    if (!dispatcher || !actions || !users?.getCurrentUser() || !channels || !selected || !messages || !drafts || !draftActions) return false

    const emit = (event: unknown): void => win.__dshDiscordEmit(JSON.stringify(event))
    const me = (): string | undefined => users.getCurrentUser()?.id
    const channelName = (ch: Store | undefined): string => {
      if (!ch) return ''
      if (ch.name) return ch.name
      const ids: string[] = ch.recipients ?? []
      return ids.map(id => users.getUser(id)?.globalName ?? users.getUser(id)?.username ?? id).join(', ')
    }
    const authorName = (message: Store): string => {
      const author: Store = message.author ?? {}
      return message.member?.nick ?? message.nick ?? author.global_name ?? author.globalName ?? author.username
    }
    const isImage = (a: Store): boolean => (a.content_type ?? '').startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.filename ?? '')
    const describe = (message: Store) => {
      const ch = channels.getChannel(message.channel_id)
      return {
        type: 'message',
        id: message.id,
        channelId: message.channel_id,
        channelName: channelName(ch),
        guildId: message.guild_id ?? ch?.guild_id ?? null,
        isOpenChannel: selected.getChannelId() === message.channel_id,
        author: authorName(message),
        content: message.content ?? '',
        images: ((message.attachments ?? []) as Store[]).filter(isImage)
          .map(a => ({ url: a.url, proxyUrl: a.proxy_url, filename: a.filename, size: a.size })),
      }
    }

    const onCreate = ({ message, optimistic }: { message?: Store; optimistic?: boolean }): void => {
      try {
        if (optimistic || !message || message.author?.id === me() || message.author?.bot) return
        emit(describe(message))
      } catch (error) {
        console.error('[dsh-discord-autoreply]', error)
      }
    }
    const reportOpenChat = (): void => {
      const channelId: string | null = selected.getChannelId()
      if (channelId) emit({ type: 'channel-open', channelId, channelName: channelName(channels.getChannel(channelId)) })
    }
    const onSelect = (): void => { setTimeout(reportOpenChat, 0) }
    dispatcher.subscribe('MESSAGE_CREATE', onCreate)
    dispatcher.subscribe('CHANNEL_SELECT', onSelect)
    state.stop = () => {
      dispatcher.unsubscribe('MESSAGE_CREATE', onCreate)
      dispatcher.unsubscribe('CHANNEL_SELECT', onSelect)
    }

    state.send = (channelId, content) => actions.sendMessage(channelId, {
      content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [],
    }, undefined, {})
    state.draft = (channelId, text) => {
      const existing: string = drafts.getDraft(channelId, 0) ?? ''
      const addition = existing.trim() ? `\n${text}` : text
      const box = selected.getChannelId() === channelId ? componentDispatch() : undefined
      if (box) {
        // The open message box: type at the cursor, like a paste.
        box.dispatchToLastSubscribed('INSERT_TEXT', { plainText: addition, rawText: addition })
        return 'inserted'
      }
      // Another chat: append to its saved draft, shown when you open it.
      draftActions.changeDraft(channelId, existing + addition, 0)
      return 'drafted'
    }
    state.getMessage = (channelId, messageId) => {
      const message = messages.getMessage(channelId, messageId)
      return message ? describe(message) : null
    }
    state.recent = (channelId, limit) => {
      const id: string = channelId ?? selected.getChannelId()
      const list: Store[] = messages.getMessages(id)?.toArray?.() ?? []
      return {
        channelId: id,
        channelName: channelName(channels.getChannel(id)),
        messages: list.slice(-limit).map(m => ({
          id: m.id,
          author: authorName(m),
          mine: m.author?.id === me(),
          content: m.content ?? '',
          images: ((m.attachments ?? []) as Store[]).filter(isImage).length,
          stickers: ((m.stickerItems ?? m.sticker_items ?? []) as Store[]).map(s => s.name),
          timestamp: m.timestamp?.toISOString?.() ?? String(m.timestamp),
        })),
      }
    }
    state.ready = true
    reportOpenChat()
    return true
  }

  if (start()) return 'installed'
  state.timer = setInterval(() => { if (start()) clearInterval(state.timer) }, 1000)
  return 'waiting-for-discord'
})()

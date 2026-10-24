// Runs inside the Discord window (injected over DevTools). Reports new messages and
// chat switches to DSH through the `__dshDiscordEmit` binding and exposes
// `__dshDiscordBridge`: `draft` puts text into a chat's message box (you press Enter),
// `send` posts it, `getMessage` reads one loaded message.
(() => {
  // Replace any earlier copy so plugin updates take effect without reloading Discord.
  try { window.__dshDiscordBridge?.stop?.(); } catch {}
  clearInterval(window.__dshDiscordBridge?.timer);
  const state = window.__dshDiscordBridge = { ready: false };
  const start = () => {
    const W = window.BdApi?.Webpack;
    if (!W) return false;
    const dispatcher = W.getModule(m => typeof m?.subscribe === 'function' && typeof m?.dispatch === 'function' && typeof m?.unsubscribe === 'function', { searchExports: true });
    const actions = W.getByKeys('sendMessage', 'editMessage');
    const users = W.getStore('UserStore');
    const channels = W.getStore('ChannelStore');
    const selected = W.getStore('SelectedChannelStore');
    const messages = W.getStore('MessageStore');
    const drafts = W.getStore('DraftStore');
    const draftActions = W.getModule(m => typeof m?.changeDraft === 'function' && typeof m?.clearDraft === 'function', { searchExports: true });
    // Discord has several ComponentDispatch instances; the chat box listens on the one with INSERT_TEXT.
    const componentDispatch = () => (W.getModule(m => typeof m?.dispatchToLastSubscribed === 'function', { searchExports: true, first: false }) ?? [])
      .find(m => m.hasSubscribers?.('INSERT_TEXT'));
    if (!dispatcher || !actions || !users?.getCurrentUser() || !channels || !selected || !messages || !drafts || !draftActions) return false;

    const emit = event => window.__dshDiscordEmit(JSON.stringify(event));
    const channelName = (ch) => {
      if (!ch) return '';
      if (ch.name) return ch.name;
      const ids = ch.recipients ?? [];
      return ids.map(id => users.getUser(id)?.globalName ?? users.getUser(id)?.username ?? id).join(', ');
    };
    const describe = (message) => {
      const ch = channels.getChannel(message.channel_id);
      const author = message.author ?? {};
      return {
        type: 'message',
        id: message.id,
        channelId: message.channel_id,
        channelName: channelName(ch),
        guildId: message.guild_id ?? ch?.guild_id ?? null,
        isOpenChannel: selected.getChannelId() === message.channel_id,
        author: message.member?.nick ?? message.nick ?? author.global_name ?? author.globalName ?? author.username,
        content: message.content ?? '',
        images: (message.attachments ?? [])
          .filter(a => (a.content_type ?? '').startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.filename ?? ''))
          .map(a => ({ url: a.url, proxyUrl: a.proxy_url, filename: a.filename, size: a.size })),
      };
    };
    const onCreate = ({ message, optimistic }) => {
      try {
        const me = users.getCurrentUser()?.id;
        if (optimistic || !message || message.author?.id === me || message.author?.bot) return;
        emit(describe(message));
      } catch (error) {
        console.error('[dsh-discord-autoreply]', error);
      }
    };
    const reportOpenChat = () => {
      const channelId = selected.getChannelId();
      if (channelId) emit({ type: 'channel-open', channelId, channelName: channelName(channels.getChannel(channelId)) });
    };
    const onSelect = () => setTimeout(reportOpenChat, 0);
    dispatcher.subscribe('MESSAGE_CREATE', onCreate);
    dispatcher.subscribe('CHANNEL_SELECT', onSelect);
    state.stop = () => {
      dispatcher.unsubscribe('MESSAGE_CREATE', onCreate);
      dispatcher.unsubscribe('CHANNEL_SELECT', onSelect);
    };
    state.send = (channelId, content) => actions.sendMessage(channelId, {
      content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [],
    }, undefined, {});
    state.draft = (channelId, text) => {
      const existing = drafts.getDraft(channelId, 0) ?? '';
      const addition = existing.trim() ? `\n${text}` : text;
      const box = selected.getChannelId() === channelId ? componentDispatch() : undefined;
      if (box) {
        // The open message box: type at the cursor, like a paste.
        box.dispatchToLastSubscribed('INSERT_TEXT', { plainText: addition, rawText: addition });
        return 'inserted';
      }
      // Another chat: append to its saved draft, shown when you open it.
      draftActions.changeDraft(channelId, existing + addition, 0);
      return 'drafted';
    };
    state.getMessage = (channelId, messageId) => {
      const message = messages.getMessage(channelId, messageId);
      return message ? describe(message) : null;
    };
    state.ready = true;
    reportOpenChat();
    return true;
  };
  if (start()) return 'installed';
  state.timer = setInterval(() => { if (start()) clearInterval(state.timer); }, 1000);
  return 'waiting-for-discord';
})()

// Runs inside the Discord window (injected over DevTools). Forwards new messages
// to DSH through the `__dshDiscordEmit` binding and exposes `__dshDiscordBridge`:
// `draft` puts text into a channel's message box (you press Enter), `send` posts it.
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
    const drafts = W.getStore('DraftStore');
    const draftActions = W.getModule(m => typeof m?.changeDraft === 'function' && typeof m?.clearDraft === 'function', { searchExports: true });
    const componentDispatch = W.getModule(m => typeof m?.dispatchToLastSubscribed === 'function' && typeof m?.dispatch === 'function', { searchExports: true });
    if (!dispatcher || !actions || !users?.getCurrentUser() || !channels || !selected || !drafts || !draftActions) return false;

    const channelName = (ch) => {
      if (!ch) return '';
      if (ch.name) return ch.name;
      const ids = ch.recipients ?? [];
      return ids.map(id => users.getUser(id)?.globalName ?? users.getUser(id)?.username ?? id).join(', ');
    };
    const onCreate = ({ message, optimistic }) => {
      try {
        const me = users.getCurrentUser()?.id;
        if (optimistic || !message || message.author?.id === me || message.author?.bot) return;
        const ch = channels.getChannel(message.channel_id);
        window.__dshDiscordEmit(JSON.stringify({
          id: message.id,
          channelId: message.channel_id,
          channelName: channelName(ch),
          guildId: message.guild_id ?? ch?.guild_id ?? null,
          isOpenChannel: selected.getChannelId() === message.channel_id,
          author: message.member?.nick ?? message.author.global_name ?? message.author.username,
          content: message.content ?? '',
          images: (message.attachments ?? [])
            .filter(a => (a.content_type ?? '').startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.filename ?? ''))
            .map(a => ({ url: a.url, proxyUrl: a.proxy_url, filename: a.filename, size: a.size })),
        }));
      } catch (error) {
        console.error('[dsh-discord-autoreply]', error);
      }
    };
    dispatcher.subscribe('MESSAGE_CREATE', onCreate);
    state.stop = () => dispatcher.unsubscribe('MESSAGE_CREATE', onCreate);
    state.send = (channelId, content) => actions.sendMessage(channelId, {
      content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [],
    }, undefined, {});
    state.draft = (channelId, text) => {
      const existing = drafts.getDraft(channelId, 0) ?? '';
      const addition = existing.trim() ? `\n${text}` : text;
      if (selected.getChannelId() === channelId && componentDispatch) {
        // The open message box: type at the cursor, like a paste.
        componentDispatch.dispatchToLastSubscribed('INSERT_TEXT', { plainText: addition, rawText: addition });
        return 'inserted';
      }
      // Another chat: append to its saved draft, shown when you open it.
      draftActions.changeDraft(channelId, existing + addition, 0);
      return 'drafted';
    };
    state.ready = true;
    return true;
  };
  if (start()) return 'installed';
  state.timer = setInterval(() => { if (start()) clearInterval(state.timer); }, 1000);
  return 'waiting-for-discord';
})()

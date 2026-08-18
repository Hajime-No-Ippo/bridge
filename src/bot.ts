import { Bot, InputFile } from 'grammy';
import { config } from './config';
import { classifyReaction, FALLBACK_EMOJI } from './classify';
import { activity, log } from './log';
import { fetchAttachment } from './attachments';
import { OpencodeHttpError, opencode, type PromptPart } from './opencode';
import { pendingPermissions, pendingQuestions, supersedeQuestions, type Relay } from './relay';
import { registerRename } from './rename';
import { registerModel } from './model';
import { registerNew } from './new_session';
import { discard, takeScreenshot } from './back_slash_commands/screenshot';
import { checkAttachment, parseDeny } from './vision';
import { createPost, parsePostCommand } from './tools/post_new_blogs';

/** Parsed once — ATTACHMENT_DENY cannot change without a restart anyway. */
const denyList = parseDeny(config.attachmentDeny);

// Tracks chats that are mid- /post flow — awaiting blog content.
const pendingPosts = new Map<number, { title: string; summary?: string }>();

// Single source of truth for the command list — /start and /help both send it,
// so the two can never drift apart.
const HELP_TEXT =
  '/status — server health and sessions\n' +
  '/sessions — list recent sessions\n' +
  '/new [title] — start a fresh session (keeps the current model)\n' +
  '/rename <title> — rename current session\n' +
  '/model <provider/model-id> — switch model of current session\n' +
  '/screenshot — capture the TUI window\n' +
  '/post [title] — create a blog post\n' +
  '/quit — cancel blog posting\n' +
  '/stop — abort the running session\n' +
  '/whoami — your chat ID, what you are using\n' +
  '/help — this list\n' +
  '!cmd — run a shell command directly';

export function createBot(): Bot {
  const bot = new Bot(config.botToken);

  // Allowlist gate. /whoami is the one thing a stranger may call, so they can be
  // told their ID — it reveals nothing and makes first-time setup possible.
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId !== undefined && config.allowedChatIds.has(chatId)) return next();

    const text = ctx.message?.text ?? '';
    if (text.startsWith('/whoami') || text.trim() === '!whoami') {
      await ctx.reply(`Your chat ID is ${chatId}. Add it to TELEGRAM_ALLOWED_CHAT_IDS.`);
      return;
    }
    console.warn(`[bot] rejected chat ${chatId} (@${ctx.from?.username ?? '?'})`);
    await ctx.reply('Not authorised.');
  });

  bot.command('whoami', async ctx => {
    const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
    const lines = [`Chat ID: ${ctx.chat.id} ✅ allowed`];
    try {
      const session = await opencode.pinnedSession();
      if (session) {
        const model = session.model
          ? `${session.model.providerID}/${session.model.id}`
          : 'n/a';
        const t = session.tokens ?? {};
        const tokens = `${fmt(t.input ?? 0)} in / ${fmt(t.output ?? 0)} out` +
          (t.reasoning ? ` / ${fmt(t.reasoning)} reasoning` : '');
        const cost = session.cost ? `$${session.cost.toFixed(2)}` : '$0.00';
        lines.push(
          `Session: ${session.title ?? session.slug ?? session.id}`,
          `Model: ${model}`,
          `Tokens: ${tokens}`,
          `Cost: ${cost}`,
        );
      }
    } catch {
      lines.push('Session: unavailable');
    }
    await ctx.reply(lines.join('\n'));
  });

  bot.command('start', ctx =>
    ctx.reply(
      'Bridged to opencode. Anything you send is typed into the attached TUI and submitted.\n\n' +
      HELP_TEXT,
    ),
  );

  bot.command('help', ctx => ctx.reply(HELP_TEXT));

  bot.command('status', async ctx => {
    try {
      const health = await opencode.health();
      const sessions = await opencode.listSessions();
      await ctx.reply(
        `opencode: ${health.healthy ? 'healthy ✅' : 'unhealthy ⚠️'}\n` +
        `url: ${config.opencodeUrl}\n` +
        `sessions: ${sessions.length}`,
      );
    } catch (err) {
      await ctx.reply(`Cannot reach opencode at ${config.opencodeUrl}\n${(err as Error).message}`);
    }
  });

  bot.command('sessions', async ctx => {
    try {
      const sessions = await opencode.listSessions();
      const lines = sessions.slice(0, 10).map(s => `• ${s.title ?? '(untitled)'}\n  ${s.id}`);
      await ctx.reply(lines.join('\n') || 'No sessions.');
    } catch (err) {
      await ctx.reply(`Failed: ${(err as Error).message}`);
    }
  });

  bot.command('stop', async ctx => {
    try {
      const session = await opencode.pinnedSession();
      if (!session) return void (await ctx.reply('No session to abort.'));
      await opencode.abort(session.id);
      await ctx.reply(`Aborted ${session.title ?? session.id}`);
    } catch (err) {
      await ctx.reply(`Failed: ${(err as Error).message}`);
    }
  });

  // Sent as a document, not a photo: Telegram re-encodes photos to JPEG and caps
  // the long side at 1280px, which turns terminal text into mush. A document
  // arrives byte-for-byte.
  bot.command('screenshot', async ctx => {
    let shot;
    try {
      shot = takeScreenshot();
    } catch (err) {
      return void (await ctx.reply((err as Error).message));
    }
    try {
      await ctx.replyWithDocument(new InputFile(shot.path), {
        caption: shot.scope === 'window'
          ? '📸 opencode TUI window'
          : '📸 full display (could not find the TUI window)',
      });
    } catch (err) {
      await ctx.reply(`Could not send the screenshot: ${(err as Error).message}`);
    } finally {
      discard(shot.path);
    }
  });

  registerRename(bot);
  registerModel(bot);
  registerNew(bot);

  // /post — enter blog-posting flow: /post [Title]
  bot.command('post', async ctx => {
    const title = (ctx.message.text ?? '')
      .replace(/^\/post\s*/i, '')
      .trim();

    pendingPosts.set(ctx.chat.id, { title: title || undefined });
    await ctx.reply(
      title
        ? `Title: "${title}"\nPlease send your blog below. Send /quit to cancel.`
        : 'Please send your blog below. Send /quit to cancel.',
    );
  });

  bot.command('quit', async ctx => {
    if (pendingPosts.delete(ctx.chat.id)) {
      await ctx.reply('Post cancelled.');
    }
  });

  bot.on('callback_query:data', async ctx => {
    const [kind, ...rest] = ctx.callbackQuery.data.split('|');

    if (kind === 'perm') {
      const [reply, token] = rest;
      // The ids are held server-side; the button only carries a short token,
      // because the full pair overflows Telegram's 64-byte callback_data cap.
      const pending = pendingPermissions.get(String(token));
      if (!pending) {
        await ctx.answerCallbackQuery('That permission prompt is no longer pending');
        return;
      }
      try {
        await opencode.replyPermission(
          pending.requestID,
          pending.sessionID,
          reply as 'once' | 'always' | 'reject',
        );
        pendingPermissions.delete(String(token));
        await ctx.answerCallbackQuery(`Replied: ${reply}`);
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        await ctx.reply(reply === 'reject' ? '⛔️ Denied' : `✅ Approved (${reply})`);
      } catch (err) {
        // Already resolved — by an `always` rule granted moments earlier, or
        // because the turn moved on. The answer simply is not needed, so retire
        // the buttons quietly instead of reporting a failure the user cannot act on.
        if (err instanceof OpencodeHttpError && err.isPermissionGone) {
          pendingPermissions.delete(String(token));
          log.info('permission', `${pending.requestID} was already resolved — retiring buttons`);
          await ctx.answerCallbackQuery('Already handled');
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => { });
          return;
        }
        log.error('permission', 'reply failed:', (err as Error).message);
        await ctx.answerCallbackQuery('Failed');
        await ctx.reply(`Permission reply failed: ${(err as Error).message}`);
      }
      return;
    }

    if (kind === 'ask') {
      const [token, index] = rest;
      const entry = pendingQuestions.get(String(token));
      if (!entry) {
        await ctx.answerCallbackQuery('That question is no longer pending');
        return;
      }
      const { requestID, question } = entry;
      const label = question?.options?.[Number(index)]?.label;
      try {
        await opencode.replyQuestion(requestID, [[String(label ?? index)]]);
        pendingQuestions.delete(String(token));
        await ctx.answerCallbackQuery(`Answered: ${label}`);
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } catch (err) {
        // Mirrors the permission branch above: the question was already settled
        // — answered in the TUI, or superseded by a prompt sent since. Retire
        // the buttons quietly rather than reporting a failure that names
        // nothing the user can do about it.
        if (err instanceof OpencodeHttpError && err.isQuestionGone) {
          pendingQuestions.delete(String(token));
          log.info('question', `${requestID} was already resolved — retiring buttons`);
          await ctx.answerCallbackQuery('Already handled');
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => { });
          return;
        }
        log.error('question', 'answer failed:', (err as Error).message);
        await ctx.answerCallbackQuery('Failed');
        await ctx.reply(`Answer failed: ${(err as Error).message}`);
      }
      return;
    }

    await ctx.answerCallbackQuery();
  });

  /**
   * Resolve the session, submit, arm the silence watchdog, react.
   *
   * Shared by the text and attachment handlers — the two differ only in the
   * parts they build, and keeping one copy of the submit path is what stops the
   * session-resolution ordering below from being got right in one and wrong in
   * the other.
   */
  async function submitTurn(
    ctx: any,
    parts: PromptPart[],
    opts: { classifyOn?: string; label: string },
  ): Promise<void> {
    try {
      // A question BLOCKS the turn and only its buttons can answer it, so a new
      // prompt sent while one is outstanding used to queue behind a block this
      // message could never clear — the session simply went quiet. Sending
      // anything at all is the user moving on, so retire the question first.
      const dropped = await supersedeQuestions(bot);
      if (dropped) {
        await ctx.reply(
          `❓ ${dropped === 1 ? 'An unanswered question was' : `${dropped} unanswered questions were`} ` +
          'dismissed — your message goes in as a new prompt instead.',
        );
      }
      // Permissions are NOT dismissed the same way: a typed message must never
      // stand in for Approve/Deny. All the bridge can do is say why the turn is
      // still stuck, so the block is visible instead of silent.
      if (pendingPermissions.size > 0) {
        await ctx.reply(
          `🔐 ${pendingPermissions.size} permission request(s) still waiting — the turn stays ` +
          'blocked until you tap Once / Always / Deny.',
        );
      }

      const session = await opencode.currentSession();

      const emojiPromise = opts.classifyOn ? classifyReaction(opts.classifyOn) : undefined;
      await opencode.showToast(`telegram: ${opts.label.slice(0, 40)}`, 'info');

      const before = activity.working;
      await opencode.promptAsync(session.id, parts);
      log.info('prompt', `submitted (${opts.label}) to ${session.id}`);

      setTimeout(() => {
        if (activity.working !== before) return;
        log.warn('silence', `no session activity ${config.silenceWarnMs}ms after submit`);
        void ctx
          .reply(
            '🔇 The prompt was accepted but nothing is processing it.\n' +
            `Session: <code>${session.id}</code>\n` +
            'Check the opencode server is still up and the session is not blocked.',
            { parse_mode: 'HTML' },
          )
          .catch((err: Error) => log.error('silence', 'warn failed:', err.message));
      }, config.silenceWarnMs);

      await ctx.react(FALLBACK_EMOJI).catch(() => { });
      if (emojiPromise) {
        const emoji = await emojiPromise;
        if (emoji !== FALLBACK_EMOJI) await ctx.react(emoji).catch(() => { });
      }
    } catch (err) {
      log.error('prompt', 'turn failed:', (err as Error).message);
      await ctx.reply(`Could not reach opencode: ${(err as Error).message}`);
    }
  }

  // Photos, and documents sent as files. Telegram delivers a photo as an array
  // of sizes smallest-first, so the last entry is the full-resolution one —
  // taking any other gives the model a thumbnail to squint at.
  bot.on(['message:photo', 'message:document'], async ctx => {
    const doc = ctx.message?.document;
    const photo = ctx.message?.photo?.at(-1);
    const caption = (ctx.message?.caption ?? '').trim();

    // Checked BEFORE the download: an attachment the model cannot read poisons
    // the session permanently once it is in the history, and there is no reason
    // to pull 8MB over the wire only to refuse it.
    const check = await checkAttachment(
      doc?.mime_type ?? (photo ? 'image/jpeg' : undefined),
      doc?.file_name,
      denyList,
    );
    if (!check.allow) {
      await ctx.reply(check.message!, { parse_mode: 'HTML' });
      return;
    }

    const got = await fetchAttachment(ctx, {
      fileId: doc?.file_id ?? photo!.file_id,
      filename: doc?.file_name,
      mime: doc?.mime_type,
      declaredSize: doc?.file_size ?? photo?.file_size,
    });

    if ('error' in got) {
      await ctx.reply(`Could not take that file — ${got.error}`);
      return;
    }

    // The caption is the prompt. Without one there is no instruction at all, so
    // supply a neutral default rather than sending a bare file and hoping.
    const text = caption || 'Look at the attached file and describe what it contains.';
    await submitTurn(
      ctx,
      [got.part, { type: 'text', text }],
      { classifyOn: caption || undefined, label: `${got.filename} + ${text.length} chars` },
    );
  });

  bot.on('message:text', async ctx => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;

    // Check if this chat is in the /post flow
    const pending = pendingPosts.get(ctx.chat.id);
    if (pending) {
      pendingPosts.delete(ctx.chat.id);
      const title = pending.title || text.split('\n')[0].slice(0, 80);
      await ctx.reply(`Creating post "${title}"...`);
      const result = createPost({ title, content: text });
      if (result.ok) {
        await ctx.reply(`Post created: ${result.slug}\nCommitted and pushed to origin.`);
      } else {
        await ctx.reply(`Failed to create post: ${result.error}`);
      }
      return;
    }

    // `!cmd` runs the shell directly instead of prompting the model. Note this
    // path is NOT gated by opencode's permission prompts — the command is
    // recorded as user-executed, so no Approve/Deny button appears for it.
    if (text.startsWith('!')) {
      const command = text.slice(1).trim();
      if (!command) return void (await ctx.reply('Usage: <code>!ls -la</code>', { parse_mode: 'HTML' }));
      try {
        const session = await opencode.currentSession();
        await opencode.showToast(`telegram !: ${command.slice(0, 40)}`, 'warning');
        await opencode.runShell(session.id, command);
        await ctx.react('⚡').catch(() => { });
      } catch (err) {
        await ctx.reply(`Shell failed: ${(err as Error).message}`);
      }
      return;
    }

    await submitTurn(ctx, [{ type: 'text', text }], {
      classifyOn: text,
      label: `${text.length} chars`,
    });
  });

  bot.catch(err => console.error('[bot] error:', err.message));

  return bot;
}

/** /send <path> — forward a local file (under $HOME) to the allowed chats. */
export function registerSend(bot: Bot, relay: Relay) {
  bot.command('send', async ctx => {
    const path = ctx.match?.trim();
    if (!path) return void (await ctx.reply('Usage: /send <path>'));
    const ok = await relay.sendFile(path);
    if (!ok) await ctx.reply('No such file (only paths under your home directory).');
  });
}

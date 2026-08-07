import type { Bot } from 'grammy';
import { log } from './log';
import { opencode } from './opencode';

/**
 * /new [title] — start a fresh session and make it the one prompts go to.
 *
 * Until this existed there was no session boundary at all. `submitTurn` resolves
 * its target with `latestSession()`, which returns the most recently updated
 * session and only creates one when there are none — so every message from
 * Telegram appended to the same thread forever. That is how a session reached
 * 930 messages carrying five inlined attachments, and why one PDF the model
 * could not read broke every turn after it with no way out from the phone.
 *
 * The mechanism is deliberately indirect: this does not "select" anything,
 * because there is nothing to select into. Creating a session makes it the most
 * recently updated one, and `/session` is ordered newest-first, so the next
 * prompt lands here on its own. No new targeting state to keep in sync.
 *
 * The model is carried over rather than left to the server default. Someone
 * typing /new is drawing a line under a task, not asking to be moved to a
 * different model — and silently switching would be found out one prompt later,
 * detached from the command that caused it.
 */
export function registerNew(bot: Bot): void {
  bot.command('new', async ctx => {
    const title = (typeof ctx.match === 'string' ? ctx.match : '').trim();

    // Read BEFORE creating: afterwards the new session is the latest one, and
    // the model to inherit would be its own default rather than the old one's.
    const previous = await opencode.latestSession().catch(() => undefined);

    let session;
    try {
      session = await opencode.createSession();
    } catch (err) {
      await ctx.reply(`Could not start a new session: ${(err as Error).message}`);
      return;
    }

    // Everything past this point is best-effort. The session exists and is
    // already the target, so a failure here is cosmetic — reporting it as a
    // failed command would be worse than a session with a default title.
    const notes: string[] = [];

    const model = previous?.model;
    if (model?.providerID && model?.id) {
      try {
        await opencode.switchModel(session.id, model.providerID, model.id);
      } catch (err) {
        log.warn('new', `model carry-over failed: ${(err as Error).message}`);
        notes.push('could not carry the model over — check /model');
      }
    }

    if (title) {
      try {
        await opencode.renameSession(session.id, title);
      } catch (err) {
        log.warn('new', `rename failed: ${(err as Error).message}`);
        notes.push('could not set the title — use /rename');
      }
    }

    log.info('new', `session ${session.id} created${title ? ` as "${title}"` : ''}`);

    const modelLine = model?.providerID && model?.id
      ? `\nModel: <code>${model.providerID}/${model.id}</code>`
      : '';
    const from = previous ? `\nPrevious: ${previous.title ?? previous.id} (kept, see /sessions)` : '';
    const warn = notes.length ? `\n\n⚠️ ${notes.join('; ')}` : '';

    await ctx.reply(
      `🆕 <b>${title || session.title || 'New session'}</b>\n` +
      `Prompts now go here — fresh context.${modelLine}${from}${warn}`,
      { parse_mode: 'HTML' },
    );
  });
}

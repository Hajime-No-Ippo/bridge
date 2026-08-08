import type { Bot } from 'grammy';
import { log } from './log';
import { opencode } from './opencode';

/**
 * /new [title] — start a fresh session and make it the one prompts go to.
 *
 * Until this existed there was no session boundary at all. `submitTurn`
 * resolved its target with whatever session the bridge was pinned to, and
 * nothing ever moved that pin — so every message from Telegram appended to
 * the same thread forever. That is how a session reached 930 messages
 * carrying five inlined attachments, and why one PDF the model could not read
 * broke every turn after it with no way out from the phone.
 *
 * Creating a session does NOT make it the target on its own — pinning is
 * explicit state now (see session_pin.ts), precisely so the bridge can never
 * again drift onto some other session just because it happened to be the
 * most recently touched one. `pinSession` below is what actually moves the
 * target; skipping it would leave /new creating sessions nothing ever uses.
 *
 * The model is carried over rather than left to the server default. Someone
 * typing /new is drawing a line under a task, not asking to be moved to a
 * different model — and silently switching would be found out one prompt later,
 * detached from the command that caused it.
 */
export function registerNew(bot: Bot): void {
  bot.command('new', async ctx => {
    const title = (typeof ctx.match === 'string' ? ctx.match : '').trim();

    // Read BEFORE re-pinning: afterwards opencode.pinnedSession() would
    // return the new session, and the model to inherit would be its own
    // default rather than the old one's.
    const previous = await opencode.pinnedSession();

    let session;
    try {
      session = await opencode.createSession();
    } catch (err) {
      await ctx.reply(`Could not start a new session: ${(err as Error).message}`);
      return;
    }
    opencode.pinSession(session.id);

    // Everything past this point is best-effort. The session exists and is
    // already the target, so a failure here is cosmetic — reporting it as a
    // failed command would be worse than a session with a default title.
    const notes: string[] = [];

    // Prefer a /model queued on the old session over its last actually-used
    // model — otherwise /model immediately followed by /new would silently
    // drop the switch the user just asked for.
    const queued = previous ? opencode.getModel(previous.id) : undefined;
    const model = queued ?? previous?.model;
    if (model?.providerID && model?.id) {
      opencode.setModel(session.id, model.providerID, model.id);
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

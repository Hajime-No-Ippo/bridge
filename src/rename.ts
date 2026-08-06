import type { Bot } from 'grammy';
import { opencode } from './opencode';

export function registerRename(bot: Bot) {
  bot.command('rename', async ctx => {
    const msg = ctx.message;
    if (!msg) return;
    const arg = msg.text.replace(/^\/rename\s*/, '').trim();
    if (!arg) {
      await ctx.reply('Usage: /rename New Session Title');
      return;
    }

    try {
      const sessions = await opencode.listSessions();
      const latest = sessions[0];
      if (!latest) {
        console.log("[RENAME]: Rename failed, latest session not found.");
        await ctx.reply('No session to rename.');
        return;
      }

      const oldTitle = latest.title ?? latest.id;
      await opencode.renameSession(latest.id, arg);
      console.log("[RENAME]: Rename Succeed, new session name updated.");
      await ctx.reply(`Renamed "${oldTitle}" → "${arg}"`);
    } catch (err) {
      await ctx.reply(`Rename failed: ${(err as Error).message}`);
    }
  });
}

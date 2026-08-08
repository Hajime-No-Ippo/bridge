import type { Bot } from 'grammy';
import { log } from './log';
import { type ModelInfo, opencode, type SessionInfo } from './opencode';

/** `provider/id`, the form the switch endpoint actually wants. */
export const ref = (m: ModelInfo): string => `${m.providerID}/${m.id}`;

/**
 * Compare loosely: case, separators and spacing carry no meaning here.
 *
 * `DeepSeek/v4 pro`, `deepseek-v4-pro` and `deepseek_v4_pro` are the same
 * intent typed three ways, and the old exact-match guard treated all of them
 * as distinct — which is how a typo became a bricked session.
 */
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Dice coefficient over character bigrams — 0 (nothing alike) to 1 (identical). */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const ga = bigrams(a);
  const gb = bigrams(b);
  let shared = 0;
  for (const [g, n] of ga) shared += Math.min(n, gb.get(g) ?? 0);
  return (2 * shared) / (a.length - 1 + b.length - 1);
}

export type Resolution =
  /** One model matched — safe to switch to it. */
  | { kind: 'match'; model: ModelInfo; exact: boolean }
  /** Several matched; switching would be a guess. */
  | { kind: 'ambiguous'; candidates: ModelInfo[] }
  /**
   * Nothing matched, but the input is a well-formed `provider/id`.
   *
   * NOT an error. The server's own "did you mean" suggestions name models that
   * are absent from `/api/model` — the two catalogues genuinely disagree — so a
   * hard block here would reject opencode's own advice. Switch, and say plainly
   * that it could not be verified.
   */
  | { kind: 'unverified'; providerID: string; id: string; near: ModelInfo[] }
  /** Nothing matched and there is nothing safe to send. */
  | { kind: 'unknown'; near: ModelInfo[] };

const NEAR_LIMIT = 5;

function nearest(input: string, models: ModelInfo[]): ModelInfo[] {
  const q = norm(input);
  return models
    .map(m => ({ m, score: Math.max(similarity(q, norm(m.id)), similarity(q, norm(ref(m)))) }))
    .filter(x => x.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, NEAR_LIMIT)
    .map(x => x.m);
}

/**
 * Map whatever the user typed onto a real model.
 *
 * Bare ids are accepted deliberately: when a model is wrong the server replies
 * "Did you mean: deepseek-v4-pro?", and that suggestion has no provider prefix.
 * Requiring `provider/id` made the one message that could fix the session the
 * one message the bridge refused.
 */
export function resolveModel(input: string, models: ModelInfo[]): Resolution {
  const raw = input.trim();
  const q = norm(raw);

  // 1. Exact on the full ref, ignoring case and separators.
  const full = models.filter(m => norm(ref(m)) === q);
  if (full.length === 1) return { kind: 'match', model: full[0]!, exact: true };

  // 2. Exact on the bare id — the shape the server suggests.
  const bare = models.filter(m => norm(m.id) === q);
  if (bare.length === 1) return { kind: 'match', model: bare[0]!, exact: true };
  if (bare.length > 1) return { kind: 'ambiguous', candidates: bare };

  // 3. Containment either way, so a partial like `kimi` still lands.
  const loose = models.filter(m => {
    const id = norm(m.id);
    return id.includes(q) || q.includes(id) || norm(ref(m)).includes(q);
  });
  if (loose.length === 1) return { kind: 'match', model: loose[0]!, exact: false };
  if (loose.length > 1) return { kind: 'ambiguous', candidates: loose };

  // 4. No match. A well-formed provider/id may still go through, flagged —
  //    but only if the PROVIDER is one the server knows.
  //
  //    The two catalogues disagree about models, not providers: the server's
  //    "did you mean" names a bare model id, while providers come from config
  //    and /api/model lists them all. So an unrecognised model under a real
  //    provider is worth attempting, and an unrecognised provider is not — that
  //    is `deepseek/v4 pro`, which cannot work and bricks the session until
  //    something valid replaces it.
  const slash = raw.indexOf('/');
  if (slash > 0 && slash < raw.length - 1) {
    const providerID = raw.slice(0, slash);
    const known = models.some(m => norm(m.providerID) === norm(providerID));
    if (known || models.length === 0) {
      return { kind: 'unverified', providerID, id: raw.slice(slash + 1), near: nearest(raw, models) };
    }
  }

  return { kind: 'unknown', near: nearest(raw, models) };
}

const list = (models: ModelInfo[]): string => models.map(m => `• <code>${ref(m)}</code>`).join('\n');

/**
 * /model <ref> — queue a model for the most recently updated session's next
 * prompt.
 *
 * There is no server-side "switch model" call to make — see the comment on
 * `opencode.setModel`. Resolving before queuing still matters: the server
 * accepts anything, so an unresolved ref would only fail on the NEXT prompt,
 * as a session error detached from the command that caused it.
 */
export function registerModel(bot: Bot): void {
  bot.command('models', async ctx => {
    try {
      const models = await opencode.listModels();
      if (!models.length) return void (await ctx.reply('The server reports no models.'));
      const byProvider = new Map<string, ModelInfo[]>();
      for (const m of models) {
        if (!byProvider.has(m.providerID)) byProvider.set(m.providerID, []);
        byProvider.get(m.providerID)!.push(m);
      }
      const body = [...byProvider.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([provider, ms]) =>
          `<b>${provider}</b>\n` +
          ms.map(m => `  <code>${m.id}</code>`).sort().join('\n'),
        )
        .join('\n\n');
      // Telegram rejects anything past 4096 chars, and a rejected list is worse
      // than a clipped one — the whole point is to show what you can type.
      const capped = body.length > 3900 ? `${body.slice(0, 3900)}\n\n… truncated` : body;
      await ctx.reply(`${models.length} models — pass any id to /model\n\n${capped}`, {
        parse_mode: 'HTML',
      });
    } catch (err) {
      await ctx.reply(`Could not list models: ${(err as Error).message}`);
    }
  });

  bot.command('model', async ctx => {
    const arg = (typeof ctx.match === 'string' ? ctx.match : '').trim();
    if (!arg) {
      await ctx.reply('Usage: <code>/model &lt;model-id&gt;</code> — <code>/models</code> lists them.', {
        parse_mode: 'HTML',
      });
      return;
    }

    let session: SessionInfo;
    try {
      session = await opencode.currentSession();
    } catch (err) {
      await ctx.reply(`Could not resolve the session: ${(err as Error).message}`);
      return;
    }

    let models: ModelInfo[] = [];
    try {
      models = await opencode.listModels();
    } catch (err) {
      // Refuse rather than fall through to the unverified path. With an empty
      // catalogue every well-formed ref is permitted, so a transient fetch
      // failure silently APPLIED a bad model — which is why the same command
      // answered "nothing was changed" once and "set it" the next time.
      log.warn('model', `catalogue unavailable: ${(err as Error).message}`);
      await ctx.reply(
        'Could not reach the model catalogue, so nothing was changed.\n' +
        'Is the opencode server up? Try again in a moment.',
      );
      return;
    }

    const found = resolveModel(arg, models);

    if (found.kind === 'ambiguous') {
      await ctx.reply(
        `“${arg}” matches ${found.candidates.length} models — be more specific:\n${list(found.candidates)}`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    if (found.kind === 'unknown') {
      const hint = found.near.length ? `\n\nClosest:\n${list(found.near)}` : '\n\nTry <code>/models</code>.';
      await ctx.reply(`No model matches “${arg}”. Nothing was changed.${hint}`, { parse_mode: 'HTML' });
      return;
    }

    const providerID = found.kind === 'match' ? found.model.providerID : found.providerID;
    const id = found.kind === 'match' ? found.model.id : found.id;

    opencode.setModel(session.id, providerID, id);

    const where = session.title ?? session.id;
    if (found.kind === 'unverified') {
      const hint = found.near.length ? `\n\nDid you mean:\n${list(found.near)}` : '';
      await ctx.reply(
        `⚠️ Queued <code>${providerID}/${id}</code> for ${where}'s next message, but the server ` +
        `does not list it.\nIf that message fails with “Model not found”, this ref is wrong.${hint}`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    const note = found.exact ? '' : ` (matched “${arg}”)`;
    await ctx.reply(`✅ ${where}'s next message will use <code>${ref(found.model)}</code>${note}.`, {
      parse_mode: 'HTML',
    });
  });
}

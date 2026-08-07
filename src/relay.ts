import type { Bot } from 'grammy';
import { InlineKeyboard, InputFile } from 'grammy';
import { existsSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import os from 'node:os';
import { config } from './config';
import { log, noteWorking } from './log';
import { internalSessions, opencode, type OpencodeEvent } from './opencode';
import { TG_LIMIT, extractImagePaths, renderTool, splitAt, toTelegramHtml } from './render';
import { TaskKind } from './classify';
import { explainAttachmentRejection } from './vision';

interface TurnState {
  order: string[];
  parts: Map<string, string>;
  committed: number;      // chars already finalized into earlier Telegram messages
  reopenFence: boolean;   // true when the last commit cut a code block in two
  messageId?: number;
  lastSent: string;
  timer?: ReturnType<typeof setTimeout>;
  headerSent: boolean;
  skippedUser: boolean;   // skip the first text part of a turn (user's own echo)
}

const chats = () => [...config.allowedChatIds];

/**
 * How often to re-examine what the turn is blocked on.
 *
 * Deliberately far shorter than either threshold it enforces — it decides only
 * how late an expiry or a nudge can be. A sweep with nothing to do costs one
 * `GET /permission` against localhost.
 */
const PENDING_SWEEP_MS = 30_000;

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

/** The role a directory plays, as named in a test case. */
export type DirLabel = 'HOME_DIR' | 'PROJECT_DIR' | 'WRONG_DIR' | 'USER_DIR';

/** The directory name each role resolves to on this machine. */
export type DirKind = 'Users' | 'telegram-bridge' | 'hackathon' | 'erictao';

export const DIR_OF: Record<DirLabel, DirKind> = {
  HOME_DIR: 'Users',
  PROJECT_DIR: 'telegram-bridge',
  WRONG_DIR: 'hackathon',
  USER_DIR: 'erictao',
};

/**
 * What opencode does when a turn touches a given directory — which is what
 * decides whether the bridge has anything to relay.
 *
 * ``permission.asked`` and ``question.asked`` are the events relay already
 * handles below; both BLOCK the turn until the user taps a button, so a
 * dropped one is indistinguishable from a hung session on the Telegram side.
 * ``silence`` is that failure: opencode is waiting but nothing reached the chat.
 */
export type SystemBehavior = 'streams' | 'permission.asked' | 'question.asked' | 'silence' | 'error';

/**
 * Mostly hypothesis — only the `erictao` row has been observed. Fill the rest
 * from real runs before trusting them.
 */
export const SYSTEM_BEHAVIOR: Record<DirKind, SystemBehavior[]> = {
  'telegram-bridge': ['streams'],                    // inside the project: expected to run clean
  'hackathon': ['permission.asked'],                 // parent of the project: expected to prompt
  // CONFIRMED 2026-08-05: `bash ls -la ~/.config/opencode/plugins/` raised
  // permission.asked with action `external_directory`. The turn then hung,
  // because the approve button exceeded CALLBACK_DATA_LIMIT and Telegram
  // rejected the whole message — see the cb() guard below.
  'erictao': ['permission.asked'],                   // home: prompts
  'Users': ['permission.asked', 'error'],            // above home: prompt, or refuse outright
};

/** Resolve a test's directory label to the directory it names. */
export function dirOf(label: DirLabel): DirKind {
  return DIR_OF[label];
}

/**
 * Find which of the known directories an opencode reply was raised from.
 *
 * Returns the DEEPEST match, not the first. "/Users/erictao/hackathon" contains
 * three known names, and the one that decides opencode's behaviour is the
 * innermost — a leftmost match would report every path under home as `Users`.
 */
export function raisedDir(reply: string): DirKind | null {
  const all = [...String(reply).matchAll(/telegram-bridge|hackathon|erictao|Users/g)];
  return all.length ? (all[all.length - 1]![0] as DirKind) : null;
}

export class Relay {
  private turns = new Map<string, TurnState>();
  private titles = new Map<string, string>();
  /** Part updates are cumulative and repeat, so a path must only be sent once. */
  private sentImages = new Set<string>();

  constructor(private bot: Bot) { }

  /**
   * Ship an image the agent just produced. Sent as a document, not a photo:
   * Telegram re-encodes photos to JPEG and caps the long side at 1280px, which
   * is exactly wrong for a UI screenshot you are trying to inspect.
   */
  private async sendImage(path: string, caption: string) {
    for (const chatId of chats()) {
      try {
        await this.bot.api.sendDocument(chatId, new InputFile(path), { caption });
      } catch (err) {
        console.error('[relay] sendDocument failed:', (err as Error).message);
      }
    }
  }

  /**
   * Send an arbitrary local file to every allowed chat, as a document.
   * Paths outside the home directory are refused on principle.
   */
  async sendFile(path: string): Promise<boolean> {
    const expanded = path.startsWith('~/') ? join(os.homedir(), path.slice(2)) : path;
    const resolved = resolve(expanded);
    if (!resolved.startsWith(os.homedir())) return false;
    if (!existsSync(resolved)) return false;
    for (const chatId of chats()) {
      try {
        await this.bot.api.sendDocument(chatId, new InputFile(resolved), {
          caption: `📄 ${basename(resolved)}`,
        });
      } catch (err) {
        console.error('[relay] sendFile failed:', (err as Error).message);
        return false;
      }
    }
    return true;
  }

  /**
   * Forward any images referenced in a chunk of agent output. Existence is
   * checked rather than assumed — the agent mentions plenty of image paths it
   * never created (globs, README references, files it only read about).
   */
  private async relayImages(text: string) {
    for (const path of extractImagePaths(text)) {
      if (this.sentImages.has(path)) continue;
      if (!existsSync(path)) continue;

      const stat = statSync(path);
      // Stale files are not candidates: `ls` output mentions every old
      // screenshot in the temp dir, and the dedupe set resets on restart, so
      // an mtime check is the only thing keeping a listing from re-sending
      // the lot.
      if (Date.now() - stat.mtimeMs > config.imageMaxAgeMs) continue;

      const bytes = stat.size;
      this.sentImages.add(path);   // marked before sending, so a failure is not retried forever
      if (bytes === 0) continue;
      if (bytes > config.maxImageBytes) {
        await this.send(`🖼 <code>${basename(path)}</code> is ${Math.round(bytes / 1e6)}MB — too large to send.`);
        continue;
      }
      console.log('[relay] sending image:', path, bytes, 'bytes');
      await this.sendImage(path, `🖼 ${basename(path)}`);
    }
  }

  /** Broadcast to every allowlisted chat; returns the message id in the first one. */
  private async send(text: string, keyboard?: InlineKeyboard): Promise<number | undefined> {
    let first: number | undefined;
    for (const chatId of chats()) {
      try {
        const msg = await this.bot.api.sendMessage(chatId, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
          link_preview_options: { is_disabled: true },
        });
        first ??= msg.message_id;
      } catch (err) {
        console.error('[relay] sendMessage failed:', (err as Error).message);
      }
    }
    return first;
  }

  private async edit(messageId: number, text: string) {
    for (const chatId of chats()) {
      try {
        await this.bot.api.editMessageText(chatId, messageId, text, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
      } catch (err) {
        const msg = (err as Error).message;
        // "message is not modified" is routine when a debounce fires twice.
        if (!msg.includes('not modified')) console.error('[relay] edit failed:', msg);
      }
    }
  }

  private state(sessionID: string): TurnState {
    let s = this.turns.get(sessionID);
    if (!s) {
      s = { order: [], parts: new Map(), committed: 0, reopenFence: false, lastSent: '', headerSent: false, skippedUser: false };
      this.turns.set(sessionID, s);
    }
    return s;
  }

  private async title(sessionID: string): Promise<string> {
    const cached = this.titles.get(sessionID);
    if (cached) return cached;
    try {
      const s = await opencode.getSession(sessionID);
      const t = s.title || sessionID;
      this.titles.set(sessionID, t);
      return t;
    } catch {
      return sessionID;
    }
  }

  private render(s: TurnState): string {
    return s.order
      .map(id => s.parts.get(id) ?? '')
      .filter(Boolean)
      .join('\n')
      .trimStart();
  }

  private schedule(sessionID: string) {
    const s = this.state(sessionID);
    if (s.timer) return;
    s.timer = setTimeout(() => {
      s.timer = undefined;
      void this.flush(sessionID);
    }, config.editIntervalMs);
  }

  /** Push whatever has accumulated, spilling into new messages past the length cap. */
  private async flush(sessionID: string) {
    const s = this.turns.get(sessionID);
    if (!s) return;

    const full = this.render(s);
    const raw = full.slice(s.committed);
    if (!raw.trim()) {
      log.debug('drop', `flush ${sessionID}: nothing new since last flush`);
      return;
    }
    log.debug('flush', `${sessionID}: ${raw.length} new chars`);
    // If the previous chunk closed mid-block, reopen the block so the fence
    // count in this chunk lines up with what Telegram already rendered.
    let pending = s.reopenFence ? '```\n' + raw : raw;

    if (!s.headerSent) {
      s.headerSent = true;
      await this.send(`▸ <b>${await this.title(sessionID)}</b>`);
    }

    while (pending.length > TG_LIMIT) {
      const cut = splitAt(pending, TG_LIMIT);
      let chunk = pending.slice(0, cut);
      // Odd fence count = cut landed inside a code block. Close it here so
      // this message is balanced; the next chunk will reopen it.
      const oddFence = ((chunk.match(/```/g) ?? []).length % 2) === 1;
      if (oddFence) chunk += '\n```';
      await this.commit(s, chunk);
      // committed counts raw chars only: the 4-char reopen prefix is synthetic.
      s.committed += cut - (s.reopenFence ? 4 : 0);
      s.reopenFence = oddFence;
      s.messageId = undefined;   // force a fresh message for the remainder
      s.lastSent = '';
      pending = full.slice(s.committed);
      if (s.reopenFence) pending = '```\n' + pending;
    }

    if (pending.trim()) await this.commit(s, pending);
  }

  private async commit(s: TurnState, text: string) {
    if (text === s.lastSent) return;
    const html = toTelegramHtml(text);
    if (s.messageId === undefined) {
      s.messageId = await this.send(html);
    } else {
      await this.edit(s.messageId, html);
    }
    s.lastSent = text;
  }

  private finish(sessionID: string) {
    const s = this.turns.get(sessionID);
    if (s?.timer) clearTimeout(s.timer);
    this.turns.delete(sessionID);
  }

  /**
   * Re-post buttons for permissions the server is still waiting on.
   *
   * `pendingPermissions` lives in memory, so a restart orphans every Approve
   * button already in the chat: the tokens they carry are gone, the session
   * stays blocked, and nothing sent from Telegram will ever run again. Reading
   * the server's own pending list on boot is what makes a crash cost seconds
   * instead of needing someone to answer the permission over the API by hand.
   *
   * Never throws — a bridge that will not start because reconciliation failed
   * is strictly worse than one that starts without it.
   */
  async reconcilePermissions(): Promise<number> {
    let restored = 0;
    try {
      const pending = await opencode.listPermissions();
      if (!Array.isArray(pending) || pending.length === 0) {
        log.info('reconcile', 'no permissions were left pending');
        return 0;
      }

      const tracked = new Set([...pendingPermissions.values()].map(p => p.requestID));
      for (const p of pending) {
        if (!p?.id || !p.sessionID) continue;
        if (internalSessions.has(p.sessionID)) continue;
        if (tracked.has(p.id)) continue;   // already answerable — do not double-post

        const token = nextToken();
        const entry: PendingBase = {
          requestID: p.id,
          sessionID: p.sessionID,
          // The server has been blocked on this since before the restart, but
          // how long is not in the pending list. Dating it from the restart is
          // the conservative read: it gives the user the full TTL to answer
          // rather than expiring a freshly re-posted button on arrival.
          askedAt: Date.now(),
          nudgedAt: Date.now(),
        };
        pendingPermissions.set(token, entry);
        const action = p.permission ?? p.action ?? 'unknown action';
        const detail = (p.patterns ?? p.resources ?? []).slice(0, 4).join('\n');
        entry.messageId = await this.send(
          `🔐 <b>Permission still pending</b> (restored after restart)\n` +
          `<code>${action}</code>${detail ? `\n${detail}` : ''}`,
          permissionKeyboard(token),
        );
        restored++;
      }
      log.info('reconcile', `restored ${restored} pending permission(s)`);
    } catch (err) {
      log.warn('reconcile', `could not restore pending permissions: ${(err as Error).message}`);
    }
    return restored;
  }

  /**
   * Re-post buttons for questions the server is still waiting on.
   *
   * The incident this exists for, in full: a question was asked, the bridge
   * restarted, and `pendingQuestions` came back empty. The buttons already in
   * the chat carried tokens that no longer resolved to anything, the supersede
   * gate saw an empty map and so released nothing, and the sweep had no entry
   * to expire. The turn stayed blocked, and every prompt sent afterwards was
   * recorded and then silently never run — three in a row, with no reply and
   * nothing in the chat to explain it.
   *
   * `GET /question` is what makes this recoverable, exactly as `GET /permission`
   * does for the other half. Never throws, for the same reason.
   */
  async reconcileQuestions(): Promise<number> {
    let restored = 0;
    try {
      const pending = await opencode.listQuestions();
      if (!Array.isArray(pending) || pending.length === 0) {
        log.info('reconcile', 'no questions were left pending');
        return 0;
      }

      const tracked = new Set([...pendingQuestions.values()].map(q => q.requestID));
      for (const item of pending) {
        if (!item?.id) continue;
        if (item.sessionID && internalSessions.has(item.sessionID)) continue;
        if (tracked.has(item.id)) continue;   // already answerable — do not double-post
        const q = item.questions?.[0];
        if (!q) continue;

        const token = nextToken();
        const entry = {
          requestID: item.id,
          sessionID: item.sessionID ?? '',
          question: q,
          askedAt: Date.now(),
          nudgedAt: Date.now(),
          messageId: undefined as number | undefined,
        };
        pendingQuestions.set(token, entry);
        entry.messageId = await this.send(
          `❓ <b>${q.header ?? 'Question'}</b> (restored after restart)\n${q.question ?? ''}`,
          questionKeyboard(token, q),
        );
        restored++;
      }
      log.info('reconcile', `restored ${restored} pending question(s)`);
    } catch (err) {
      log.warn('reconcile', `could not restore pending questions: ${(err as Error).message}`);
    }
    return restored;
  }

  /**
   * Forget everything a dead session was blocked on.
   *
   * Called only from `session.error`, never from `session.idle`. A turn that
   * errored can no longer consume an answer, so clearing is safe. Idle is not:
   * whether opencode reports idle *while* waiting on a permission is not
   * settled, and clearing on a wrong guess would revoke a button the user is
   * about to press — strictly worse than the leak it would fix. The sweep below
   * catches the idle case authoritatively instead.
   */
  private async clearPendingFor(sessionID: string): Promise<void> {
    for (const [token, p] of [...pendingPermissions]) {
      if (p.sessionID !== sessionID) continue;
      pendingPermissions.delete(token);
      await retireButtons(this.bot, p.messageId);
    }
    for (const [token, q] of [...pendingQuestions]) {
      if (q.sessionID !== sessionID) continue;
      pendingQuestions.delete(token);
      await retireButtons(this.bot, q.messageId);
    }
  }

  /**
   * Age out blocks nobody answered, and say so.
   *
   * Three passes, ordered so each shrinks the work of the next:
   *
   * 1. Drop permissions the server no longer lists. `GET /permission` is the
   *    authority — one answered in the TUI, or satisfied by a saved `always`
   *    rule, otherwise leaves the bridge's copy behind with live buttons. This
   *    is `reconcilePermissions` run in reverse.
   * 2. Expire anything past `pendingTtlMs`, *actively rejecting it* so the turn
   *    unblocks server-side and not merely in the chat. Forgetting a block
   *    locally would be the original bug with extra steps.
   * 3. Nudge whatever is still waiting, because the message holding the buttons
   *    scrolled off the phone several exchanges ago.
   *
   * Pass 1 runs against both `GET /permission` and `GET /question`, so a block
   * settled in the TUI is noticed within a sweep rather than lingering until
   * the TTL.
   */
  private async sweepPending(): Promise<void> {
    const now = Date.now();

    try {
      const live = new Set((await opencode.listPermissions()).map(p => p.id));
      for (const [token, p] of [...pendingPermissions]) {
        if (live.has(p.requestID)) continue;
        pendingPermissions.delete(token);
        log.info('pending', `permission ${p.requestID} resolved elsewhere — retiring buttons`);
        await retireButtons(this.bot, p.messageId);
      }
    } catch (err) {
      // Server unreachable. Leaving the entries alone is the right call: they
      // may well still be live, and the TTL below is the backstop regardless.
      log.debug('pending', `permission reconcile skipped: ${(err as Error).message}`);
    }

    try {
      const live = new Set((await opencode.listQuestions()).map(q => q.id));
      for (const [token, q] of [...pendingQuestions]) {
        if (live.has(q.requestID)) continue;
        pendingQuestions.delete(token);
        log.info('pending', `question ${q.requestID} resolved elsewhere — retiring buttons`);
        await retireButtons(this.bot, q.messageId);
      }
    } catch (err) {
      log.debug('pending', `question reconcile skipped: ${(err as Error).message}`);
    }

    for (const [token, p] of [...pendingPermissions]) {
      if (now - p.askedAt < config.pendingTtlMs) continue;
      pendingPermissions.delete(token);
      try {
        await opencode.replyPermission(p.requestID, p.sessionID, 'reject');
      } catch (err) {
        log.debug('pending', `expiring ${p.requestID} failed: ${(err as Error).message}`);
      }
      await retireButtons(this.bot, p.messageId);
      await this.send(
        `⏳ <b>Permission expired</b>\nUnanswered for ${minutes(config.pendingTtlMs)}, ` +
        `so it was denied and the turn released.`,
      );
    }

    for (const [token, q] of [...pendingQuestions]) {
      if (now - q.askedAt < config.pendingTtlMs) continue;
      pendingQuestions.delete(token);
      try {
        await opencode.rejectQuestion(q.requestID);
      } catch (err) {
        log.debug('pending', `expiring ${q.requestID} failed: ${(err as Error).message}`);
      }
      await retireButtons(this.bot, q.messageId);
      await this.send(
        `⏳ <b>Question expired</b>\nUnanswered for ${minutes(config.pendingTtlMs)}, ` +
        `so the turn was released. Send your answer as a normal message to carry on.`,
      );
    }

    // Whatever survived both passes is genuinely still holding the turn.
    const due = [...pendingPermissions.values(), ...pendingQuestions.values()]
      .filter(e => now - e.nudgedAt >= config.pendingNudgeMs);
    if (due.length === 0) return;
    for (const e of due) e.nudgedAt = now;
    await this.send(
      `⏳ <b>Still waiting on you</b>\n` +
      `${pendingPermissions.size} permission(s), ${pendingQuestions.size} question(s) — ` +
      `the turn stays blocked until they are answered.\n` +
      `A permission needs a button. A question also clears itself if you just send your next prompt.`,
    );
  }

  /** Run the sweep for the life of the process; stops with the abort signal. */
  startPendingSweeper(signal: AbortSignal): void {
    const id = setInterval(() => {
      void this.sweepPending().catch(err =>
        log.warn('pending', `sweep failed: ${(err as Error).message}`),
      );
    }, PENDING_SWEEP_MS);
    signal.addEventListener('abort', () => clearInterval(id));
  }

  async handle(event: OpencodeEvent) {
    const p = event.properties ?? {};

    // Bridge-internal sessions (reaction classification) share this event
    // stream but must never reach the chat.
    const sid: string | undefined = p.sessionID ?? p.info?.id ?? p.session?.id;
    if (sid && internalSessions.has(sid)) {
      log.debug('drop', `${event.type}: internal session ${sid}`);
      return;
    }
    // Past the internal filter, so this is real work on the user's turn.
    noteWorking(event.type);

    switch (event.type) {
      // Our own injections echo back on the stream — ignoring them keeps the
      // bridge from mirroring itself into a loop.
      case 'tui.prompt.append':
      case 'tui.toast.show':
      case 'tui.command.execute':
        log.debug('drop', `${event.type}: our own injection echoing back`);
        return;

      case 'message.part.updated': {
        const part = p.part;
        if (!part || !p.sessionID) {
          log.debug('drop', `${event.type}: no part or no sessionID`);
          return;
        }
        // Deltas arrive too, but part.text here is cumulative — which is exactly
        // what editMessageText wants, so we never reassemble fragments ourselves.
        if (part.type === 'text' && part.text) {
          const s = this.state(p.sessionID);
          // First text part of each turn is the user's own message echoed back — skip it.
          if (!s.skippedUser) {
            s.skippedUser = true;
            log.debug('drop', 'first text part of the turn (user echo)');
            return;
          }
          if (!s.parts.has(part.id)) s.order.push(part.id);
          s.parts.set(part.id, part.text);
          await this.relayImages(part.text);
          this.schedule(p.sessionID);
        } else if (part.type === 'tool') {
          log.debug('relay', 'tool part:', part.tool, part.state?.status ?? '');
          const line = renderTool(part);
          if (line === null) {
            log.debug('drop', `tool ${part.tool}: renderTool returned null`);
            return;
          }
          const s = this.state(p.sessionID);
          if (!s.parts.has(part.id)) s.order.push(part.id);
          s.parts.set(part.id, line);
          // Scan the invocation as well as the result: `cua-driver call
          // screenshot --screenshot-out-file <path>` prints only a one-line
          // summary, so the path exists nowhere but the command itself.
          if (part.state?.status === 'completed') {
            const input = part.state.input ?? {};
            await this.relayImages(
              [input.command, input.filePath, input.path, part.state.output]
                .filter(v => typeof v === 'string')
                .join('\n'),
            );
          }
          this.schedule(p.sessionID);
        }
        return;
      }

      case 'session.idle': {
        const sessionID = p.sessionID;
        if (!sessionID) return;
        const s = this.turns.get(sessionID);
        if (s?.timer) clearTimeout(s.timer);
        if (s) s.timer = undefined;
        await this.flush(sessionID);
        this.finish(sessionID);
        return;
      }

      case 'session.error': {
        const msg = p.error?.data?.message ?? p.error?.name ?? 'unknown error';
        // A raw serde complaint names a message index and a variant name, and
        // connects to nothing the user did. If it is really the attachment
        // problem, say which one it is and how to get out of it.
        const hint = explainAttachmentRejection(String(msg));
        await this.send(`⚠️ <b>Session error</b>\n${msg}${hint ? `\n\n${hint}` : ''}`);
        if (p.sessionID) {
          this.finish(p.sessionID);
          // Nothing can answer a block on a turn that just died, and its
          // buttons would otherwise sit in the chat looking actionable.
          await this.clearPendingFor(p.sessionID);
        }
        return;
      }

      case 'session.updated': {
        const s = p.info ?? p.session;
        if (s?.id && s.title) this.titles.set(s.id, s.title);
        return;
      }

      case 'permission.asked':
      case 'permission.v2.asked': {
        // v1 uses permission/patterns, v2 uses action/resources.
        const action = p.action ?? p.permission ?? 'unknown action';
        const resources: string[] = p.resources ?? p.patterns ?? [];
        const detail = resources.slice(0, 4).join('\n');
        log.info('relay', `permission asked (${action}) — turn is blocked until answered`);
        // The ids do NOT fit in a button: Telegram caps callback_data at 64
        // bytes and `perm|always|<permID>|<sessionID>` runs to ~71, so the whole
        // message failed with BUTTON_DATA_INVALID and the turn hung forever with
        // no way to approve it. Keep the ids here, put a short token in the button.
        const token = nextToken();
        const entry: PendingBase = {
          requestID: p.id,
          sessionID: p.sessionID,
          askedAt: Date.now(),
          nudgedAt: Date.now(),
        };
        pendingPermissions.set(token, entry);
        const keyboard = permissionKeyboard(token);
        // Recorded before the send resolves so a press that arrives while the
        // API call is still in flight already finds the entry.
        entry.messageId = await this.send(
          `🔐 <b>Permission requested</b>\n<code>${action}</code>${detail ? `\n${detail}` : ''}`,
          keyboard,
        );
        return;
      }

      case 'question.asked':
      case 'question.v2.asked': {
        const questions = p.questions ?? [];
        const q = questions[0];
        if (!q) return;
        const qToken = nextToken();
        const keyboard = questionKeyboard(qToken, q);
        const qEntry = {
          requestID: p.id,
          sessionID: p.sessionID ?? '',
          question: q,
          askedAt: Date.now(),
          nudgedAt: Date.now(),
          messageId: undefined as number | undefined,
        };
        pendingQuestions.set(qToken, qEntry);
        log.info('relay', 'question asked — turn is blocked until answered');
        qEntry.messageId = await this.send(
          `❓ <b>${q.header ?? 'Question'}</b>\n${q.question ?? ''}`,
          keyboard,
        );
        return;
      }

      default:
        // Not a drop worth worrying about, but the only way to discover a new
        // opencode event type is to see the ones nothing handles.
        log.debug('drop', `${event.type}: no handler`);
        return;
    }
  }
}

/**
 * What every block the turn is waiting on has to carry.
 *
 * The first three fields exist because none of them could be recovered later.
 * Without `sessionID` a question cannot be cleared when its session dies —
 * the map held only the request and the options, so there was no way to ask
 * "does this still belong to anything". Without `askedAt` nothing can expire.
 * Without `messageId` the buttons cannot be retired, so a resolved block keeps
 * a live-looking keyboard in the chat forever.
 */
interface PendingBase {
  requestID: string;
  sessionID: string;
  /** Epoch ms the block started. TTL expiry and nudge cadence both read this. */
  askedAt: number;
  /** Epoch ms of the last reminder, so a nudge does not repeat every sweep. */
  nudgedAt: number;
  /** Telegram message carrying the buttons, so they can be stripped. */
  messageId?: number;
}

/** Question options, kept so a button press can be mapped back to its label. */
export const pendingQuestions = new Map<string, PendingBase & { question: any }>();

/**
 * Permission requests, kept so a button press can be mapped back to its request.
 *
 * The ids live here rather than in the button because Telegram allows only 64
 * bytes of callback_data — see CALLBACK_DATA_LIMIT.
 */
export const pendingPermissions = new Map<string, PendingBase>();

/**
 * Strip the buttons off a prompt that can no longer be answered.
 *
 * Leaving them is what turns a resolved block into a confusing one: the
 * keyboard still looks actionable, and pressing it reports a failure the user
 * can do nothing about.
 *
 * Mirrors `edit()` in scope — the id came from the first allowlisted chat, so
 * on a multi-chat allowlist the other attempts fail and are ignored. Same known
 * gap, tracked in the README.
 */
export async function retireButtons(bot: Bot, messageId?: number): Promise<void> {
  if (messageId === undefined) return;
  for (const chatId of chats()) {
    try {
      await bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: undefined });
    } catch {
      // Already edited, deleted, or another chat's id. Nothing to report.
    }
  }
}

/**
 * Drop every outstanding question because a new prompt is taking over.
 *
 * A question BLOCKS the turn and only its buttons can answer it. Typing the
 * answer instead of tapping — which is what anyone does once the option list
 * has scrolled off a phone screen — used to submit the text as a fresh prompt
 * and leave the block standing, so the session went quiet and stayed quiet with
 * nothing in the chat to say why. Reading a new prompt as "the user moved on"
 * and rejecting the question is what keeps the session live.
 *
 * Permissions are deliberately NOT superseded. Silently dropping an
 * Approve/Deny because someone typed would turn an ordinary message into a
 * security decision; those stay button-only until answered or expired.
 */
export async function supersedeQuestions(bot: Bot): Promise<number> {
  if (pendingQuestions.size === 0) return 0;
  const entries = [...pendingQuestions.values()];
  pendingQuestions.clear();   // cleared first: a reject that throws must not leave the block tracked
  for (const q of entries) {
    try {
      await opencode.rejectQuestion(q.requestID);
    } catch (err) {
      // Already gone is the ordinary case here, and nothing else is worth
      // failing the user's new prompt over.
      log.debug('pending', `reject ${q.requestID} failed: ${(err as Error).message}`);
    }
    await retireButtons(bot, q.messageId);
  }
  log.info('pending', `superseded ${entries.length} unanswered question(s) — new prompt takes over`);
  return entries.length;
}

let tokenSeq = 0;
/** Short, unique-per-run handle for a pending interaction. */
export function nextToken(): string {
  return (++tokenSeq).toString(36);
}

/** Telegram's hard cap on inline-button callback_data. Exceeding it rejects the whole message. */
export const CALLBACK_DATA_LIMIT = 64;

/**
 * The Approve/Deny keyboard, built in exactly one place.
 *
 * Both the live `permission.asked` path and the restart-reconciliation path
 * need it, and two copies would be free to drift — which matters because a
 * malformed button here silently kills the entire message.
 */
/**
 * The option keyboard for a question, built in exactly one place.
 *
 * Same reason as permissionKeyboard: the live `question.asked` path and the
 * restart-reconciliation path both need it, and two copies would be free to
 * drift in the one detail that silently kills the whole message — button size.
 */
export function questionKeyboard(token: string, q: any): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  (q?.options ?? []).slice(0, 6).forEach((opt: any, i: number) => {
    keyboard.text(String(opt.label ?? opt).slice(0, 30), cb(`ask|${token}|${i}`)).row();
  });
  return keyboard;
}

export function permissionKeyboard(token: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Once', cb(`perm|once|${token}`))
    .text('♾️ Always', cb(`perm|always|${token}`))
    .text('⛔️ Deny', cb(`perm|reject|${token}`));
}

/**
 * Guard callback_data against the 64-byte cap.
 *
 * Over the limit Telegram rejects the entire sendMessage with
 * BUTTON_DATA_INVALID — so one oversized button silently costs the user the
 * message it was attached to. That is how an unanswerable permission prompt
 * wedged a whole session. Fail loudly here instead.
 */
export function cb(data: string): string {
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes > CALLBACK_DATA_LIMIT) {
    log.error('relay', `callback_data is ${bytes} bytes (limit ${CALLBACK_DATA_LIMIT}): ${data}`);
  }
  return data;
}

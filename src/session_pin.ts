/**
 * Where the bridge's own session id is remembered, on disk, across restarts.
 *
 * `opencode.currentSession()` uses this instead of "whichever session on the
 * server was updated most recently" — the old approach, which meant any other
 * activity on the same opencode server (an attached TUI, direct CLI use)
 * could outrank the bridge's own conversation and silently steal every
 * Telegram message that came after it. See the incident this fixed: a "Hi"
 * sent over Telegram was appended to an unrelated Sunshine/Moonlight
 * troubleshooting session someone had open in the TUI, and the reply went
 * nowhere the bridge could see it.
 *
 * Keyed by a hash of the bot token, same reasoning as poller_lock.ts: two
 * bridges on two different bots must never share state, and the token itself
 * must not end up readable in a world-listable /tmp filename.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { log } from './log';

function pinFilePath(token: string): string {
  const override = (process.env.BRIDGE_SESSION_FILE ?? '').trim();
  if (override) return override;
  const tag = createHash('sha256').update(token).digest('hex').slice(0, 16);
  return join(tmpdir(), `telegram-bridge-session-${tag}.id`);
}

export function readPinnedSession(token: string): string | undefined {
  try {
    const file = pinFilePath(token);
    if (!existsSync(file)) return undefined;
    const raw = readFileSync(file, 'utf8').trim();
    return raw || undefined;
  } catch (err) {
    log.warn('session', `could not read pinned session: ${(err as Error).message}`);
    return undefined;
  }
}

export function writePinnedSession(token: string, sessionID: string): void {
  try {
    const file = pinFilePath(token);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, sessionID, { mode: 0o600 });
  } catch (err) {
    log.warn('session', `could not persist pinned session: ${(err as Error).message}`);
  }
}

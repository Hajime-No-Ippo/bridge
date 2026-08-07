/**
 * Claiming Telegram's single polling slot.
 *
 * Telegram allows exactly one `getUpdates` consumer per bot token. A bridge
 * that dies without closing its poll loop — SIGKILL, a closed terminal, a
 * systemd restart that outran the old process — leaves an orphan holding the
 * slot, and every later start sees 409 Conflict forever. index.ts already
 * explains that error well, but explaining it still requires a human to go
 * find the orphan with `pgrep`. For an always-on bridge that is the wrong
 * trade: reclaim the slot instead.
 *
 * Ported from the Claude Code telegram channel plugin, which solves the same
 * problem for the same reason, with two changes it does not need:
 *
 * 1. The pidfile is keyed by a hash of the bot token. That plugin owns one
 *    token per state directory; this bridge can be pointed at any token, and
 *    two bridges on two different bots must never evict each other. The hash
 *    rather than the token itself, because a token in a world-listable /tmp
 *    filename is a credential leak.
 *
 * 2. The holder is identified before it is signalled. `kill(pid, 0)` proves
 *    only that SOMETHING owns that pid, and pids get recycled — on a machine
 *    up for weeks the pid in a stale file can belong to anything by now.
 *    Sending SIGTERM to an unrelated process is far worse than failing to
 *    reclaim the slot, which merely produces the 409 message that already
 *    tells you what to do.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { log } from './log';

/** How long to let a signalled poller finish its in-flight getUpdates and exit. */
const EXIT_WAIT_MS = 3000;
const EXIT_POLL_MS = 100;

export function pidFilePath(token: string): string {
  const override = (process.env.BRIDGE_PID_FILE ?? '').trim();
  if (override) return override;
  const tag = createHash('sha256').update(token).digest('hex').slice(0, 16);
  return join(tmpdir(), `telegram-bridge-${tag}.pid`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does this command line belong to a bridge?
 *
 * Deliberately narrow. Anything that fails to match is left alone, because the
 * cost of a false positive here is killing an unrelated process on the user's
 * machine and the cost of a false negative is a 409 with instructions.
 */
export function looksLikeBridge(command: string): boolean {
  return /src\/index\.ts/.test(command) || /telegram-bridge/.test(command);
}

function commandOf(pid: number): string | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;   // process vanished, or ps is unavailable
  }
}

/**
 * Take the polling slot, evicting a previous bridge if one still holds it.
 *
 * Never throws: this is an optimisation over the 409 path, not a precondition
 * for running. If anything here fails the bridge still starts and still reports
 * the conflict the old way.
 */
export async function claimPollingSlot(token: string): Promise<void> {
  const file = pidFilePath(token);
  try {
    mkdirSync(dirname(file), { recursive: true });

    if (existsSync(file)) {
      const stale = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
      // pid 1 is init; our own pid means a pidfile we already own.
      if (Number.isInteger(stale) && stale > 1 && stale !== process.pid && isAlive(stale)) {
        const command = commandOf(stale);
        if (!command) {
          log.warn('poller', `pid ${stale} holds the slot but could not be identified — leaving it alone`);
        } else if (!looksLikeBridge(command)) {
          log.warn(
            'poller',
            `pid ${stale} is not a bridge (${command.slice(0, 60)}) — leaving it alone. ` +
            'The pidfile is stale and its pid has been recycled.',
          );
        } else {
          log.info('poller', `replacing stale poller pid=${stale}`);
          process.kill(stale, 'SIGTERM');
          const deadline = Date.now() + EXIT_WAIT_MS;
          while (Date.now() < deadline && isAlive(stale)) await Bun.sleep(EXIT_POLL_MS);
          if (isAlive(stale)) {
            // Not escalated to SIGKILL on purpose. A bridge ignoring SIGTERM is
            // doing something unexpected, and the 409 below says so clearly
            // enough for a human to decide.
            log.warn('poller', `pid ${stale} did not exit within ${EXIT_WAIT_MS}ms — expect a 409`);
          }
        }
      }
    }

    writeFileSync(file, String(process.pid), { mode: 0o600 });
  } catch (err) {
    log.warn('poller', `could not claim the polling slot: ${(err as Error).message}`);
  }
}

/** Drop the pidfile on a clean exit, so the next start has nothing to evict. */
export function releasePollingSlot(token: string): void {
  const file = pidFilePath(token);
  try {
    if (existsSync(file) && readFileSync(file, 'utf8').trim() === String(process.pid)) {
      unlinkSync(file);
    }
  } catch {
    // A leftover file is harmless — the next start checks liveness anyway.
  }
}

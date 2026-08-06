import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Pixel capture of the terminal window running the opencode TUI.
 *
 * macOS has no notion of an "opencode window" — the TUI is text drawn inside
 * Terminal.app, so the window belongs to the terminal emulator. We find it by
 * matching the TUI process's tty against Terminal's tabs, which beats grabbing
 * `window 1`: the TUI is usually not the frontmost window when you're driving
 * it from your phone.
 */

const run = (cmd: string, args: string[]): string | undefined => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 10_000 }).trim();
  } catch {
    return undefined;
  }
};

/** tty of the attached TUI, e.g. `ttys004`. */
function tuiTty(): string | undefined {
  const ps = run('ps', ['-eo', 'pid,tty,args']);
  const line = ps
    ?.split('\n')
    .find(l => l.includes('opencode attach') && !l.includes('grep'));
  const tty = line?.trim().split(/\s+/)[1];
  return tty && tty !== '??' ? tty : undefined;
}

/**
 * CoreGraphics window id for the Terminal window owning that tty. Terminal's
 * AppleScript `id` happens to be the CGWindowID that `screencapture -l` wants —
 * that is not true of every app, but it holds here.
 */
function windowId(tty: string): number | undefined {
  const script = `
    tell application "Terminal"
      repeat with w in windows
        repeat with t in tabs of w
          if tty of t is "/dev/${tty}" then return id of w
        end repeat
      end repeat
      return 0
    end tell`;
  const id = Number(run('osascript', ['-e', script]));
  return Number.isFinite(id) && id > 0 ? id : undefined;
}

export interface Screenshot {
  path: string;
  /** Whether we got the TUI's window or had to settle for the whole display. */
  scope: 'window' | 'display';
  bytes: number;
}

/**
 * Capture to a temp PNG. Caller owns the file — call `discard` when done.
 *
 * `screencapture` exits 0 even when it captured nothing (a denied Screen
 * Recording permission just prints to stderr), so the only trustworthy check
 * is whether a non-empty file actually landed.
 */
export function takeScreenshot(): Screenshot {
  const path = join(tmpdir(), `opencode-tui-${Date.now()}.png`);
  const tty = tuiTty();
  const id = tty ? windowId(tty) : undefined;

  // -o drops the window's drop shadow, which is dead pixels around a terminal.
  if (id !== undefined) {
    run('screencapture', ['-l', String(id), '-o', '-x', '-t', 'png', path]);
    if (existsSync(path) && statSync(path).size > 0) {
      return { path, scope: 'window', bytes: statSync(path).size };
    }
  }

  run('screencapture', ['-x', '-t', 'png', '-D', '1', path]);
  if (existsSync(path) && statSync(path).size > 0) {
    return { path, scope: 'display', bytes: statSync(path).size };
  }

  throw new Error(
    'screencapture produced no image. Grant Screen Recording to your terminal ' +
    'in System Settings → Privacy & Security → Screen Recording, then restart it.',
  );
}

export function discard(path: string) {
  try {
    unlinkSync(path);
  } catch {
    // A leftover temp file is not worth surfacing to the user.
  }
}

/**
 * Delete stale temp screenshots: our own `opencode-tui-*.png` captures plus
 * the `opencode/` scratch dir agents screenshot into. Runs at bridge startup
 * rather than "session end" — the bridge has no session lifecycle, so the
 * previous session's leftovers get swept the next time it boots.
 */
export function sweepTempImages(ttlMs: number): void {
  const cutoff = Date.now() - ttlMs;
  const victims: string[] = [];

  const collect = (dir: string, match: RegExp) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // dir doesn't exist — nothing to sweep
    }
    for (const name of names) {
      if (!match.test(name)) continue;
      const path = join(dir, name);
      try {
        if (statSync(path).mtimeMs < cutoff) victims.push(path);
      } catch {
        // Vanished mid-sweep; not worth surfacing.
      }
    }
  };

  collect(tmpdir(), /^opencode-tui-.*\.png$/);
  collect(join(tmpdir(), 'opencode'), /\.png$/);

  for (const path of victims) {
    console.log('[sweep] removing stale screenshot:', path);
    discard(path);
  }
}

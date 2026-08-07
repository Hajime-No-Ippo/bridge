/**
 * STAGE: Linux migration, phase 1 (browser backend). New file, nothing removed.
 * MIGRATES: `openBrowser()` in src/tools/browser_ops.ts, which shells out to
 *           macOS `open -b <bundleID>`.
 *
 * `open` has no Linux equivalent worth using — LINUX_MIGRATION.md §5 rules out
 * `xdg-open` because it steals focus, the same reason the macOS side needed a
 * FocusRestoreGuard. So instead of opening an *app*, this launches a *debuggable
 * browser*: a Chrome that is already listening on a CDP port when it comes up.
 *
 * Deliberately platform-agnostic. CDP behaves identically on macOS and Linux, so
 * this is the piece that lets the whole backend be written and verified on a Mac
 * before an Ubuntu box exists — see the phase-1 rationale in the PR notes.
 */

import { existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

const env = (name: string, fallback: string) => (process.env[name] ?? '').trim() || fallback;

/** CDP port. Chrome binds this to loopback only; see PROFILE_DIR on why that matters. */
export const CDP_PORT = Number(env('CHROME_CDP_PORT', '9222'));

/**
 * A profile dedicated to automation, never your daily one.
 *
 * The debugging port is unauthenticated: anything running as this user can
 * attach and drive the browser, including reading whatever it is signed into.
 * Pointing it at your real profile would hand every local process your Gmail
 * and LinkedIn sessions. A separate profile keeps the blast radius to accounts
 * you deliberately signed into here.
 */
export const PROFILE_DIR = env('CHROME_PROFILE_DIR', join(os.homedir(), '.config', 'telegram-bridge-chrome'));

export const cdpBase = () => `http://127.0.0.1:${CDP_PORT}`;

/** Where Chrome actually lives, per platform. First hit wins. */
const CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
};

export function chromeBinary(): string {
  const override = env('CHROME_BINARY', '');
  if (override) {
    if (!existsSync(override)) throw new Error(`CHROME_BINARY does not exist: ${override}`);
    return override;
  }
  const found = (CANDIDATES[process.platform] ?? []).find(existsSync);
  if (!found) {
    throw new Error(
      `No Chrome/Chromium found for platform ${process.platform}. ` +
      'Install one or set CHROME_BINARY to its path.',
    );
  }
  return found;
}

/** Is something already serving CDP on the port? */
export async function chromeIsUp(timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${cdpBase()}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Bring up a debuggable Chrome, or confirm one is already up.
 *
 * Detached on purpose: the browser has to outlive the bridge process that
 * started it, or every restart would close the user's tabs and drop their
 * logins. On Linux that means `setsid` (LINUX_MIGRATION.md §5); on macOS an
 * unref'd child is enough.
 */
export async function ensureChrome(): Promise<void> {
  if (await chromeIsUp()) return;

  const binary = chromeBinary();
  const flags = [
    `--remote-debugging-port=${CDP_PORT}`,
    // Explicit even though it is the default — this is the line that keeps the
    // debugging port off the network, and a default is not a guarantee.
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];

  // setsid detaches from the controlling terminal so the browser survives the
  // bridge. Absent on macOS, where unref() covers it.
  const useSetsid = process.platform === 'linux' && existsSync('/usr/bin/setsid');
  const cmd = useSetsid ? ['/usr/bin/setsid', binary, ...flags] : [binary, ...flags];

  const proc = Bun.spawn({ cmd, stdio: ['ignore', 'ignore', 'ignore'] });
  proc.unref();

  // Chrome forks and the port opens a beat later, so a single check would
  // always lose the race.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await chromeIsUp()) return;
    await Bun.sleep(250);
  }
  throw new Error(
    `Chrome did not open a CDP port on ${CDP_PORT} within 20s. ` +
    `Binary: ${binary}. Profile: ${PROFILE_DIR}.`,
  );
}

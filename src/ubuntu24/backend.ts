/**
 * STAGE: Linux migration, phase 1 (browser backend). New file, nothing removed.
 * MIGRATES: nothing on its own — this is the seam that lets the macOS and Linux
 *           implementations coexist while phase 1 is proven.
 *
 * The four functions below are the entire surface the operate_*.ts tools use.
 * That is why the rewrite is tractable: reimplement these and every DOM
 * selector, the LinkedIn login guard and the f_TPR logic carry over untouched
 * (LINUX_MIGRATION.md §4.4).
 *
 * ONE BREAKING DIFFERENCE, and it is unavoidable. The cua-driver originals are
 * synchronous — execFileSync blocks until the driver exits. A socket cannot do
 * that, so everything here is async. Callers switching over must add `await`;
 * TypeScript flags every site. See PHASE-1 NOTES at the bottom of this file.
 *
 * Nothing imports this yet. Phase 1 builds and verifies the backend; wiring the
 * consumers is a deliberate second step, so a regression in either half stays
 * attributable to one change.
 */

import * as cua from '../tools/browser_ops';
import {
  cdpOpenBrowser,
  cdpPageCall,
  cdpPageJs,
  cdpResolveTarget,
  type BrowserTarget,
  type PageAction,
} from './browser_cdp';

export type { BrowserTarget, PageAction };

export type Backend = 'cdp' | 'cua';

/**
 * Which implementation to use.
 *
 * Platform decides by default — cua-driver only exists on macOS, CDP runs
 * anywhere. `BROWSER_BACKEND` overrides it, which is what makes phase 1
 * verifiable: it forces the Linux path on a Mac, against a real Chrome, before
 * any Ubuntu machine is involved.
 */
export function browserBackend(): Backend {
  const forced = (process.env.BROWSER_BACKEND ?? '').trim().toLowerCase();
  if (forced === 'cdp' || forced === 'cua') return forced;
  return process.platform === 'darwin' ? 'cua' : 'cdp';
}

export async function openBrowser(bundleID: string, url?: string): Promise<void> {
  if (browserBackend() === 'cdp') return cdpOpenBrowser(bundleID, url);
  cua.openBrowser(bundleID, url);
}

export async function resolveBrowserTarget(
  bundleID: string,
  urlMatch?: string,
): Promise<BrowserTarget> {
  if (browserBackend() === 'cdp') return cdpResolveTarget(bundleID, urlMatch);
  // The macOS target is already {bundleID, pid, windowID}; the widened type
  // just makes those two optional, so it passes through unchanged.
  return cua.resolveBrowserTarget(bundleID);
}

export async function pageCall(
  target: BrowserTarget,
  action: PageAction,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  if (browserBackend() === 'cdp') return cdpPageCall(target, action, extra);
  return cua.pageCall(target as cua.BrowserTarget, action as any, extra);
}

export async function pageJs(target: BrowserTarget, javascript: string): Promise<string> {
  if (browserBackend() === 'cdp') return cdpPageJs(target, javascript);
  return cua.pageJs(target as cua.BrowserTarget, javascript);
}

/*
 * PHASE-1 NOTES — what switching the consumers over will cost.
 *
 * Change the import in each of the four tools from './browser_ops' to
 * '../ubuntu24/backend', then add `await` at these call sites:
 *
 *   operate_chrome.ts        openBrowser, pageJs, pageCall x2
 *   operate_gmail.ts         openBrowser, pageCall
 *   operate_new_trends_twitter.ts   per its own calls
 *   operate_polling_jobs.ts  openBrowser, pageJs x2
 *
 * One real consequence beyond the awaits: operate_polling_jobs returns
 * `pid` and `windowID` to its caller, and under CDP both are undefined. Its
 * return type has to admit that rather than pretend otherwise — which is the
 * honest version of the change, not a regression.
 */

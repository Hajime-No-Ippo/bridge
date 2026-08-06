import { execFileSync } from 'node:child_process';

const DRIVER = 'cua-driver';

interface DriverResult {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
}

interface AppRow {
  bundle_id?: string;
  pid?: number;
  running?: boolean;
}

interface WindowRow {
  pid?: number;
  window_id?: number;
  layer?: number;
  is_on_screen?: boolean;
  on_current_space?: boolean;
  z_index?: number;
}

export interface BrowserTarget {
  bundleID: string;
  pid: number;
  windowID: number;
}

type PageAction = 'execute_javascript' | 'get_text' | 'query_dom';

function callDriver<T>(tool: string, args?: Record<string, unknown>): T {
  const cmd = ['call', tool];
  if (args) cmd.push(JSON.stringify(args));
  cmd.push('--raw', '--compact');

  let raw = '';
  try {
    raw = execFileSync(DRIVER, cmd, { encoding: 'utf8', timeout: 40_000 }).trim();
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const stdout = e.stdout ? String(e.stdout).trim() : '';
    const stderr = e.stderr ? String(e.stderr).trim() : '';
    const detail = [stderr, stdout, e.message ?? 'unknown failure'].find(Boolean);
    throw new Error(`${DRIVER} ${tool} failed: ${detail}`);
  }

  let parsed: DriverResult;
  try {
    parsed = JSON.parse(raw) as DriverResult;
  } catch {
    throw new Error(`${DRIVER} returned non-JSON output for ${tool}`);
  }

  if (parsed.isError) {
    const text = parsed.content?.find(c => c.type === 'text')?.text;
    throw new Error(text || `${DRIVER} reported an error for ${tool}`);
  }

  return (parsed.structuredContent ?? {}) as T;
}

export function openBrowser(bundleID: string, url?: string): void {
  const args = ['-b', bundleID];
  if (url) args.push(url);
  execFileSync('open', args, { timeout: 10_000 });
}

async function runningPid(bundleID: string): Promise<number | undefined> {
  const apps = callDriver<{ apps?: AppRow[] }>('list_apps').apps ?? [];
  const app = apps.find(a => a.bundle_id === bundleID && a.running && typeof a.pid === 'number' && a.pid > 0);
  return app?.pid;
}

function bestWindow(pid: number): number | undefined {
  const windows = callDriver<{ windows?: WindowRow[] }>('list_windows').windows ?? [];
  const candidates = windows
    .filter(w => w.pid === pid && w.layer === 0 && typeof w.window_id === 'number')
    .sort((a, b) => {
      const score = (w: WindowRow) =>
        (w.on_current_space ? 4 : 0) + (w.is_on_screen ? 2 : 0) + (typeof w.z_index === 'number' ? w.z_index / 1000 : 0);
      return score(b) - score(a);
    });
  return candidates[0]?.window_id;
}

export async function resolveBrowserTarget(bundleID: string): Promise<BrowserTarget> {
  let pid = await runningPid(bundleID);
  if (!pid) {
    openBrowser(bundleID);
    await Bun.sleep(800);
    pid = await runningPid(bundleID);
  }
  if (!pid) throw new Error(`Browser not running for bundle id: ${bundleID}`);

  let windowID = bestWindow(pid);
  if (!windowID) {
    openBrowser(bundleID);
    await Bun.sleep(800);
    windowID = bestWindow(pid);
  }
  if (!windowID) throw new Error(`No browser window found for bundle id: ${bundleID}`);

  return { bundleID, pid, windowID };
}

export function pageCall(
  target: BrowserTarget,
  action: PageAction,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return callDriver<Record<string, unknown>>('page', {
    pid: target.pid,
    window_id: target.windowID,
    action,
    ...extra,
  });
}

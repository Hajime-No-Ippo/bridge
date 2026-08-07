/**
 * STAGE: Linux migration, phase 1 (browser backend). New file, nothing removed.
 * MIGRATES: the cua-driver half of src/tools/browser_ops.ts —
 *           `bestWindow()`, `resolveBrowserTarget()`, `pageCall()`, `pageJs()`.
 *
 * LINUX_MIGRATION.md §4 calls this the single largest rewrite, and it is: Apple
 * Events out, Chrome DevTools Protocol in. Two things get simpler on the way.
 *
 * `pageJs` no longer parses text. cua-driver returned JS results as prose
 * wrapped in a ``` fence that had to be regexed back out; `Runtime.evaluate`
 * with `returnByValue` hands over the actual value.
 *
 * `bestWindow` no longer scores windows. There is no z-order in CDP and no
 * per-pid window list, so tab choice is by kind and URL instead — which is what
 * the callers actually meant (§4.3). The macOS layer/on-screen/z_index scoring
 * existed to dodge Chrome's invisible helper windows; CDP never lists those.
 *
 * ASYNC, unlike the functions it replaces. execFileSync blocked; a socket
 * cannot. See backend.ts for what that costs the callers.
 */

import { cdpBase, ensureChrome } from './chrome_launch';

/** Long enough for a slow page, short enough that a wedged tab still reports. */
const CALL_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * A driveable tab.
 *
 * `pid` and `windowID` are the macOS identity of a window and have no CDP
 * equivalent — a tab is a `targetId` string. They stay optional rather than
 * being filled with plausible-looking numbers, because callers surface them
 * (operate_polling_jobs returns both to its caller) and invented ids there
 * would be worse than absent ones.
 */
export interface BrowserTarget {
  bundleID: string;
  pid?: number;
  windowID?: number;
  targetId?: string;
  wsUrl?: string;
  url?: string;
}

export type PageAction = 'execute_javascript' | 'get_text' | 'query_dom';

interface CdpTarget {
  id: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

/** Tabs, minus everything that is not a real page. */
async function listPages(): Promise<CdpTarget[]> {
  const res = await fetch(`${cdpBase()}/json/list`, { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`CDP /json/list returned ${res.status}`);
  const all = (await res.json()) as CdpTarget[];
  return all.filter(
    t =>
      t.type === 'page' &&
      t.webSocketDebuggerUrl &&
      // Chrome's own surfaces are attachable but are never what a caller wants
      // to scrape, and devtools:// windows appear the moment anyone opens
      // DevTools by hand.
      !/^(devtools|chrome|chrome-extension):\/\//.test(t.url ?? ''),
  );
}

type Send = (method: string, params?: Record<string, unknown>) => Promise<any>;

/**
 * Open a socket, run one exchange, close it.
 *
 * Connection-per-call matches what it replaces — every cua-driver call was its
 * own `execFileSync` — and it means no session state can go stale between
 * calls. On loopback the handshake is a few milliseconds, which is nothing
 * against page-load times measured in seconds.
 */
async function withSocket<T>(wsUrl: string, fn: (send: Send) => Promise<T>): Promise<T> {
  const ws = new WebSocket(wsUrl);
  const pending = new Map<number, {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let nextId = 1;

  const failAll = (err: Error) => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`CDP connect timed out after ${CONNECT_TIMEOUT_MS}ms: ${wsUrl}`)),
      CONNECT_TIMEOUT_MS,
    );
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`CDP could not connect: ${wsUrl}`)); };
  });

  ws.onmessage = ev => {
    let msg: any;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    // CDP events carry no `id`; only replies do. Everything else is noise here.
    if (typeof msg?.id !== 'number') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`CDP error: ${msg.error.message ?? JSON.stringify(msg.error)}`));
    else p.resolve(msg.result);
  };
  // A tab that closes mid-call must reject, not hang. Silence is this project's
  // signature failure and it is not going to be reintroduced here.
  ws.onclose = () => failAll(new Error('CDP socket closed before the call returned'));

  const send: Send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${CALL_TIMEOUT_MS}ms`));
      }, CALL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });

  try {
    return await fn(send);
  } finally {
    ws.onclose = null;   // the close below is ours, and must not reject anything
    failAll(new Error('CDP socket closed'));
    ws.close();
  }
}

/** Run JS in a tab and hand back the real value, not a rendering of it. */
async function evaluate(target: BrowserTarget, expression: string): Promise<unknown> {
  if (!target.wsUrl) throw new Error('CDP target has no socket URL — resolve it first');
  return withSocket(target.wsUrl, async send => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      // Callers pass plain expressions today, but an `await` inside one should
      // resolve rather than hand back a Promise object.
      awaitPromise: true,
    });
    if (r?.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`JS threw: ${d.exception?.description ?? d.text ?? 'unknown error'}`);
    }
    return r?.result?.value;
  });
}

/**
 * Ensure a debuggable Chrome exists, and put `url` in front of the user.
 *
 * Navigates the current tab rather than piling up new ones — the macOS `open`
 * it replaces reused an existing window too.
 */
export async function cdpOpenBrowser(_bundleID: string, url?: string): Promise<void> {
  await ensureChrome();
  if (!url) return;

  const pages = await listPages();
  const page = pages[0];
  if (!page) {
    const res = await fetch(`${cdpBase()}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`CDP could not open a tab: ${res.status}`);
    return;
  }
  await withSocket(page.webSocketDebuggerUrl!, send => send('Page.navigate', { url }));
}

/**
 * Pick the tab to drive.
 *
 * `bundleID` is accepted and ignored: it is macOS app identity, meaningless to
 * CDP, and kept only so this is drop-in for the function it replaces. Pass
 * `urlMatch` to target a specific site — that is the CDP-native way to say
 * which window you meant.
 */
export async function cdpResolveTarget(bundleID: string, urlMatch?: string): Promise<BrowserTarget> {
  await ensureChrome();

  let pages = await listPages();
  if (pages.length === 0) {
    // Chrome can be up with every tab still initialising.
    await Bun.sleep(800);
    pages = await listPages();
  }
  if (pages.length === 0) throw new Error('No driveable page found over CDP');

  const chosen = (urlMatch && pages.find(p => (p.url ?? '').includes(urlMatch))) || pages[0]!;
  return {
    bundleID,
    targetId: chosen.id,
    wsUrl: chosen.webSocketDebuggerUrl,
    url: chosen.url,
  };
}

const jsonArg = (v: unknown) => JSON.stringify(v);

/**
 * The structured read actions, as JS rather than driver verbs.
 *
 * Shapes mirror what cua-driver returned so consumers that just forward `data`
 * onward keep working: `get_text` yields `{text}`, `query_dom` yields
 * `{elements}`.
 */
export async function cdpPageCall(
  target: BrowserTarget,
  action: PageAction,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  if (action === 'get_text') {
    const text = await evaluate(target, 'document.body ? document.body.innerText : ""');
    return { text: typeof text === 'string' ? text : String(text ?? '') };
  }

  if (action === 'query_dom') {
    const selector = String(extra.css_selector ?? extra.cssSelector ?? '');
    if (!selector) throw new Error('query_dom needs a css_selector');
    const attributes = (extra.attributes as string[]) ?? ['href'];
    const js = `
      Array.from(document.querySelectorAll(${jsonArg(selector)})).map(el => {
        const row = { text: (el.innerText || '').trim() };
        for (const a of ${jsonArg(attributes)}) row[a] = el.getAttribute(a);
        return row;
      })
    `;
    const elements = await evaluate(target, js);
    return { elements: Array.isArray(elements) ? elements : [] };
  }

  throw new Error(`pageCall does not handle "${action}" — use pageJs for arbitrary JS`);
}

/**
 * Execute JS and return it as a string.
 *
 * String, not the raw value, because that is the contract callers already
 * depend on — operate_polling_jobs runs `.includes()` and `.split('||')`
 * straight on the result. A non-string value is JSON-encoded rather than
 * stringified, so an object arrives as data instead of "[object Object]".
 */
export async function cdpPageJs(target: BrowserTarget, javascript: string): Promise<string> {
  const value = await evaluate(target, javascript);
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

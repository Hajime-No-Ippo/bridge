import { afterEach, describe, expect, test } from 'bun:test';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_ALLOWED_CHAT_IDS = '111';

const { browserBackend } = await import('../src/ubuntu24/backend.ts');
const { cdpPageCall } = await import('../src/ubuntu24/browser_cdp.ts');

const saved = process.env.BROWSER_BACKEND;
afterEach(() => {
  if (saved === undefined) delete process.env.BROWSER_BACKEND;
  else process.env.BROWSER_BACKEND = saved;
});

describe('backend selection', () => {
  test('defaults to the platform', () => {
    delete process.env.BROWSER_BACKEND;
    // cua-driver is macOS-only; CDP runs anywhere else.
    expect(browserBackend()).toBe(process.platform === 'darwin' ? 'cua' : 'cdp');
  });

  test('BROWSER_BACKEND forces the Linux path on any platform', () => {
    // This override is what makes phase 1 verifiable before an Ubuntu box
    // exists — without it the CDP code could not be exercised on a Mac at all.
    process.env.BROWSER_BACKEND = 'cdp';
    expect(browserBackend()).toBe('cdp');
    process.env.BROWSER_BACKEND = 'cua';
    expect(browserBackend()).toBe('cua');
  });

  test('an unrecognised value falls back rather than throwing', () => {
    // A typo in .env must not take the bridge down at import time.
    process.env.BROWSER_BACKEND = 'webdriver';
    expect(browserBackend()).toBe(process.platform === 'darwin' ? 'cua' : 'cdp');
  });
});

describe('cdpPageCall argument handling', () => {
  // These reject before any socket is opened, so they need no Chrome.
  test('query_dom without a selector is refused', async () => {
    await expect(cdpPageCall({ bundleID: 'x' }, 'query_dom', {})).rejects.toThrow('css_selector');
  });

  test('execute_javascript is not a pageCall action', async () => {
    // pageJs is the route for arbitrary JS; routing it here would silently
    // return the wrong shape.
    await expect(cdpPageCall({ bundleID: 'x' }, 'execute_javascript')).rejects.toThrow('pageJs');
  });
});

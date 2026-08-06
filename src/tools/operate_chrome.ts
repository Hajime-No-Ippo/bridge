import { openBrowser, pageCall, resolveBrowserTarget } from './browser_ops';

const CHROME_BUNDLE_ID = 'com.google.Chrome';

export interface ChromeOperation {
  url?: string;
  search?: string;
  javascript?: string;
  cssSelector?: string;
  attributes?: string[];
}

export interface BrowserOperationResult {
  bundleID: string;
  pid: number;
  windowID: number;
  action: 'execute_javascript' | 'get_text' | 'query_dom';
  data: Record<string, unknown>;
}

export async function operateChrome(op: ChromeOperation = {}): Promise<BrowserOperationResult> {
  const url =
    op.url ?? (op.search ? `https://www.google.com/search?q=${encodeURIComponent(op.search)}` : undefined);
  if (url) openBrowser(CHROME_BUNDLE_ID, url);

  const target = await resolveBrowserTarget(CHROME_BUNDLE_ID);

  if (op.javascript) {
    return {
      ...target,
      action: 'execute_javascript',
      data: pageCall(target, 'execute_javascript', { javascript: op.javascript }),
    };
  }

  if (op.cssSelector) {
    return {
      ...target,
      action: 'query_dom',
      data: pageCall(target, 'query_dom', {
        css_selector: op.cssSelector,
        attributes: op.attributes ?? ['href'],
      }),
    };
  }

  return {
    ...target,
    action: 'get_text',
    data: pageCall(target, 'get_text'),
  };
}

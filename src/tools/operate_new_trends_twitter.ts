import { openBrowser, pageCall, resolveBrowserTarget } from './browser_ops';

const CHROME_BUNDLE_ID = 'com.google.Chrome';

export interface TwitterTrendsOperation {
  regionQuery?: string;
}

export async function operateNewTrendsTwitter(op: TwitterTrendsOperation = {}): Promise<Record<string, unknown>> {
  const url = op.regionQuery?.trim()
    ? `https://x.com/search?q=${encodeURIComponent(`${op.regionQuery} trends`)}&src=typed_query`
    : 'https://x.com/explore/tabs/trending';
  openBrowser(CHROME_BUNDLE_ID, url);

  const target = await resolveBrowserTarget(CHROME_BUNDLE_ID);

  return {
    ...target,
    data: pageCall(target, 'query_dom', {
      css_selector: '[data-testid="trend"], [role="article"]',
      attributes: ['href'],
    }),
  };
}

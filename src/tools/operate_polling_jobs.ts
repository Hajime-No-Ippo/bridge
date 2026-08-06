import { openBrowser, pageCall, resolveBrowserTarget } from './browser_ops';

const CHROME_BUNDLE_ID = 'com.google.Chrome';

export interface PollingJobsOperation {
  keywords?: string;
  location?: string;
}

function linkedInJobsUrl(op: PollingJobsOperation): string {
  const p = new URLSearchParams();
  p.set('keywords', op.keywords?.trim() || 'software engineer');
  p.set('location', op.location?.trim() || 'Dublin');
  return `https://www.linkedin.com/jobs/search/?${p.toString()}`;
}

export async function operatePollingJobs(op: PollingJobsOperation = {}): Promise<Record<string, unknown>> {
  openBrowser(CHROME_BUNDLE_ID, linkedInJobsUrl(op));
  const target = await resolveBrowserTarget(CHROME_BUNDLE_ID);
  return {
    ...target,
    data: pageCall(target, 'query_dom', {
      css_selector: 'a[href*="/jobs/view/"]',
      attributes: ['href', 'aria-label'],
    }),
  };
}

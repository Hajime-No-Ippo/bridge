import { openBrowser, pageCall, resolveBrowserTarget } from './browser_ops';

const CHROME_BUNDLE_ID = 'com.google.Chrome';

export interface GmailOperation {
  mode?: 'inbox' | 'compose' | 'search';
  to?: string;
  subject?: string;
  body?: string;
  query?: string;
}

function gmailUrl(op: GmailOperation): string {
  const mode = op.mode ?? 'inbox';
  if (mode === 'compose') {
    const p = new URLSearchParams();
    if (op.to) p.set('to', op.to);
    if (op.subject) p.set('su', op.subject);
    if (op.body) p.set('body', op.body);
    return `https://mail.google.com/mail/u/0/?view=cm&fs=1&${p.toString()}`;
  }
  if (mode === 'search') {
    const q = op.query?.trim() || '';
    return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(q)}`;
  }
  return 'https://mail.google.com/mail/u/0/#inbox';
}

export async function operateGmail(op: GmailOperation = {}): Promise<Record<string, unknown>> {
  openBrowser(CHROME_BUNDLE_ID, gmailUrl(op));
  const target = await resolveBrowserTarget(CHROME_BUNDLE_ID);
  return {
    ...target,
    data: pageCall(target, 'get_text'),
  };
}

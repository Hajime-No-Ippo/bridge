import { openBrowser, pageJs, resolveBrowserTarget } from './browser_ops';

const CHROME_BUNDLE_ID = 'com.google.Chrome';

export interface PollingJobsOperation {
  keywords?: string;
  location?: string;
  /** Seconds since posted. 3600 = latest 1 hour, 86400 = 24h (LinkedIn default). */
  fTpr?: number;
  /** How many results to pull. */
  limit?: number;
}

export interface JobListing {
  title: string;
  company: string;
  location?: string;
  viewUrl?: string;
}

function linkedInJobsUrl(op: PollingJobsOperation): string {
  const p = new URLSearchParams();
  p.set('keywords', op.keywords?.trim() || 'software engineer');
  p.set('location', op.location?.trim() || 'Dublin');
  const tpr = op.fTpr ?? 86400;
  p.set('f_TPR', `r${tpr}`);
  p.set('sortBy', 'DD');
  return `https://www.linkedin.com/jobs/search/?${p.toString()}`;
}

const CARD_JS = (limit: number) => `Array.from(document.querySelectorAll('.jobs-search-results__list-item a[href*="/jobs/view/"], .job-card-container a[href*="/jobs/view/"]')).filter((a,i,arr)=>arr.findIndex(x=>x.href===a.href)===i).slice(0,${limit}).map((a,i)=>{const card=a.closest('li, [class*=\"job-card\"]');const allText=[...card.querySelectorAll('span,div,a')].map(e=>e.innerText?.trim()).filter(Boolean).join(' | ');return allText.slice(0,250)}).join('||')`;

function parseJobListings(raw: string): JobListing[] {
  if (!raw) return [];
  return raw.split('||').map(entry => {
    const parts = entry.split(' | ');
    const title = parts[0] || '';
    const company = parts.find(p => p && p !== title && !p.startsWith('http') && p.length < 100 && !p.includes(' ' + title)) || '';
    const location = parts.find(p => p.includes('Ireland') || p.includes('Dublin') || p.includes('Remote')) || '';
    const viewUrl = parts.find(p => p.startsWith('http')) || '';
    return { title, company, location, viewUrl };
  }).filter(j => j.title && j.title !== 'Job Title');
}

export async function operatePollingJobs(op: PollingJobsOperation = {}): Promise<{
  loggedIn: boolean;
  url: string;
  jobs: JobListing[];
  pid: number;
  windowID: number;
}> {
  const url = linkedInJobsUrl(op);
  openBrowser(CHROME_BUNDLE_ID, url);
  await new Promise(r => setTimeout(r, 7000));
  const target = await resolveBrowserTarget(CHROME_BUNDLE_ID);

  const bodyStart = pageJs(target, 'document.body.innerText.trim().slice(0,300)');
  const loggedIn = !bodyStart.includes('Sign in') && !bodyStart.includes('Join now');

  if (!loggedIn) {
    return { loggedIn: false, url, jobs: [], pid: target.pid, windowID: target.windowID };
  }

  const raw = pageJs(target, CARD_JS(op.limit ?? 15));

  return { loggedIn, url, jobs: parseJobListings(raw), pid: target.pid, windowID: target.windowID };
}

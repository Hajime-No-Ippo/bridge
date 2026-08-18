import { execFileSync } from 'node:child_process';
import { log } from '../log';

const SCRIPT_PATH = process.env.BLOG_SCRIPT_PATH
  ?? new URL('../../scripts/new-post.mjs', import.meta.url).pathname;

export interface PostResult {
  ok: boolean;
  slug?: string;
  error?: string;
}

/**
 * Create a blog post by invoking new-post.mjs.
 *
 * @param title   Post title (optional)
 * @param content Post body (optional)
 * @param summary One-line summary for the index page (optional)
 * @param slug    Override auto-generated slug (optional)
 * @param date    Override date as YYYY-MM-DD (optional)
 * @param dryRun  If true, print output without writing or pushing
 */
export function createPost(opts: {
  title: string;
  content: string;
  summary?: string;
  slug?: string;
  date?: string;
  dryRun?: boolean;
}): PostResult {
  const args: string[] = [SCRIPT_PATH, '--title', opts.title, '--content', opts.content];

  if (opts.summary) args.push('--summary', opts.summary);
  if (opts.slug) args.push('--slug', opts.slug);
  if (opts.date) args.push('--date', opts.date);
  if (opts.dryRun) args.push('--dry-run');

  try {
    const scriptDir = SCRIPT_PATH.replace(/\/new-post\.mjs$/, '');
    const stdout = execFileSync('node', args, {
      cwd: scriptDir,
      encoding: 'utf8',
      timeout: 30_000,
    });

    log.info('blog', stdout.trim());

    // Extract slug from "wrote .../posts/{slug}.md"
    const slugMatch = stdout.match(/wrote .+\/([^/]+)\.md/);
    const slug = slugMatch?.[1];

    return { ok: true, slug };
  } catch (err) {
    const msg = (err as Error).message;
    log.error('blog', 'post failed:', msg);
    return { ok: false, error: msg };
  }
}

/**
 * Parse a /post command message.
 *
 * Formats:
 *   /post Title | Summary | Content
 *   /post Title | Content               (no summary)
 *   /post Title\nContent                (newline-separated)
 */
export function parsePostCommand(text: string): { title: string; summary?: string; content: string } | null {
  // Strip /post prefix
  const raw = text.replace(/^\/post\s*/i, '').trim();
  if (!raw) return null;

  // Try pipe-separated: Title | Summary | Content  or  Title | Content
  const pipeParts = raw.split('|').map(s => s.trim());
  if (pipeParts.length >= 2) {
    const title = pipeParts[0];
    if (pipeParts.length >= 3) {
      return { title, summary: pipeParts[1], content: pipeParts.slice(2).join('|').trim() };
    }
    // Could be Title | Content (no summary) — use summary as content hint
    // If second part looks like a summary (short), treat as summary + rest as content
    if (pipeParts.length === 2 && pipeParts[1].length > 100) {
      return { title, content: pipeParts[1] };
    }
    return { title, summary: pipeParts[1], content: '' };
  }

  // Try newline-separated: first line = title, rest = content
  const nlIdx = raw.indexOf('\n');
  if (nlIdx !== -1) {
    const title = raw.slice(0, nlIdx).trim();
    const content = raw.slice(nlIdx + 1).trim();
    if (title && content) return { title, content };
  }

  // Single line — title only, content must come as reply
  return { title: raw, content: '' };
}

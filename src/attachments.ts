import type { Context } from 'grammy';
import { config } from './config';
import { log } from './log';
import type { PromptPart } from './opencode';

/**
 * Turning a Telegram attachment into an opencode prompt part.
 *
 * Sent as a `data:` URL rather than a path or a file:// URL on purpose — the
 * bridge and the opencode server are separate processes and need not share a
 * filesystem (they already do not under systemd, where each has its own
 * WorkingDirectory). A self-contained payload works in every arrangement.
 */

/** Telegram's Bot API refuses to serve files past 20MB, whatever the chat shows. */
export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

export interface Attachment {
  part: PromptPart;
  bytes: number;
  filename: string;
  mime: string;
}

/** Best-effort mime from a filename, for the cases Telegram leaves it unset. */
function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return (
    {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      heic: 'image/heic',
      pdf: 'application/pdf',
      txt: 'text/plain',
      md: 'text/markdown',
      csv: 'text/csv',
      json: 'application/json',
    }[ext] ?? 'application/octet-stream'
  );
}

/**
 * Download a Telegram file and wrap it as a prompt part.
 *
 * Returns a reason string instead of throwing when the file cannot be used, so
 * the caller can tell the user *why* rather than failing the whole turn.
 */
export async function fetchAttachment(
  ctx: Context,
  opts: { fileId: string; filename?: string; mime?: string; declaredSize?: number },
): Promise<Attachment | { error: string }> {
  const declared = opts.declaredSize ?? 0;
  if (declared > config.maxInboundBytes) {
    return { error: `that file is ${Math.round(declared / 1e6)}MB — the limit is ${Math.round(config.maxInboundBytes / 1e6)}MB` };
  }
  if (declared > TELEGRAM_DOWNLOAD_LIMIT) {
    return { error: 'Telegram will not serve files larger than 20MB to bots' };
  }

  let file;
  try {
    file = await ctx.api.getFile(opts.fileId);
  } catch (err) {
    return { error: `Telegram would not release the file: ${(err as Error).message}` };
  }
  if (!file.file_path) return { error: 'Telegram returned no download path for that file' };

  const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
  let buf: ArrayBuffer;
  try {
    const res = await fetch(url);
    if (!res.ok) return { error: `download failed with HTTP ${res.status}` };
    buf = await res.arrayBuffer();
  } catch (err) {
    return { error: `download failed: ${(err as Error).message}` };
  }

  // Checked again post-download: Telegram's declared size is absent for photos,
  // so this is the only point where the real size is known.
  if (buf.byteLength > config.maxInboundBytes) {
    return { error: `that file is ${Math.round(buf.byteLength / 1e6)}MB — the limit is ${Math.round(config.maxInboundBytes / 1e6)}MB` };
  }

  const filename = opts.filename ?? file.file_path.split('/').pop() ?? 'attachment';
  const mime = opts.mime ?? mimeFromName(filename);
  const base64 = Buffer.from(buf).toString('base64');

  log.info('attach', `${filename} (${mime}, ${Math.round(buf.byteLength / 1024)}KB)`);

  return {
    bytes: buf.byteLength,
    filename,
    mime,
    part: { type: 'file', mime, filename, url: `data:${mime};base64,${base64}` },
  };
}

/** Telegram hard-caps messages at 4096 chars; leave room for headers and markers. */
export const TG_LIMIT = 3800;

/** Per-tool output cap, so one noisy command cannot flood the chat. */
export const TOOL_OUTPUT_LIMIT = 1200;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TOOL_ICON: Record<string, string> = {
  pending: '○',
  running: '◐',
  completed: '●',
  error: '✕',
};

/** One-line summary of a tool call — the interesting argument, not the whole payload. */
export function renderTool(part: any): string | null {
  const state = part.state ?? {};
  const icon = TOOL_ICON[state.status] ?? '○';
  const input = state.input ?? {};
  const detail =
    input.command ??
    input.filePath ??
    input.path ??
    input.pattern ??
    input.description ??
    '';
  const short = String(detail).replace(/\s+/g, ' ').slice(0, 90);
  if (part.tool === 'read') return null;
  const head = `${icon} ${part.tool}${short ? ` ${short}` : ''}`;

  // Completed output is the whole point of the `!` bypass — without it you are
  // firing commands blind from the phone.
  const body =
    state.status === 'completed' ? String(state.output ?? '') :
    state.status === 'error' ? String(state.error ?? '') : '';
  if (!body.trim()) return head;

  const clipped = body.length > TOOL_OUTPUT_LIMIT
    ? `${body.slice(0, TOOL_OUTPUT_LIMIT)}\n…(${body.length} chars)`
    : body;
  // Neutralise fences in the output so they cannot break out of the code block.
  return `${head}\n\`\`\`\n${clipped.trimEnd().replace(/```/g, "'''")}\n\`\`\``;
}

/**
 * Split a chunk at the last newline before the limit so code blocks and lines
 * survive the cut where possible.
 */
export function splitAt(text: string, limit: number): number {
  if (text.length <= limit) return text.length;
  const window = text.slice(0, limit);
  const nl = window.lastIndexOf('\n');
  return nl > limit * 0.5 ? nl + 1 : limit;
}

/**
 * Telegram rejects malformed HTML with a 400, so escape everything and only
 * re-introduce the few tags we generate ourselves.
 */
export function toTelegramHtml(text: string): string {
  const fences = text.split(/```/);
  return fences
    .map((chunk, i) => {
      if (i % 2 === 1) {
        const body = chunk.replace(/^[a-zA-Z0-9_-]*\n/, '');
        return `<pre>${escapeHtml(body)}</pre>`;
      }
      return escapeHtml(chunk);
    })
    .join('');
}

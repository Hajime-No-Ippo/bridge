import { describe, expect, mock, test } from 'bun:test';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_ALLOWED_CHAT_IDS = '111';

const { Relay } = await import('../src/relay');
const { TG_LIMIT } = await import('../src/render');

let nextId = 1;
const sendMessage = mock(() => Promise.resolve({ message_id: nextId++ }));
const editMessageText = mock(() => Promise.resolve());
const fakeBot = { api: { sendMessage, editMessageText } } as any;

/** Every sent/edited message must have balanced <pre> tags. */
function expectBalancedPre() {
  const payloads = [...sendMessage.mock.calls, ...editMessageText.mock.calls].map(c => c[1] as string);
  for (const html of payloads) {
    const opens = (html.match(/<pre>/g) ?? []).length;
    const closes = (html.match(/<\/pre>/g) ?? []).length;
    expect({ html: html.slice(0, 60), opens, closes }).toEqual(
      expect.objectContaining({ opens: closes }),
    );
  }
}

describe('fence-aware split', () => {
  test('a code block straddling the TG_LIMIT cut stays balanced in both messages', async () => {
    const relay = new Relay(fakeBot);
    const s = (relay as any).state('sess');

    // Intro ~2000 chars, then a fenced block long enough to straddle the cut.
    const line = (ch: string, n: number) => Array.from({ length: n }, (_, i) => `${ch}${i}`).join('\n');
    const intro = line('i', 400);            // ~2000 chars
    const code = line('c', 500);             // ~2500 chars, spans the 3800 cut
    const outro = line('o', 300);            // ~1500 chars
    const text = `${intro}\n\`\`\`\n${code}\n\`\`\`\n${outro}`;
    expect(text.length).toBeGreaterThan(TG_LIMIT);

    s.order.push('p1');
    s.parts.set('p1', text);

    await (relay as any).flush('sess');

    // Spilled into at least two content messages.
    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(3); // header + 2 chunks
    expectBalancedPre();
  });

  test('short turn with fences sends one balanced message', async () => {
    sendMessage.mockClear(); editMessageText.mockClear();
    const relay = new Relay(fakeBot);
    const s = (relay as any).state('sess2');
    s.order.push('p1');
    s.parts.set('p1', 'before\n```\ncode\n```\nafter');
    await (relay as any).flush('sess2');
    expect(sendMessage.mock.calls.length).toBe(2); // header + one chunk
    expectBalancedPre();
  });
});

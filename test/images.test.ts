import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Deterministic config: one allowlisted chat, default 5-min freshness window.
// Must be set before importing anything that pulls in src/config.ts.
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_ALLOWED_CHAT_IDS = '111';

const { Relay } = await import('../src/relay');
const { sweepTempImages } = await import('../src/tools/screenshot');

const HOUR = 60 * 60 * 1000;

const sendDocument = mock(() => Promise.resolve());
const sendMessage = mock(() => Promise.resolve({ message_id: 1 }));
const fakeBot = { api: { sendDocument, sendMessage } } as any;

const relay = new Relay(fakeBot);
// relayImages is private; these tests exercise it directly rather than
// fabricating whole event-stream payloads.
const relayImages = (text: string): Promise<void> => (relay as any).relayImages(text);

/** Write a tiny file at `path`, optionally backdated by `ageMs`. */
function makeImage(path: string, ageMs = 0): string {
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic, content irrelevant
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    utimesSync(path, t, t);
  }
  return path;
}

const created: string[] = [];
beforeEach(() => sendDocument.mockClear());
afterAll(() => {
  for (const p of created) {
    try { unlinkSync(p); } catch { /* already swept */ }
  }
});

describe('relayImages freshness guard', () => {
  test('ls output full of stale screenshots sends nothing (the pre-fix flood)', async () => {
    // Pre-fix behaviour being pinned down: relayImages had no mtime check, so
    // this exact scenario — an `ls -la` of the temp dir after a bridge restart
    // had wiped the in-memory dedupe set — re-sent every image to Telegram.
    const paths = ['flood-a.png', 'flood-b.png', 'flood-c.png'].map(n =>
      makeImage(join(tmpdir(), `relay-test-${n}`), 2 * HOUR),
    );
    created.push(...paths);

    const lsOutput = paths
      .map(p => `-rw-r--r--@ 1 erictao  staff  243787  5 Aug 01:08 ${p}`)
      .join('\n');
    await relayImages(lsOutput);

    expect(sendDocument).not.toHaveBeenCalled();
  });

  test('a fresh screenshot is sent once per allowlisted chat', async () => {
    const path = makeImage(join(tmpdir(), 'relay-test-fresh.png'));
    created.push(path);

    await relayImages(`screenshot saved to ${path}`);

    expect(sendDocument).toHaveBeenCalledTimes(1);
  });

  test('the same fresh path is not sent twice', async () => {
    const path = makeImage(join(tmpdir(), 'relay-test-dupe.png'));
    created.push(path);

    await relayImages(path);
    await relayImages(path);

    expect(sendDocument).toHaveBeenCalledTimes(1);
  });
});

describe('sweepTempImages', () => {
  test('deletes stale PNGs, keeps fresh PNGs and stale non-PNGs', () => {
    const scratch = join(tmpdir(), 'opencode');
    mkdirSync(scratch, { recursive: true });

    const staleCapture = makeImage(join(tmpdir(), `opencode-tui-test-${process.pid}.png`), 2 * HOUR);
    const staleScratch = makeImage(join(scratch, 'sweep-test-stale.png'), 2 * HOUR);
    const freshScratch = makeImage(join(scratch, 'sweep-test-fresh.png'));
    const staleOther = join(scratch, 'sweep-test-notes.txt');
    writeFileSync(staleOther, 'keep me');
    const t = new Date(Date.now() - 2 * HOUR);
    utimesSync(staleOther, t, t);
    created.push(staleCapture, staleScratch, freshScratch, staleOther);

    sweepTempImages(HOUR);

    expect(existsSync(staleCapture)).toBe(false); // bridge's own capture pattern
    expect(existsSync(staleScratch)).toBe(false); // agent scratch-dir PNG
    expect(existsSync(freshScratch)).toBe(true);  // too young to sweep
    expect(existsSync(staleOther)).toBe(true);    // not an image, never swept
  });
});

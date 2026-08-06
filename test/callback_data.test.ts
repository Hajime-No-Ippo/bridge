import { describe, expect, test } from 'bun:test';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_ALLOWED_CHAT_IDS = '111';

const { CALLBACK_DATA_LIMIT, cb, nextToken } = await import('../src/relay.ts');

// Real values from the run that wedged a session: a permission id and a session
// id together overflow Telegram's cap, and the whole sendMessage is rejected
// with BUTTON_DATA_INVALID — so the Approve button never arrives and the turn
// hangs forever with no way to answer it.
const SESSION_ID = 'ses_02bdfb279ffeh5TJrTFdG2ykdg';
const PERMISSION_ID = 'per_8f2a1c4e9b7d3a6f0e5c2b8a';

const size = (s: string) => Buffer.byteLength(s, 'utf8');

describe('inline button callback_data', () => {
  test('the old id-carrying format was over the limit — this is the bug', () => {
    const old = `perm|always|${PERMISSION_ID}|${SESSION_ID}`;
    expect(size(old)).toBeGreaterThan(CALLBACK_DATA_LIMIT);
  });

  test('every permission button fits', () => {
    const token = nextToken();
    for (const verb of ['once', 'always', 'reject']) {
      expect(size(cb(`perm|${verb}|${token}`))).toBeLessThanOrEqual(CALLBACK_DATA_LIMIT);
    }
  });

  test('every question button fits, including the last option', () => {
    const token = nextToken();
    for (let i = 0; i < 6; i++) {
      expect(size(cb(`ask|${token}|${i}`))).toBeLessThanOrEqual(CALLBACK_DATA_LIMIT);
    }
  });

  test('tokens stay short and unique after many turns', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const t = nextToken();
      expect(seen.has(t)).toBe(false);
      seen.add(t);
      expect(size(`perm|always|${t}`)).toBeLessThanOrEqual(CALLBACK_DATA_LIMIT);
    }
  });

  test('cb passes data through unchanged', () => {
    expect(cb('perm|once|7')).toBe('perm|once|7');
  });
});

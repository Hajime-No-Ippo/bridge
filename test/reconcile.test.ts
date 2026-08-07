import { beforeEach, describe, expect, test } from 'bun:test';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_ALLOWED_CHAT_IDS = '111';

const { Relay, pendingPermissions, CALLBACK_DATA_LIMIT } = await import('../src/relay.ts');
const { opencode, internalSessions } = await import('../src/opencode.ts');

interface Sent {
  chatId: number | string;
  text: string;
  markup?: any;
}

/** Minimal stand-in for the parts of grammy's Bot that Relay actually touches. */
function fakeBot(sent: Sent[]) {
  return {
    api: {
      sendMessage: async (chatId: number | string, text: string, opts?: any) => {
        sent.push({ chatId, text, markup: opts?.reply_markup });
        return { message_id: sent.length };
      },
    },
  } as any;
}

const PERMISSION = {
  id: 'per_fd4350e370011cGYm10nMoCGeG',
  sessionID: 'ses_02bdfb279ffeh5TJrTFdG2ykdg',
  permission: 'external_directory',
  patterns: ['/Users/erictao/.config/opencode/*'],
};

let restore: typeof opencode.listPermissions;

beforeEach(() => {
  pendingPermissions.clear();
  internalSessions.clear();
  restore = opencode.listPermissions;
});

const stub = (value: any) => {
  (opencode as any).listPermissions = async () => value;
};
const unstub = () => {
  (opencode as any).listPermissions = restore;
};

describe('restart reconciliation', () => {
  test('re-posts buttons for a permission left pending, and makes it answerable', async () => {
    // The exact failure this exists to prevent: the process restarts, the token
    // map is empty, and the Approve button already in the chat is dead — so the
    // session stays blocked forever with no way to answer it from Telegram.
    const sent: Sent[] = [];
    stub([PERMISSION]);
    try {
      const n = await new Relay(fakeBot(sent)).reconcilePermissions();
      expect(n).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toContain('restored after restart');
      expect(sent[0]!.text).toContain('external_directory');

      // The token map must be repopulated, or the new buttons are dead too.
      const entries = [...pendingPermissions.values()];
      expect(entries).toHaveLength(1);
      expect(entries[0]!.requestID).toBe(PERMISSION.id);
      expect(entries[0]!.sessionID).toBe(PERMISSION.sessionID);
    } finally {
      unstub();
    }
  });

  test('restored buttons respect the 64-byte callback_data cap', async () => {
    const sent: Sent[] = [];
    stub([PERMISSION]);
    try {
      await new Relay(fakeBot(sent)).reconcilePermissions();
      const buttons = sent[0]!.markup.inline_keyboard.flat();
      expect(buttons).toHaveLength(3);
      for (const b of buttons) {
        expect(Buffer.byteLength(b.callback_data, 'utf8')).toBeLessThanOrEqual(CALLBACK_DATA_LIMIT);
      }
    } finally {
      unstub();
    }
  });

  test('does not double-post one it can already answer', async () => {
    const sent: Sent[] = [];
    pendingPermissions.set('9', {
      requestID: PERMISSION.id,
      sessionID: PERMISSION.sessionID,
      askedAt: Date.now(),
      nudgedAt: Date.now(),
    });
    stub([PERMISSION]);
    try {
      expect(await new Relay(fakeBot(sent)).reconcilePermissions()).toBe(0);
      expect(sent).toHaveLength(0);
    } finally {
      unstub();
    }
  });

  test('ignores permissions belonging to internal classify sessions', async () => {
    const sent: Sent[] = [];
    internalSessions.add(PERMISSION.sessionID);
    stub([PERMISSION]);
    try {
      expect(await new Relay(fakeBot(sent)).reconcilePermissions()).toBe(0);
      expect(sent).toHaveLength(0);
    } finally {
      unstub();
    }
  });

  test('nothing pending is a clean no-op', async () => {
    const sent: Sent[] = [];
    stub([]);
    try {
      expect(await new Relay(fakeBot(sent)).reconcilePermissions()).toBe(0);
      expect(sent).toHaveLength(0);
    } finally {
      unstub();
    }
  });

  test('a failing API must not stop the bridge from starting', async () => {
    // Refusing to boot because reconciliation failed would be strictly worse
    // than booting without it.
    const sent: Sent[] = [];
    (opencode as any).listPermissions = async () => {
      throw new Error('connection refused');
    };
    try {
      expect(await new Relay(fakeBot(sent)).reconcilePermissions()).toBe(0);
    } finally {
      unstub();
    }
  });

  test('survives a malformed response', async () => {
    const sent: Sent[] = [];
    stub([{ id: 'per_x' }, null, { sessionID: 'ses_y' }, PERMISSION]);
    try {
      // Only the well-formed entry is restored; the junk is skipped, not thrown on.
      expect(await new Relay(fakeBot(sent)).reconcilePermissions()).toBe(1);
    } finally {
      unstub();
    }
  });
});

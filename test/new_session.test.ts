import { beforeEach, describe, expect, test } from 'bun:test';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_ALLOWED_CHAT_IDS = '111';

const { registerNew } = await import('../src/new_session.ts');
const { opencode } = await import('../src/opencode.ts');

type Handler = (ctx: any) => Promise<void>;

/** Captures the command handler so it can be invoked directly. */
function fakeBot() {
  const handlers = new Map<string, Handler>();
  return {
    bot: { command: (name: string, h: Handler) => handlers.set(name, h) } as any,
    run: (match: string, replies: string[]) =>
      handlers.get('new')!({ match, reply: async (t: string) => void replies.push(t) }),
  };
}

const OLD = {
  id: 'ses_old',
  title: 'Mr. Code',
  model: { providerID: 'deepseek', id: 'deepseek-v4-pro' },
};

let calls: string[];
let saved: Record<string, any>;

beforeEach(() => {
  calls = [];
  saved = {
    pinnedSession: opencode.pinnedSession,
    pinSession: opencode.pinSession,
    createSession: opencode.createSession,
    setModel: opencode.setModel,
    getModel: opencode.getModel,
    renameSession: opencode.renameSession,
  };
  (opencode as any).pinnedSession = async () => {
    calls.push('pinnedSession');
    return OLD;
  };
  (opencode as any).pinSession = (sid: string) => {
    calls.push(`pinSession:${sid}`);
  };
  (opencode as any).createSession = async () => {
    calls.push('createSession');
    return { id: 'ses_new', title: 'New session' };
  };
  (opencode as any).setModel = (sid: string, p: string, m: string) => {
    calls.push(`setModel:${sid}:${p}/${m}`);
  };
  (opencode as any).getModel = () => undefined;
  (opencode as any).renameSession = async (sid: string, t: string) => {
    calls.push(`rename:${sid}:${t}`);
  };
});

const restore = () => Object.assign(opencode as any, saved);

describe('/new', () => {
  test('reads the old model BEFORE re-pinning, or it would inherit the new session\'s own default', async () => {
    // Ordering is the whole correctness argument: once the pin has moved,
    // reading it back would return the new session instead of the old one's.
    const { bot, run } = fakeBot();
    registerNew(bot);
    const replies: string[] = [];
    try {
      await run('', replies);
      expect(calls.indexOf('pinnedSession')).toBeLessThan(calls.indexOf('createSession'));
      expect(calls).toContain('setModel:ses_new:deepseek/deepseek-v4-pro');
    } finally {
      restore();
    }
  });

  test('pins the new session, or /new would create sessions nothing ever uses', async () => {
    const { bot, run } = fakeBot();
    registerNew(bot);
    const replies: string[] = [];
    try {
      await run('', replies);
      expect(calls).toContain('pinSession:ses_new');
    } finally {
      restore();
    }
  });

  test('carries the model over and says which one', async () => {
    const { bot, run } = fakeBot();
    registerNew(bot);
    const replies: string[] = [];
    try {
      await run('', replies);
      expect(replies[0]).toContain('deepseek/deepseek-v4-pro');
      expect(replies[0]).toContain('fresh context');
    } finally {
      restore();
    }
  });

  test('applies a title when given, and names the previous session', async () => {
    const { bot, run } = fakeBot();
    registerNew(bot);
    const replies: string[] = [];
    try {
      await run('  linux phase 2  ', replies);
      expect(calls).toContain('rename:ses_new:linux phase 2');
      expect(replies[0]).toContain('linux phase 2');
      // The old thread is kept, not discarded — say so, or /new reads as destructive.
      expect(replies[0]).toContain('Mr. Code');
    } finally {
      restore();
    }
  });

  test('a failed rename still leaves a usable session', async () => {
    // The session already exists and is already the target by then, so calling
    // the whole command failed would be wrong.
    (opencode as any).renameSession = async () => { throw new Error('nope'); };
    const { bot, run } = fakeBot();
    registerNew(bot);
    const replies: string[] = [];
    try {
      await run('whatever', replies);
      expect(replies[0]).toContain('Prompts now go here');
      expect(replies[0]).toContain('/rename');
    } finally {
      restore();
    }
  });

  test('a failed create reports and creates nothing', async () => {
    (opencode as any).createSession = async () => { throw new Error('connection refused'); };
    const { bot, run } = fakeBot();
    registerNew(bot);
    const replies: string[] = [];
    try {
      await run('', replies);
      expect(replies[0]).toContain('Could not start a new session');
      expect(calls).not.toContain('setModel');
      expect(calls.some(c => c.startsWith('pinSession'))).toBe(false);
    } finally {
      restore();
    }
  });

  test('works with no previous session at all', async () => {
    (opencode as any).pinnedSession = async () => undefined;
    const { bot, run } = fakeBot();
    registerNew(bot);
    const replies: string[] = [];
    try {
      await run('', replies);
      expect(replies[0]).toContain('Prompts now go here');
      expect(calls.some(c => c.startsWith('setModel'))).toBe(false);
    } finally {
      restore();
    }
  });
});

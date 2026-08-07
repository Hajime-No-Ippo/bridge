import { beforeEach, describe, expect, test } from 'bun:test';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_ALLOWED_CHAT_IDS = '111';

const { Relay, pendingPermissions, pendingQuestions, supersedeQuestions } =
  await import('../src/relay.ts');
const { opencode, OpencodeHttpError } = await import('../src/opencode.ts');
const { config } = await import('../src/config.ts');

interface Sent {
  text: string;
}

/**
 * Stand-in for the parts of grammy's Bot the pending paths touch.
 *
 * `retired` is the assertion that matters most here: a block the bridge has
 * given up on must lose its keyboard, or the chat keeps offering buttons that
 * can only ever report a failure.
 */
function fakeBot(sent: Sent[], retired: number[]) {
  return {
    api: {
      sendMessage: async (_chatId: number | string, text: string) => {
        sent.push({ text });
        return { message_id: sent.length };
      },
      editMessageReplyMarkup: async (_chatId: number | string, messageId: number) => {
        retired.push(messageId);
      },
    },
  } as any;
}

const SESSION = 'ses_02bdfb279ffeh5TJrTFdG2ykdg';
const STALE = () => Date.now() - config.pendingTtlMs - 1000;

/** A block that started long enough ago to be past both thresholds. */
const aged = (over: Partial<any> = {}) => ({
  requestID: 'req_1',
  sessionID: SESSION,
  askedAt: STALE(),
  nudgedAt: STALE(),
  messageId: 7,
  ...over,
});

let calls: string[];
let saved: Record<string, any>;

beforeEach(() => {
  pendingPermissions.clear();
  pendingQuestions.clear();
  calls = [];
  saved = {
    listPermissions: opencode.listPermissions,
    listQuestions: opencode.listQuestions,
    replyPermission: opencode.replyPermission,
    rejectQuestion: opencode.rejectQuestion,
  };
  (opencode as any).listPermissions = async () => [];
  (opencode as any).listQuestions = async () => [];
  (opencode as any).replyPermission = async (id: string, _s: string, reply: string) => {
    calls.push(`replyPermission:${id}:${reply}`);
  };
  (opencode as any).rejectQuestion = async (id: string) => {
    calls.push(`rejectQuestion:${id}`);
  };
});

const restoreAll = () => Object.assign(opencode as any, saved);

describe('a new prompt supersedes an unanswered question', () => {
  test('rejects it server-side, drops it, and retires its buttons', async () => {
    // The reported failure: a question was asked, the answer was TYPED rather
    // than tapped, and the typed text went in as a fresh prompt while the
    // question kept the turn blocked. The session then looked dead.
    const retired: number[] = [];
    pendingQuestions.set('q1', aged({ requestID: 'que_1', question: { header: 'Dir?' } }));
    try {
      expect(await supersedeQuestions(fakeBot([], retired))).toBe(1);
      expect(calls).toEqual(['rejectQuestion:que_1']);
      expect(pendingQuestions.size).toBe(0);
      expect(retired).toEqual([7]);
    } finally {
      restoreAll();
    }
  });

  test('leaves permissions alone', async () => {
    // A typed message must never stand in for Approve/Deny — that would turn
    // an ordinary chat message into a security decision.
    const retired: number[] = [];
    pendingPermissions.set('p1', aged({ requestID: 'per_1' }));
    try {
      expect(await supersedeQuestions(fakeBot([], retired))).toBe(0);
      expect(pendingPermissions.size).toBe(1);
      expect(calls).toEqual([]);
      expect(retired).toEqual([]);
    } finally {
      restoreAll();
    }
  });

  test('a reject that fails still clears the block', async () => {
    // Whatever the server says, the user has moved on. Keeping the entry after
    // a failed reject would re-block the very next prompt too.
    const retired: number[] = [];
    (opencode as any).rejectQuestion = async () => {
      throw new OpencodeHttpError(404, 'POST', '/question/que_1/reply', 'gone');
    };
    pendingQuestions.set('q1', aged({ requestID: 'que_1', question: {} }));
    try {
      expect(await supersedeQuestions(fakeBot([], retired))).toBe(1);
      expect(pendingQuestions.size).toBe(0);
      expect(retired).toEqual([7]);
    } finally {
      restoreAll();
    }
  });
});

describe('sweep', () => {
  test('drops a permission the server no longer lists, silently', async () => {
    // Answered in the TUI, or covered by a saved `always` rule. GET /permission
    // is the authority; the copy here is just stale.
    const sent: Sent[] = [];
    const retired: number[] = [];
    pendingPermissions.set('p1', {
      requestID: 'per_1', sessionID: SESSION,
      askedAt: Date.now(), nudgedAt: Date.now(), messageId: 7,
    });
    try {
      await (new Relay(fakeBot(sent, retired)) as any).sweepPending();
      expect(pendingPermissions.size).toBe(0);
      expect(retired).toEqual([7]);
      expect(sent).toHaveLength(0);   // nothing happened TO the user; no message
    } finally {
      restoreAll();
    }
  });

  test('keeps a permission the server still lists', async () => {
    const sent: Sent[] = [];
    const retired: number[] = [];
    (opencode as any).listPermissions = async () => [{ id: 'per_1', sessionID: SESSION }];
    pendingPermissions.set('p1', {
      requestID: 'per_1', sessionID: SESSION,
      askedAt: Date.now(), nudgedAt: Date.now(), messageId: 7,
    });
    try {
      await (new Relay(fakeBot(sent, retired)) as any).sweepPending();
      expect(pendingPermissions.size).toBe(1);
      expect(retired).toEqual([]);
    } finally {
      restoreAll();
    }
  });

  test('an unreachable server expires nothing early', async () => {
    // A fresh block plus a dead server must not read as "resolved elsewhere",
    // or every restart-adjacent hiccup would revoke live buttons.
    const sent: Sent[] = [];
    const retired: number[] = [];
    (opencode as any).listPermissions = async () => { throw new Error('connection refused'); };
    pendingPermissions.set('p1', {
      requestID: 'per_1', sessionID: SESSION,
      askedAt: Date.now(), nudgedAt: Date.now(), messageId: 7,
    });
    try {
      await (new Relay(fakeBot(sent, retired)) as any).sweepPending();
      expect(pendingPermissions.size).toBe(1);
      expect(retired).toEqual([]);
    } finally {
      restoreAll();
    }
  });

  test('drops a question the server no longer lists, silently', async () => {
    // Answered in the TUI. GET /question is the authority, same as permissions.
    const sent: Sent[] = [];
    const retired: number[] = [];
    pendingQuestions.set('q1', {
      requestID: 'que_1', sessionID: SESSION, question: {},
      askedAt: Date.now(), nudgedAt: Date.now(), messageId: 7,
    });
    try {
      await (new Relay(fakeBot(sent, retired)) as any).sweepPending();
      expect(pendingQuestions.size).toBe(0);
      expect(retired).toEqual([7]);
      expect(calls).toEqual([]);        // nothing to reject — it was already gone
      expect(sent).toHaveLength(0);
    } finally {
      restoreAll();
    }
  });

  test('expires a stale question by actually rejecting it', async () => {
    // Releasing the turn is the point. Forgetting the entry locally while the
    // server stayed blocked would be the original bug with extra steps.
    const sent: Sent[] = [];
    const retired: number[] = [];
    (opencode as any).listQuestions = async () => [{ id: 'que_1', sessionID: SESSION }];
    pendingQuestions.set('q1', aged({ requestID: 'que_1', question: {} }));
    try {
      await (new Relay(fakeBot(sent, retired)) as any).sweepPending();
      expect(calls).toEqual(['rejectQuestion:que_1']);
      expect(pendingQuestions.size).toBe(0);
      expect(retired).toEqual([7]);
      expect(sent.some(s => s.text.includes('Question expired'))).toBe(true);
    } finally {
      restoreAll();
    }
  });

  test('expires a stale permission as a denial', async () => {
    const sent: Sent[] = [];
    const retired: number[] = [];
    (opencode as any).listPermissions = async () => [{ id: 'per_1', sessionID: SESSION }];
    pendingPermissions.set('p1', aged({ requestID: 'per_1' }));
    try {
      await (new Relay(fakeBot(sent, retired)) as any).sweepPending();
      expect(calls).toEqual(['replyPermission:per_1:reject']);
      expect(pendingPermissions.size).toBe(0);
      expect(sent.some(s => s.text.includes('Permission expired'))).toBe(true);
    } finally {
      restoreAll();
    }
  });

  test('nudges a block that is overdue but not yet expired', async () => {
    const sent: Sent[] = [];
    const retired: number[] = [];
    (opencode as any).listPermissions = async () => [{ id: 'per_1', sessionID: SESSION }];
    const entry = {
      requestID: 'per_1', sessionID: SESSION,
      askedAt: Date.now(), messageId: 7,
      nudgedAt: Date.now() - config.pendingNudgeMs - 1000,
    };
    pendingPermissions.set('p1', entry);
    try {
      const relay = new Relay(fakeBot(sent, retired)) as any;
      await relay.sweepPending();
      expect(sent.some(s => s.text.includes('Still waiting on you'))).toBe(true);
      expect(pendingPermissions.size).toBe(1);   // nudging is not expiring

      // The reminder must not repeat on every sweep — nudgedAt was just reset.
      sent.length = 0;
      await relay.sweepPending();
      expect(sent).toHaveLength(0);
    } finally {
      restoreAll();
    }
  });
});

describe('restart reconciliation for questions', () => {
  test('re-posts a question the server is still blocked on', async () => {
    // The incident: the bridge restarted, pendingQuestions came back empty, and
    // the question from before the restart became invisible — so nothing could
    // supersede or expire it and every later prompt was silently dropped.
    const sent: Sent[] = [];
    const retired: number[] = [];
    (opencode as any).listQuestions = async () => [{
      id: 'que_1',
      sessionID: SESSION,
      questions: [{
        header: 'Construction target dir',
        question: 'Which directory?',
        options: [{ label: '~/hackathon' }, { label: '~/telegram-bridge' }],
      }],
    }];
    try {
      const relay = new Relay(fakeBot(sent, retired));
      expect(await relay.reconcileQuestions()).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toContain('restored after restart');
      // Answerable again: the re-posted buttons must map to a live token.
      const entry = [...pendingQuestions.values()][0]!;
      expect(entry.requestID).toBe('que_1');
      expect(entry.sessionID).toBe(SESSION);
    } finally {
      restoreAll();
    }
  });

  test('does not double-post one it can already answer', async () => {
    const sent: Sent[] = [];
    (opencode as any).listQuestions = async () => [{
      id: 'que_1', sessionID: SESSION, questions: [{ question: 'Which?', options: [] }],
    }];
    pendingQuestions.set('q1', aged({ requestID: 'que_1', question: {} }));
    try {
      expect(await new Relay(fakeBot(sent, [])).reconcileQuestions()).toBe(0);
      expect(sent).toHaveLength(0);
    } finally {
      restoreAll();
    }
  });
});

describe('session.error', () => {
  test('clears what the dead turn was blocked on', async () => {
    // Nothing can answer a block on a turn that already failed, and its
    // buttons would otherwise sit in the chat looking actionable.
    const sent: Sent[] = [];
    const retired: number[] = [];
    pendingPermissions.set('p1', aged({ requestID: 'per_1', messageId: 5 }));
    pendingQuestions.set('q1', aged({ requestID: 'que_1', question: {}, messageId: 6 }));
    // A block belonging to some other session must survive.
    pendingQuestions.set('q2', aged({ requestID: 'que_2', sessionID: 'ses_other', question: {}, messageId: 9 }));
    try {
      await new Relay(fakeBot(sent, retired)).handle({
        type: 'session.error',
        properties: { sessionID: SESSION, error: { name: 'ProviderError' } },
      } as any);
      expect(pendingPermissions.size).toBe(0);
      expect([...pendingQuestions.keys()]).toEqual(['q2']);
      expect(retired.sort()).toEqual([5, 6]);
    } finally {
      restoreAll();
    }
  });
});

import { config } from './config';
import { log } from './log';

export interface OpencodeEvent {
  type: string;
  properties?: Record<string, any>;
}

export interface SessionInfo {
  id: string;
  title?: string;
  slug?: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

export interface ModelInfo {
  id: string;
  providerID: string;
  name?: string;
  /**
   * What the catalogue claims this model accepts.
   *
   * Present for config-defined providers, which arrive via `/provider`; absent
   * for `/api/model` entries. Callers must treat "absent" and "false" as
   * different answers — see src/vision.ts, where only an explicit `false` is
   * allowed to block anything.
   */
  capabilities?: {
    attachment?: boolean;
    input?: Partial<Record<'text' | 'audio' | 'image' | 'video' | 'pdf', boolean>>;
  };
}

/**
 * One part of a prompt. `file` is how anything non-textual gets in — the API
 * takes `{type,mime,url}`, and a data: URL keeps the payload self-contained so
 * the bridge and the opencode server need not share a filesystem.
 */
export type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; url: string; filename?: string };

/** An outstanding permission request, as returned by GET /permission. */
export interface PendingPermission {
  id: string;
  sessionID: string;
  /** v1 calls this `permission`, v2 `action`. */
  permission?: string;
  action?: string;
  /** v1 calls these `patterns`, v2 `resources`. */
  patterns?: string[];
  resources?: string[];
}

/**
 * An outstanding question, as returned by GET /question.
 *
 * The endpoint is the counterpart to GET /permission and carries the same
 * `{id, sessionID}` shape, plus the option list under `questions`.
 */
export interface PendingQuestionRequest {
  id: string;
  sessionID: string;
  questions?: any[];
}

function authHeaders(): Record<string, string> {
  if (!config.auth) return {};
  const raw = `${config.auth.username}:${config.auth.password}`;
  return { authorization: `Basic ${Buffer.from(raw).toString('base64')}` };
}

/**
 * An opencode HTTP failure, carrying enough to branch on.
 *
 * Callers need to tell a *routing* failure (wrong path, old server) from a
 * *semantic* one (the thing you asked about is gone). Both are 404s, and
 * treating them alike is how a resolved permission turned into a retry against
 * a second route and a second, more confusing 404.
 */
export class OpencodeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`opencode ${method} ${path} -> ${status} ${body}`);
    this.name = 'OpencodeHttpError';
  }

  /**
   * The permission request no longer exists: already answered, superseded by a
   * saved `always` rule, or discarded when the turn moved on. Not a failure —
   * the user's intent is already satisfied.
   */
  get isPermissionGone(): boolean {
    return this.status === 404 && this.body.includes('PermissionNotFoundError');
  }

  /**
   * The question no longer exists: answered in the TUI, rejected because a new
   * prompt superseded it, or discarded when the turn ended.
   *
   * Unlike permissions there is no verified error-name string to match on, and
   * `/question/{id}/reply` has no legacy route to fall back to — so any 404 from
   * it is read as gone. A genuine routing bug would land here too, which is why
   * callers log the hit instead of swallowing it.
   */
  get isQuestionGone(): boolean {
    return this.status === 404;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.opencodeUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...authHeaders(),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new OpencodeHttpError(res.status, init.method ?? 'GET', path, await res.text());
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

/**
 * Sessions the bridge creates for its own plumbing (e.g. reaction
 * classification). The relay must never mirror these to Telegram.
 */
export const internalSessions = new Set<string>();

const patch = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) });

export const opencode = {
  health: () => request<{ healthy: boolean }>('/api/health'),

  listSessions: () => request<SessionInfo[]>('/session'),

  getSession: (sessionID: string) => request<SessionInfo>(`/session/${sessionID}`),

  renameSession: (sessionID: string, title: string) =>
    patch<SessionInfo>(`/session/${sessionID}`, { title }),

  /**
   * Mirror-mode write path: type into the attached TUI's prompt box and submit
   * from there, so the TUI stays the single writer and the two views cannot drift.
   *
   * REQUIRES A LIVE TUI. `/tui/submit-prompt` does not run the prompt — it emits
   * a `tui.command.execute` event for an attached TUI to act on, and returns
   * HTTP 200 either way. With nothing attached the turn is never run at all and
   * the bridge waits forever for a reply that cannot come. Prefer `promptAsync`.
   */
  appendPrompt: (text: string) => post<boolean>('/tui/append-prompt', { text }),

  submitPrompt: () => post<boolean>('/tui/submit-prompt'),

  /**
   * Headless write path: run a prompt in a session and return immediately.
   *
   * The reply arrives on `/event`, which the relay is already consuming — so
   * streaming to Telegram is unchanged. Unlike the TUI pair above this needs no
   * attached client, and unlike `promptAndWait` it does not block the handler
   * for the whole turn.
   */
  promptAsync: (sessionID: string, prompt: string | PromptPart[]) =>
    post(`/session/${sessionID}/prompt_async`, {
      parts: typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt,
    }),

  /** Execute a shell command in the session — sends as a prompt for the agent to run. */
  /**
   * Run a shell command directly in a session — no model inference (cost 0), and
   * the output arrives as bash tool parts on the event stream, so the relay picks
   * it up like any other output.
   *
   * Note the TUI's own `!` prefix executes locally and emits nothing on /event,
   * which is why the bridge cannot just forward `!cmd` through append-prompt.
   */
  runShell: (sessionID: string, command: string, agent = 'build') =>
    post<{ info?: { id: string } }>(`/session/${sessionID}/shell`, { agent, command }),

  /** Most recently updated session — what `!` and /stop act on. Internal bridge sessions don't count. */
  async latestSession(): Promise<SessionInfo | undefined> {
    const sessions = await request<SessionInfo[]>('/session');
    return sessions.find(s => !internalSessions.has(s.id));
  },

  /**
   * Permission requests the server is still waiting on.
   *
   * The server is the source of truth here, and that is what makes a restart
   * survivable: the bridge's own token map is in memory, so without re-reading
   * this the Approve buttons already sitting in the chat point at tokens that no
   * longer exist, and a blocked session can never be answered again.
   */
  listPermissions: () => request<PendingPermission[]>('/permission'),

  /**
   * Questions the server is still blocked on.
   *
   * Exists for the same reason as listPermissions: the bridge's own map of
   * what is pending is in-memory, so a restart loses it — and a question the
   * bridge cannot see is one nothing can expire, supersede, or answer, which
   * blocks the session permanently.
   */
  listQuestions: () => request<PendingQuestionRequest[]>('/question'),

  showToast: (message: string, variant: 'info' | 'success' | 'warning' | 'error' = 'info') =>
    post<boolean>('/tui/show-toast', { message, variant }),

  abort: (sessionID: string) => post<boolean>(`/session/${sessionID}/abort`),

  /**
   * Every model the bridge may switch a session to.
   *
   * Two sources, merged and deduped by `providerID/id`:
   *
   * 1. `/api/model` — what the TUI's model switcher offers. Wrapped in
   *    `{ location, data }` on current builds, a bare array on older ones —
   *    accept both.
   * 2. `/provider` — config-defined models (openai, anthropic, deepseek)
   *    load here but NOT into `/api/model`, so they would otherwise be
   *    unreachable from `/model` despite being perfectly switchable.
   *    Only providers the server reports as `connected` are merged, so the
   *    ibraries-of-nothing from the models.dev catalogue don't leak in.
   */
  async listModels(): Promise<ModelInfo[]> {
    const [modelRes, providerRes] = await Promise.all([
      request<{ data?: ModelInfo[] } | ModelInfo[]>('/api/model'),
      request<{ all?: Array<{ id?: string; models?: Record<string, ModelInfo> }>; connected?: string[] }>(
        '/provider',
      ),
    ]);
    const fromApi = Array.isArray(modelRes) ? modelRes : modelRes?.data ?? [];
    const connected = new Set(providerRes?.connected ?? []);
    const seen = new Set<string>();
    const out: ModelInfo[] = [];
    for (const m of fromApi) {
      if (!m || typeof m.id !== 'string' || typeof m.providerID !== 'string') continue;
      const key = `${m.providerID}/${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
    for (const provider of providerRes?.all ?? []) {
      if (!provider?.id || !connected.has(provider.id)) continue;
      for (const m of Object.values(provider.models ?? {})) {
        if (!m || typeof m.id !== 'string' || typeof m.providerID !== 'string') continue;
        const key = `${m.providerID}/${m.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(m);
      }
    }
    return out;
  },

  /**
   * Switch the model of a session. ModelRef requires exactly { providerID, id }.
   *
   * Accepts ANY pair and returns 204 — a nonexistent provider, a misspelled id
   * and a wrong-case id are all "successful" here. The real check happens when
   * the session next runs, surfacing a turn later as `session.error: Model not
   * found`. So a caller must resolve the ref itself; this returning cleanly
   * means nothing at all.
   */
  switchModel: (sessionID: string, providerID: string, modelID: string) =>
    post(`/api/session/${sessionID}/model`, { model: { providerID, id: modelID } }),

  createSession: () => post<SessionInfo>('/session'),

  deleteSession: (sessionID: string) =>
    request(`/session/${sessionID}`, { method: 'DELETE' }),

  /**
   * Send a prompt and block until the assistant reply completes, returning the
   * reply's text parts joined. Used for bridge-internal classification, where
   * listening on the event stream would be overkill.
   */
  async promptAndWait(sessionID: string, text: string, timeoutMs = 45_000): Promise<string> {
    const res = await request<any>(`/session/${sessionID}/message`, {
      method: 'POST',
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const messages = Array.isArray(res) ? res : [res];
    return messages
      .flatMap(m => m?.parts ?? [])
      .filter(p => p?.type === 'text' && typeof p.text === 'string')
      .map(p => p.text)
      .join('\n');
  },

  /**
   * v1 and v2 permissions share this endpoint, but older servers scope it under
   * the session. Try the flat route first and fall back.
   */
  async replyPermission(requestID: string, sessionID: string, reply: 'once' | 'always' | 'reject') {
    try {
      return await post(`/permission/${requestID}/reply`, { reply });
    } catch (err) {
      // Do NOT fall back when the request is simply gone. The old bare `catch`
      // retried on any failure, so an already-resolved permission produced a
      // second 404 from a different route and surfaced as "Handler failed" —
      // hiding the fact that the user's answer was never needed at all.
      if (err instanceof OpencodeHttpError && err.isPermissionGone) throw err;

      log.warn('permission', `primary reply route failed, trying legacy: ${(err as Error).message}`);
      // Both differences below are verified against /doc: the segment is
      // `permissions` (plural) and the body key is `response`, not `reply`.
      return await post(`/session/${sessionID}/permissions/${requestID}`, { response: reply });
    }
  },

  /** answers[i] is the array of selected labels for questions[i]. */
  replyQuestion: (requestID: string, answers: string[][]) =>
    post(`/question/${requestID}/reply`, { answers }),

  rejectQuestion: (requestID: string) => post(`/question/${requestID}/reject`),

  /**
   * Server-sent events for every session on the server. Reconnects with backoff —
   * a dropped stream is normal (laptop sleep, server restart) and must not be fatal.
   */
  async *events(signal: AbortSignal): AsyncGenerator<OpencodeEvent> {
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        const res = await fetch(`${config.opencodeUrl}/event`, {
          headers: { accept: 'text/event-stream', ...authHeaders() },
          signal,
        });
        if (!res.ok || !res.body) throw new Error(`event stream -> ${res.status}`);

        backoff = 1000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line.
          let split: number;
          while ((split = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const data = frame
              .split('\n')
              .filter(l => l.startsWith('data:'))
              .map(l => l.slice(5).trim())
              .join('');
            if (!data) continue;
            try {
              yield JSON.parse(data) as OpencodeEvent;
            } catch {
              // A partial or non-JSON frame is not worth killing the stream over.
            }
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        console.error('[opencode] event stream dropped:', (err as Error).message);
      }

      if (signal.aborted) return;
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  },
};

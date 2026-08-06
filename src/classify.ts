import type { ReactionTypeEmoji } from 'grammy/types';
import { internalSessions, opencode } from './opencode';

export type TaskKind = 'question' | 'easy' | 'medium' | 'hard';

/**
 * Telegram reactions are a fixed whitelist — the obvious picks for "question"
 * (🔎) and "easy" (⚡) are either unavailable or already mean "!cmd" here.
 */
export const KIND_EMOJI: Record<TaskKind, ReactionTypeEmoji['emoji']> = {
  question: '👀',
  easy: '👌',
  medium: '🤔',
  hard: '🔥',
};

/** Used when the server is unreachable, too slow, or answers garbage. */
export const FALLBACK_EMOJI: ReactionTypeEmoji['emoji'] = '👍';

const PROMPT = `You are classifying requests sent to a coding agent. Reply with exactly one word — the category, nothing else:

QUESTION — the user is asking something (explanation, status, opinion), not requesting a change
EASY — trivial action: single command, one-line edit, simple lookup
MEDIUM — a focused task: small feature, bug fix, touching a few files
HARD — a complex task: architecture, multi-step work, deep investigation

Request: """
`;

/** Map a model reply to a category; null when the reply is unusable. */
export function parseKind(reply: string): TaskKind | null {
  const m = reply.toUpperCase().match(/QUESTION|EASY|MEDIUM|HARD/);
  return m ? (m[0].toLowerCase() as TaskKind) : null;
}

/**
 * Ask the server's own model to classify the request, in a throwaway session
 * flagged internal so the relay never mirrors it. The session is deleted
 * afterwards — a persistent one would grow context and pollute /sessions.
 */
async function classify(text: string): Promise<TaskKind | null> {
  const session = await opencode.createSession();
  internalSessions.add(session.id);
  try {
    const reply = await opencode.promptAndWait(session.id, PROMPT + text.slice(0, 1000) + '\n"""');
    return parseKind(reply);
  } finally {
    try { await opencode.deleteSession(session.id); } catch { /* orphan is harmless */ }
    internalSessions.delete(session.id);
  }
}

/** Reaction for a user prompt — never throws, falls back to 👍. */
export async function classifyReaction(text: string): Promise<ReactionTypeEmoji['emoji']> {
  try {
    const kind = await classify(text);
    const emoji = kind ? KIND_EMOJI[kind] : FALLBACK_EMOJI;
    console.log(`[classify] ${kind ?? 'unparseable'} -> ${emoji}`);
    return emoji;
  } catch (err) {
    console.warn('[classify] failed, using fallback:', (err as Error).message);
    return FALLBACK_EMOJI;
  }
}

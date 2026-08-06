import { describe, expect, test } from 'bun:test';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_ALLOWED_CHAT_IDS = '111';

const { parseKind, KIND_EMOJI, FALLBACK_EMOJI } = await import('../src/classify');

describe('parseKind', () => {
  test('exact one-word replies', () => {
    expect(parseKind('QUESTION')).toBe('question');
    expect(parseKind('EASY')).toBe('easy');
    expect(parseKind('MEDIUM')).toBe('medium');
    expect(parseKind('HARD')).toBe('hard');
  });

  test('tolerates case, punctuation, and surrounding prose', () => {
    expect(parseKind('question')).toBe('question');
    expect(parseKind('Hard.')).toBe('hard');
    expect(parseKind('The category is EASY')).toBe('easy');
  });

  test('rejects empty and unrelated replies', () => {
    expect(parseKind('')).toBeNull();
    expect(parseKind('I cannot classify this')).toBeNull();
    expect(parseKind('MODERATE')).toBeNull();
  });
});

describe('emoji map', () => {
  // Telegram's reaction whitelist — a typo here fails silently at send time.
  const WHITELIST = ['👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿', '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡'];

  test('every kind maps to a whitelisted emoji', () => {
    for (const emoji of Object.values(KIND_EMOJI)) {
      expect(WHITELIST).toContain(emoji);
    }
    expect(WHITELIST).toContain(FALLBACK_EMOJI);
  });

  test('question gets 👀 and fallback stays 👍', () => {
    expect(KIND_EMOJI.question).toBe('👀');
    expect(FALLBACK_EMOJI).toBe('👍');
  });
});

import { describe, expect, test } from 'bun:test';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_ALLOWED_CHAT_IDS = '111';

const { resolveModel, ref } = await import('../src/model.ts');

// Shape and values taken from a live GET /api/model. `kimi-k3` deliberately
// appears under two providers — that is the real ambiguity in this catalogue.
const MODELS = [
  { id: 'deepseek-v4-flash-free', providerID: 'opencode' },
  { id: 'ling-3.0-flash-free', providerID: 'opencode' },
  { id: 'laguna-s-2.1-free', providerID: 'opencode' },
  { id: 'longcat-2.0-free', providerID: 'opencode' },
  { id: 'kimi-k3', providerID: 'moonshotai' },
  { id: 'kimi-k3', providerID: 'moonshotai-cn' },
];

describe('exact matching', () => {
  test('full provider/id ref', () => {
    const r = resolveModel('opencode/deepseek-v4-flash-free', MODELS);
    expect(r.kind).toBe('match');
    if (r.kind === 'match') {
      expect(ref(r.model)).toBe('opencode/deepseek-v4-flash-free');
      expect(r.exact).toBe(true);
    }
  });

  test('case and separators do not matter', () => {
    for (const typed of [
      'OpenCode/DeepSeek-V4-Flash-Free',
      'opencode/deepseek_v4_flash_free',
      'OPENCODE/deepseekv4flashfree',
    ]) {
      const r = resolveModel(typed, MODELS);
      expect(r.kind).toBe('match');
      if (r.kind === 'match') expect(ref(r.model)).toBe('opencode/deepseek-v4-flash-free');
    }
  });

  test('a BARE id resolves — this is the shape the server suggests', () => {
    // "Model not found: deepseek/v4 pro. Did you mean: deepseek-v4-pro?"
    // The suggestion carries no provider, and the old guard rejected it outright,
    // so the only message that could unstick the session was refused.
    const r = resolveModel('deepseek-v4-flash-free', MODELS);
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.model.providerID).toBe('opencode');
  });
});

describe('ambiguity is never guessed', () => {
  test('an id under two providers returns both', () => {
    const r = resolveModel('kimi-k3', MODELS);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      expect(r.candidates.map(ref).sort()).toEqual(['moonshotai-cn/kimi-k3', 'moonshotai/kimi-k3']);
    }
  });

  test('naming the provider disambiguates', () => {
    const r = resolveModel('moonshotai/kimi-k3', MODELS);
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.model.providerID).toBe('moonshotai');
  });

  test('a partial matching several is ambiguous, not a coin flip', () => {
    const r = resolveModel('free', MODELS);
    expect(r.kind).toBe('ambiguous');
  });
});

describe('the real failure from the transcript', () => {
  test('"deepseek/v4 pro" does not silently succeed', () => {
    const r = resolveModel('deepseek/v4 pro', MODELS);
    // There is no `deepseek` provider and no `v4 pro` model. The old code split
    // on the slash, POSTed it, got 204 and reported success — then every later
    // prompt failed with "Model not found".
    expect(r.kind).not.toBe('match');
  });

  test('an unknown model under a KNOWN provider is switched with a warning', () => {
    // The server suggests models absent from /api/model, so a hard block here
    // would reject opencode's own advice.
    const r = resolveModel('opencode/some-unlisted-model', MODELS);
    expect(r.kind).toBe('unverified');
    if (r.kind === 'unverified') {
      expect(r.providerID).toBe('opencode');
      expect(r.id).toBe('some-unlisted-model');
    }
  });

  test('an unknown PROVIDER is refused — it cannot work and would brick the session', () => {
    // `deepseek` is not a provider here; the old code sent it anyway, got 204,
    // reported success, and every later prompt failed with "Model not found".
    const r = resolveModel('deepseek/v4 pro', MODELS);
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') {
      expect(r.near.map(ref)).toContain('opencode/deepseek-v4-flash-free');
    }
  });

  test('a bare nonsense id changes nothing and offers near matches', () => {
    const r = resolveModel('deepseek-v4-pro', MODELS);
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') {
      expect(r.near.map(ref)).toContain('opencode/deepseek-v4-flash-free');
    }
  });

  test('gibberish suggests nothing rather than a bad guess', () => {
    const r = resolveModel('zzzzzzzzzz', MODELS);
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') expect(r.near).toHaveLength(0);
  });
});

describe('degraded catalogue', () => {
  test('an empty list still lets a well-formed ref through', () => {
    // /api/model failing must not make /model unusable.
    const r = resolveModel('opencode/kimi-k3', []);
    expect(r.kind).toBe('unverified');
  });

  test('an empty list rejects a bare id, since nothing can complete it', () => {
    expect(resolveModel('kimi-k3', []).kind).toBe('unknown');
  });
});

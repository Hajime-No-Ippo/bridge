import { describe, expect, test } from 'bun:test';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_ALLOWED_CHAT_IDS = '111';

const { checkAgainstModel, explainAttachmentRejection, modalityOf, parseDeny } =
  await import('../src/vision.ts');

const NONE = new Set<string>();

/** The real shape, copied from GET /provider for deepseek-v4-pro. */
const DEEPSEEK_V4_PRO = {
  id: 'deepseek-v4-pro',
  providerID: 'deepseek',
  capabilities: {
    attachment: true,
    input: { text: true, audio: false, image: true, video: true, pdf: false },
  },
};

/** Declares nothing at all — the /api/model case. */
const BARE = { id: 'mystery', providerID: 'somewhere' };

describe('modalityOf', () => {
  test('reads the mime when there is one', () => {
    expect(modalityOf('image/jpeg')).toBe('image');
    expect(modalityOf('application/pdf')).toBe('pdf');
  });

  test('falls back to the filename, because Telegram often omits the mime', () => {
    expect(modalityOf(undefined, 'brochure.pdf')).toBe('pdf');
    expect(modalityOf(undefined, 'shot.PNG')).toBe('image');
  });

  test('text-ish files are not gated at all', () => {
    // These get inlined as text; no vision capability is involved, so blocking
    // them would refuse files that work fine.
    expect(modalityOf('text/markdown', 'notes.md')).toBeNull();
    expect(modalityOf('application/json', 'a.json')).toBeNull();
  });
});

describe('a declared false blocks', () => {
  test('the exact incident: a PDF against deepseek-v4-pro', () => {
    // input.pdf is false and the session had two PDFs. Knowable in advance;
    // nothing checked, and the session died permanently.
    const v = checkAgainstModel(DEEPSEEK_V4_PRO, 'deepseek/deepseek-v4-pro', 'pdf', NONE);
    expect(v.allow).toBe(false);
    expect(v.message).toContain('input.pdf: false');
    // The refusal has to explain the permanence, or it reads as a nag.
    expect(v.message).toContain('every');
  });

  test('names what the model does accept, so the reply is actionable', () => {
    const v = checkAgainstModel(DEEPSEEK_V4_PRO, 'deepseek/deepseek-v4-pro', 'pdf', NONE);
    expect(v.message).toContain('image');
  });

  test('attachment:false blocks every modality', () => {
    const bigPickle = {
      id: 'big-pickle', providerID: 'opencode',
      capabilities: { attachment: false, input: { text: true, image: false, pdf: false } },
    };
    expect(checkAgainstModel(bigPickle, 'opencode/big-pickle', 'image', NONE).allow).toBe(false);
  });
});

describe('a declared true is a hint, not a promise', () => {
  test('image passes on deepseek-v4-pro, which advertises it', () => {
    expect(checkAgainstModel(DEEPSEEK_V4_PRO, 'deepseek/deepseek-v4-pro', 'image', NONE).allow).toBe(true);
  });

  test('ATTACHMENT_DENY overrides an advertisement that turns out to be wrong', () => {
    // The catalogue cannot be corrected from here, so this is the only way to
    // protect a session from a model that claims a modality and then rejects it.
    const deny = parseDeny('deepseek/deepseek-v4-pro:image');
    const v = checkAgainstModel(DEEPSEEK_V4_PRO, 'deepseek/deepseek-v4-pro', 'image', deny);
    expect(v.allow).toBe(false);
    expect(v.message).toContain('ATTACHMENT_DENY');
  });

  test('deny entries are case- and whitespace-insensitive', () => {
    const deny = parseDeny('  DeepSeek/DeepSeek-V4-Pro:pdf , ');
    expect(checkAgainstModel(DEEPSEEK_V4_PRO, 'deepseek/deepseek-v4-pro', 'pdf', deny).allow).toBe(false);
  });
});

describe('absent metadata never blocks', () => {
  test('a model with no capabilities is allowed through', () => {
    // /api/model entries carry none. Blocking on silence would reject most of
    // the catalogue and break the bridge for everyone on those models.
    expect(checkAgainstModel(BARE, 'somewhere/mystery', 'pdf', NONE).allow).toBe(true);
  });

  test('an unknown model is allowed through', () => {
    expect(checkAgainstModel(undefined, 'who/knows', 'image', NONE).allow).toBe(true);
  });

  test('a declared modality that is simply missing is allowed', () => {
    const partial = { id: 'x', providerID: 'y', capabilities: { input: { text: true } } };
    expect(checkAgainstModel(partial, 'y/x', 'image', NONE).allow).toBe(true);
  });
});

describe('explainAttachmentRejection', () => {
  test('recognises the real error text from the incident', () => {
    const raw =
      'Failed to deserialize the JSON body into the target type: ' +
      'messages[136]: unknown variant image_url, expected one of ...';
    const hint = explainAttachmentRejection(raw);
    expect(hint).toBeDefined();
    // The point is telling the user retrying is pointless.
    expect(hint).toContain('retrying');
    expect(hint).toContain('/model');
  });

  test('stays quiet for unrelated errors', () => {
    expect(explainAttachmentRejection('connection refused')).toBeUndefined();
    expect(explainAttachmentRejection('Model not found')).toBeUndefined();
    expect(explainAttachmentRejection('rate limit exceeded')).toBeUndefined();
  });
});

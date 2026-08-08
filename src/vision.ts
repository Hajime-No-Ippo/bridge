/**
 * Refusing an attachment the current model cannot take.
 *
 * The failure this prevents is permanent, which is what makes it worth a guard.
 * An attachment is inlined into the session as a base64 `data:` URL and stays in
 * the history forever. Every later prompt re-sends the whole history, so once
 * one incompatible file is in, EVERY subsequent turn in that session dies the
 * same way — and the symptom names nothing useful:
 *
 *   Failed to deserialize the JSON body into the target type:
 *   messages[136]: unknown variant image_url
 *
 * Observed with deepseek/deepseek-v4-pro and a PDF. The catalogue said
 * `input.pdf: false`, so it was knowable in advance; nothing checked.
 *
 * HOW MUCH THE CATALOGUE IS TRUSTED, and this is the whole design:
 *
 *   declared false  -> BLOCK. A model that says it cannot take a modality is
 *                      reliable about that; deepseek-v4-pro means it.
 *   declared true   -> ALLOW, but this is not a promise. The same model
 *                      advertises `input.image: true` alongside `attachment:
 *                      true`, and that is exactly the kind of claim that has
 *                      already proven softer than it looks. ATTACHMENT_DENY
 *                      exists so a combination that lies can be overridden
 *                      without a code change.
 *   absent          -> ALLOW. Models sourced from /api/model carry no
 *                      capabilities at all, and blocking on missing metadata
 *                      would reject most of the catalogue.
 *
 * So: a `false` is load-bearing, a `true` is a hint, and silence means silence.
 */

import { log } from './log';
import { opencode, type ModelInfo } from './opencode';

export type Modality = 'image' | 'pdf' | 'audio' | 'video';

const BY_MIME: Array<[RegExp, Modality]> = [
  [/^image\//, 'image'],
  [/^application\/pdf$/, 'pdf'],
  [/^audio\//, 'audio'],
  [/^video\//, 'video'],
];

const BY_EXT: Record<string, Modality> = {
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', heic: 'image',
  pdf: 'pdf',
  mp3: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', m4a: 'audio',
  mp4: 'video', mov: 'video', webm: 'video',
};

/**
 * Which modality gate an attachment falls under, or null for none.
 *
 * Null is the normal answer for text-ish files (.md, .json, .csv): they are
 * inlined as text and no vision capability is involved, so they are never
 * blocked. Telegram omits `mime_type` often enough that the filename is a
 * necessary second source.
 */
export function modalityOf(mime?: string, filename?: string): Modality | null {
  const m = (mime ?? '').toLowerCase();
  const hit = BY_MIME.find(([re]) => re.test(m));
  if (hit) return hit[1];
  const ext = (filename ?? '').toLowerCase().split('.').pop() ?? '';
  return BY_EXT[ext] ?? null;
}

export interface AttachmentCheck {
  /** false means: do not submit this, and tell the user why. */
  allow: boolean;
  /** User-facing explanation. Only set when there is something worth saying. */
  message?: string;
}

const ALLOW: AttachmentCheck = { allow: true };

export const modelRef = (providerID: string, id: string) => `${providerID}/${id}`;

/**
 * Parse ATTACHMENT_DENY into a lookup set.
 *
 * Entries are `provider/model:modality`, e.g. `deepseek/deepseek-v4-pro:image`.
 * This is the escape hatch for a model whose advertised `true` turns out to be
 * wrong — the catalogue cannot be fixed from here, but a session can still be
 * protected without shipping a patch.
 */
export function parseDeny(raw: string): Set<string> {
  return new Set(
    raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  );
}

/** The decision itself, with everything already resolved — pure, so it is testable. */
export function checkAgainstModel(
  model: ModelInfo | undefined,
  ref: string,
  modality: Modality | null,
  deny: Set<string>,
): AttachmentCheck {
  if (!modality) return ALLOW;

  if (deny.has(`${ref.toLowerCase()}:${modality}`)) {
    return {
      allow: false,
      message:
        `🚫 <b>${modality} attachments are blocked for this model</b>\n` +
        `<code>${ref}</code> is listed in ATTACHMENT_DENY.\n\n` +
        'Switch with /model, or send it as text.',
    };
  }

  const caps = model?.capabilities;
  if (!caps) return ALLOW;   // nothing claimed; nothing to act on

  const declared = caps.input?.[modality];
  const refuses = declared === false || (caps.attachment === false && declared !== true);
  if (!refuses) return ALLOW;

  // Name the other modalities it DOES take, so the reply is actionable rather
  // than just a refusal — a PDF often has a screenshot alternative.
  const accepted = (['image', 'pdf', 'audio', 'video'] as Modality[])
    .filter(k => caps.input?.[k] === true);

  return {
    allow: false,
    message:
      `🚫 <b>This model cannot read ${modality} files</b>\n` +
      `<code>${ref}</code> declares <code>input.${modality}: false</code>.\n\n` +
      'Sending it anyway would put it in the session history permanently, and every ' +
      'later prompt re-sends that history — so the whole session would fail from here on, ' +
      'not just this message.\n\n' +
      (accepted.length ? `It does accept: ${accepted.join(', ')}.\n` : '') +
      'Switch with /model to something that reads it, then resend.',
  };
}

/**
 * Resolve the current session's model and check the attachment against it.
 *
 * Fails OPEN. The catalogue lives on the same server the prompt is about to go
 * to, so if it cannot be reached the submit is going to fail regardless — and
 * refusing the user's photo would then be blaming the wrong thing.
 */
export async function checkAttachment(
  mime: string | undefined,
  filename: string | undefined,
  deny: Set<string>,
): Promise<AttachmentCheck> {
  const modality = modalityOf(mime, filename);
  if (!modality) return ALLOW;

  try {
    const session = await opencode.pinnedSession();
    const sm = session?.model;
    if (!sm?.providerID || !sm?.id) return ALLOW;

    const ref = modelRef(sm.providerID, sm.id);
    const models = await opencode.listModels();
    const model = models.find(m => m.providerID === sm.providerID && m.id === sm.id);
    const verdict = checkAgainstModel(model, ref, modality, deny);
    if (!verdict.allow) log.info('vision', `refused ${modality} for ${ref}`);
    return verdict;
  } catch (err) {
    log.warn('vision', `capability check skipped: ${(err as Error).message}`);
    return ALLOW;
  }
}

/**
 * Translate a provider rejection that is really this problem.
 *
 * Returns undefined for anything else. The raw text names a message index and a
 * serde variant and gives the user no way to connect either to the photo they
 * sent an hour ago, so the relay prints this underneath it.
 */
export function explainAttachmentRejection(msg: string): string | undefined {
  const looksLikeIt =
    /unknown variant/i.test(msg) && /image_url|image|content/i.test(msg);
  if (!looksLikeIt) return undefined;
  return (
    'This is an attachment the current model cannot accept — not a transient error.\n' +
    'It is already in this session\'s history, and every prompt re-sends the whole ' +
    'history, so retrying fails identically.\n' +
    'Fix: /model to one that reads it, or start a new session.'
  );
}

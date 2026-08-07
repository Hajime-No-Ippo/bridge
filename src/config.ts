function env(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

const botToken = env('TELEGRAM_BOT_TOKEN');
const allowed = env('TELEGRAM_ALLOWED_CHAT_IDS')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);

const discordToken = env('DISCORD_BOT_TOKEN');

if (!botToken) {
  throw new Error('TELEGRAM_BOT_TOKEN is not set — copy .env.example to .env first.');
}

// Fail closed. A bot wired to opencode can run anything on this machine, so an
// empty allowlist is never the safe default.
if (allowed.length === 0) {
  throw new Error(
    'TELEGRAM_ALLOWED_CHAT_IDS is empty. Start the bot with a placeholder ID, send /whoami, ' +
    'then put the ID it reports into .env.',
  );
}
if (allowed.some(Number.isNaN)) {
  throw new Error('TELEGRAM_ALLOWED_CHAT_IDS contains a non-numeric entry.');
}

const username = env('OPENCODE_SERVER_USERNAME');
const password = env('OPENCODE_SERVER_PASSWORD');

export const config = {
  botToken,
  allowedChatIds: new Set(allowed),
  opencodeUrl: env('OPENCODE_URL', 'http://127.0.0.1:4096').replace(/\/$/, ''),
  auth: password ? { username: username || 'opencode', password } : undefined,
  editIntervalMs: Number(env('EDIT_INTERVAL_MS', '1200')),
  // Telegram caps bot uploads at 50MB; stay under it so a huge capture fails
  // with our message rather than an opaque 413 from the API.
  maxImageBytes: Number(env('MAX_IMAGE_BYTES', String(45 * 1024 * 1024))),
  // Only relay images modified within this window. A directory listing
  // re-mentions every old screenshot, and the dedupe set resets on restart,
  // so without an mtime check one `ls` would re-send the whole temp dir.
  imageMaxAgeMs: Number(env('IMAGE_MAX_AGE_MS', String(5 * 60 * 1000))),
  // Startup sweep deletes temp screenshots older than this.
  tempImageTtlMs: Number(env('TEMP_IMAGE_TTL_MS', String(60 * 60 * 1000))),
  // How long a submitted prompt may produce no events at all before the bridge
  // says so. Generous: a cold model can take a while to emit its first part,
  // and a false alarm is worse than a slightly late one.
  silenceWarnMs: Number(env('SILENCE_WARN_MS', '20000')),
  // A permission or question BLOCKS the turn until it is answered, and nothing
  // on the opencode side ever expires one. Without a ceiling here, a prompt
  // nobody tapped wedges the session for as long as the bridge stays up — which
  // is indistinguishable, from the phone, from the bridge being dead.
  pendingTtlMs: Number(env('PENDING_TTL_MS', String(30 * 60 * 1000))),
  // How long a block may sit before the bridge says so again. The message
  // carrying the buttons scrolls off a phone screen within a few exchanges, so
  // the reminder is often the only way to find out the turn is still waiting.
  pendingNudgeMs: Number(env('PENDING_NUDGE_MS', String(5 * 60 * 1000))),
  // Cap on an inbound attachment. Base64 inflates the payload by ~33% and the
  // whole thing rides inside the prompt body, so this sits well under
  // Telegram's own 20MB ceiling for serving files to bots.
  maxInboundBytes: Number(env('MAX_INBOUND_BYTES', String(8 * 1024 * 1024))),
};

export type Config = typeof config;

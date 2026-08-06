import { config } from './config';
import { createBot } from './bot';
import { log, noteEvent } from './log';
import { opencode } from './opencode';
import { Relay } from './relay';
import { sweepTempImages } from './tools/screenshot';

const controller = new AbortController();

// Without these, a rejection raised off the request path — a relay flush timer,
// the event-stream generator — terminates the process with no output at all.
// That is the "dies silently" failure: the cause is never printed.
process.on('unhandledRejection', reason => {
  console.error('[fatal] unhandled rejection:', reason);
});
process.on('uncaughtException', err => {
  console.error('[fatal] uncaught exception:', err);
});

async function main() {
  // Clear out the previous run's screenshots before new ones can pile up.
  sweepTempImages(config.tempImageTtlMs);

  try {
    const health = await opencode.health();
    if (!health.healthy) throw new Error('server reports unhealthy');
  } catch (err) {
    console.error(
      `Cannot reach opencode at ${config.opencodeUrl}: ${(err as Error).message}\n` +
      'Start it with:  opencode serve --port 4096',
    );
    process.exit(1);
  }

  // Background status logger
  void (async () => {
    while (!controller.signal.aborted) {
      console.log('[STATUS]: Connection exists');
      await Bun.sleep(10_000_000); // log every 30s
    }
  })();

  const bot = createBot();
  const relay = new Relay(bot);

  // Consume the event stream independently of polling — it reconnects on its own.
  void (async () => {
    for await (const event of opencode.events(controller.signal)) {
      noteEvent(event.type);
      log.debug('event', event.type);
      try {
        await relay.handle(event);
      } catch (err) {
        log.error('relay', 'handler failed:', (err as Error).message);
      }
    }
    log.warn('event', 'stream ended — no further replies will arrive');
  })();

  const shutdown = async () => {
    controller.abort();
    await bot.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  console.log(
    `Bridge up.\n  opencode: ${config.opencodeUrl}\n` +
    `  chats:    ${[...config.allowedChatIds].join(', ')}`,
  );

  // Before polling starts, re-offer anything the server is still blocked on.
  // A permission asked while the bridge was down would otherwise be
  // unanswerable forever, since its buttons died with the previous process.
  await relay.reconcilePermissions();
  // bot.start() only resolves when polling stops, and it REJECTS on a transport
  // failure. grammy's bot.catch() does not cover this — that handles middleware
  // errors, not the getUpdates loop itself. Left unhandled it takes the process
  // down with no output, which is the classic "bridge died silently".
  try {
    await bot.start();
  } catch (err) {
    const e = err as { error_code?: number };
    if (e?.error_code === 409) {
      log.error(
        'bot',
        'Telegram 409: another process is already polling this bot token.\n' +
        '  Telegram allows exactly one getUpdates consumer per token.\n' +
        '  Find the other instance:  pgrep -fl src/index.ts\n' +
        '  Then kill it, or give this one a different TELEGRAM_BOT_TOKEN.',
      );
    } else {
      log.error('bot', 'polling stopped:', err);
    }
    process.exit(1);
  }
}


void main();

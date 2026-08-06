/**
 * Tagged, timestamped logging.
 *
 * The bridge's failure mode is silence: a turn is accepted, something drops it,
 * and nothing is printed. `debug` exists so every drop point can say so without
 * making normal runs unreadable — set BRIDGE_DEBUG=1 to see them.
 */

const stamp = () => new Date().toISOString().slice(11, 23);

const DEBUG = !!(process.env.BRIDGE_DEBUG ?? '').trim();

export const log = {
  /** Always shown. The turn-level story: prompt in, reply out. */
  info: (tag: string, ...rest: unknown[]) => console.log(`${stamp()} [${tag}]`, ...rest),
  warn: (tag: string, ...rest: unknown[]) => console.warn(`${stamp()} [${tag}]`, ...rest),
  error: (tag: string, ...rest: unknown[]) => console.error(`${stamp()} [${tag}]`, ...rest),
  /** BRIDGE_DEBUG=1 only. Per-event detail and every reason a message was dropped. */
  debug: (tag: string, ...rest: unknown[]) => {
    if (DEBUG) console.log(`${stamp()} [${tag}]`, ...rest);
  },
  enabled: DEBUG,
};

/**
 * Evidence that a prompt is actually being worked on.
 *
 * The silence watchdog reads `working`, NOT `events`. Two kinds of traffic
 * arrive whether or not anything is processing the prompt, and counting them
 * makes the watchdog permanently blind:
 *
 *   server.heartbeat      — every few seconds, forever, even when idle
 *   tui.prompt.append     — the bridge's OWN injection echoing back
 *   tui.command.execute   — ditto, emitted by submitPrompt() itself
 *
 * Only session/message/permission/question traffic means a turn is live.
 */
export const activity = { lastEventAt: 0, events: 0, working: 0 };

export function noteEvent(_type: string) {
  activity.lastEventAt = Date.now();
  activity.events += 1;
}

/** Event types that mean a turn is genuinely being worked on. */
const WORKING = /^(session|message|permission|question)\./;

/**
 * Called by the relay AFTER the internal-session filter, which is the only
 * place that distinction exists. Counting in index.ts instead looked right and
 * was wrong: `classifyReaction` runs its own opencode session per message, and
 * its several hundred `message.part.delta` events would satisfy the watchdog
 * every single time — so it could never fire, no matter how dead the turn was.
 */
export function noteWorking(type: string) {
  if (WORKING.test(type)) activity.working += 1;
}

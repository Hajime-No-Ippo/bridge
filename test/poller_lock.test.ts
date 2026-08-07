import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_ALLOWED_CHAT_IDS = '111';

const { claimPollingSlot, looksLikeBridge, pidFilePath, releasePollingSlot } =
  await import('../src/poller_lock.ts');

const PID_FILE = join(tmpdir(), `poller-lock-test-${process.pid}.pid`);
const TOKEN = '123:abc';

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
  delete process.env.BRIDGE_PID_FILE;
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
});

describe('pidFilePath', () => {
  test('is keyed by token, so two bots never evict each other', () => {
    // The bridge can be pointed at any token. Sharing one pidfile would mean
    // starting bot B kills bot A.
    expect(pidFilePath('111:aaa')).not.toBe(pidFilePath('222:bbb'));
    expect(pidFilePath('111:aaa')).toBe(pidFilePath('111:aaa'));
  });

  test('never puts the token itself in the filename', () => {
    // /tmp is world-listable; a bot token in a filename is a leaked credential.
    const secret = '8442658638:AAHsuperSecretTokenValue';
    expect(pidFilePath(secret)).not.toContain('AAHsuperSecretTokenValue');
    expect(pidFilePath(secret)).not.toContain('8442658638');
  });

  test('BRIDGE_PID_FILE overrides it', () => {
    process.env.BRIDGE_PID_FILE = '/tmp/custom.pid';
    expect(pidFilePath(TOKEN)).toBe('/tmp/custom.pid');
  });
});

describe('looksLikeBridge', () => {
  test('recognises how the bridge is actually run', () => {
    expect(looksLikeBridge('bun --watch src/index.ts')).toBe(true);
    expect(looksLikeBridge('bun run /Users/x/telegram-bridge/src/index.ts')).toBe(true);
  });

  test('does not claim unrelated processes', () => {
    expect(looksLikeBridge('sleep 30')).toBe(false);
    expect(looksLikeBridge('/usr/bin/ssh -N -L 4096:localhost:4096 host')).toBe(false);
    expect(looksLikeBridge('opencode serve --port 4096')).toBe(false);
  });
});

describe('claimPollingSlot', () => {
  test('leaves a real, unrelated process alone', async () => {
    // The failure this guards against: pids get recycled, so a stale pidfile on
    // a long-uptime machine can name anything. Signalling it would be much
    // worse than failing to reclaim the slot.
    const victim = Bun.spawn({ cmd: ['sleep', '30'], stdio: ['ignore', 'ignore', 'ignore'] });
    cleanup.push(() => { try { victim.kill(); } catch { /* already gone */ } });

    process.env.BRIDGE_PID_FILE = PID_FILE;
    writeFileSync(PID_FILE, String(victim.pid));

    await claimPollingSlot(TOKEN);

    // Still running, and the file now belongs to us.
    expect(victim.killed).toBe(false);
    let alive = true;
    try { process.kill(victim.pid, 0); } catch { alive = false; }
    expect(alive).toBe(true);
    expect(readFileSync(PID_FILE, 'utf8')).toBe(String(process.pid));
  });

  test('a dead pid is simply overwritten', async () => {
    const dead = Bun.spawn({ cmd: ['true'], stdio: ['ignore', 'ignore', 'ignore'] });
    await dead.exited;

    process.env.BRIDGE_PID_FILE = PID_FILE;
    writeFileSync(PID_FILE, String(dead.pid));

    await claimPollingSlot(TOKEN);
    expect(readFileSync(PID_FILE, 'utf8')).toBe(String(process.pid));
  });

  test('garbage in the pidfile does not throw', async () => {
    process.env.BRIDGE_PID_FILE = PID_FILE;
    writeFileSync(PID_FILE, 'not-a-pid');
    await claimPollingSlot(TOKEN);
    expect(readFileSync(PID_FILE, 'utf8')).toBe(String(process.pid));
  });

  test('pid 1 is never signalled', async () => {
    process.env.BRIDGE_PID_FILE = PID_FILE;
    writeFileSync(PID_FILE, '1');
    await claimPollingSlot(TOKEN);   // must not attempt to kill init
    expect(readFileSync(PID_FILE, 'utf8')).toBe(String(process.pid));
  });

  test('no pidfile at all is the normal first start', async () => {
    process.env.BRIDGE_PID_FILE = PID_FILE;
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    await claimPollingSlot(TOKEN);
    expect(readFileSync(PID_FILE, 'utf8')).toBe(String(process.pid));
  });
});

describe('releasePollingSlot', () => {
  test('removes the file when we own it', async () => {
    process.env.BRIDGE_PID_FILE = PID_FILE;
    await claimPollingSlot(TOKEN);
    releasePollingSlot(TOKEN);
    expect(existsSync(PID_FILE)).toBe(false);
  });

  test('leaves a file owned by someone else', () => {
    // A successor already claimed the slot; deleting its file on our way out
    // would strand it.
    process.env.BRIDGE_PID_FILE = PID_FILE;
    writeFileSync(PID_FILE, '999999');
    releasePollingSlot(TOKEN);
    expect(existsSync(PID_FILE)).toBe(true);
  });
});

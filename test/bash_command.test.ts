import { describe, expect, test } from 'bun:test';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_ALLOWED_CHAT_IDS = '111';

const { raisedDir, dirOf, DIR_OF, SYSTEM_BEHAVIOR } = await import('../src/relay.ts');

describe('which directory a bash command was raised from', () => {
  test('each label resolves to its directory', () => {
    expect(dirOf('HOME_DIR')).toBe('Users');
    expect(dirOf('PROJECT_DIR')).toBe('telegram-bridge');
    expect(dirOf('WRONG_DIR')).toBe('hackathon');
    expect(dirOf('USER_DIR')).toBe('erictao');
  });

  test('a real path resolves to its DEEPEST known directory', () => {
    // Every one of these contains "Users" and "erictao" too. The innermost is
    // the one that decides whether opencode prompts, so it is the answer.
    expect(raisedDir('/Users/erictao/hackathon/telegram-bridge')).toBe('telegram-bridge');
    expect(raisedDir('/Users/erictao/hackathon')).toBe('hackathon');
    expect(raisedDir('/Users/erictao')).toBe('erictao');
    expect(raisedDir('/Users')).toBe('Users');
  });

  test('an unknown directory is null, not a wrong guess', () => {
    expect(raisedDir('/opt/homebrew/bin')).toBeNull();
    expect(raisedDir('')).toBeNull();
  });

  test('the label table and the path scanner agree', () => {
    // dirOf is a lookup, raisedDir is a scanner. They must not drift apart.
    for (const dir of Object.values(DIR_OF)) {
      expect(raisedDir(dir)).toBe(dir);
    }
  });
});

describe('opencode behaviour per directory', () => {
  test('every directory declares at least one expected behaviour', () => {
    for (const dir of Object.values(DIR_OF)) {
      expect(SYSTEM_BEHAVIOR[dir].length).toBeGreaterThan(0);
    }
  });

  test('only the project directory is expected to stream without blocking', () => {
    // This is the hypothesis the silence bug turns on: anything that can emit
    // permission.asked can block the turn, and a dropped prompt reads as silence.
    expect(SYSTEM_BEHAVIOR['telegram-bridge']).toEqual(['streams']);

    const blocking = (Object.keys(SYSTEM_BEHAVIOR) as Array<keyof typeof SYSTEM_BEHAVIOR>)
      .filter(d => SYSTEM_BEHAVIOR[d].includes('permission.asked'));
    expect(blocking.sort()).toEqual(['Users', 'erictao', 'hackathon']);
  });
});

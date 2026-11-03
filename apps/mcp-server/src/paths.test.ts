import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { resolveMindwtrDbPath } from './paths.js';

const originalPlatform = process.platform;
const originalEnv = {
  HOME: process.env.HOME,
  APPDATA: process.env.APPDATA,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  MINDWTR_DB_PATH: process.env.MINDWTR_DB_PATH,
  MINDWTR_DB: process.env.MINDWTR_DB,
};
const tempDirs: string[] = [];

const setPlatform = (platform: string) => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
};

afterEach(() => {
  setPlatform(originalPlatform);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('mcp default database discovery', () => {
  if (process.platform !== 'linux') return;

  test('prefers the data/ subfolder on Windows over a flat root an older version left behind', () => {
    const appData = mkdtempSync(join(tmpdir(), 'mindwtr-mcp-layout-'));
    tempDirs.push(appData);
    const flatDb = join(appData, 'mindwtr', 'mindwtr.db');
    const splitDb = join(appData, 'mindwtr', 'data', 'mindwtr.db');
    mkdirSync(join(splitDb, '..'), { recursive: true });
    writeFileSync(flatDb, '');
    writeFileSync(splitDb, '');

    setPlatform('win32');
    process.env.APPDATA = appData;
    delete process.env.MINDWTR_DB_PATH;
    delete process.env.MINDWTR_DB;

    expect(resolveMindwtrDbPath()).toBe(splitDb);
  });

  test('keeps the flat root on Linux, where the app never uses a data/ subfolder', () => {
    const dataHome = mkdtempSync(join(tmpdir(), 'mindwtr-mcp-linux-layout-'));
    tempDirs.push(dataHome);
    const flatDb = join(dataHome, 'mindwtr', 'mindwtr.db');
    const splitDb = join(dataHome, 'mindwtr', 'data', 'mindwtr.db');
    mkdirSync(join(splitDb, '..'), { recursive: true });
    writeFileSync(flatDb, '');
    writeFileSync(splitDb, '');

    process.env.XDG_DATA_HOME = dataHome;
    delete process.env.MINDWTR_DB_PATH;
    delete process.env.MINDWTR_DB;

    expect(resolveMindwtrDbPath()).toBe(flatDb);
  });

  test('expands a leading ~ in an explicit database path', () => {
    process.env.HOME = '/home/tester';
    delete process.env.MINDWTR_DB_PATH;
    delete process.env.MINDWTR_DB;


    expect(resolveMindwtrDbPath('~/.local/share/mindwtr/mindwtr.db'))
      .toBe('/home/tester/.local/share/mindwtr/mindwtr.db');
    expect(resolveMindwtrDbPath('~\\mindwtr.db')).toBe('/home/tester/mindwtr.db');
    expect(resolveMindwtrDbPath('/tmp/~tilde/mindwtr.db')).toBe('/tmp/~tilde/mindwtr.db');
  });

  test('discovers the Flatpak database when XDG locations are empty', () => {
    const home = mkdtempSync(join(tmpdir(), 'mindwtr-mcp-flatpak-'));
    tempDirs.push(home);
    const dbPath = join(
      home,
      '.var',
      'app',
      'tech.dongdongbh.mindwtr',
      'data',
      'mindwtr',
      'mindwtr.db'
    );
    mkdirSync(join(dbPath, '..'), { recursive: true });
    writeFileSync(dbPath, '');

    process.env.HOME = home;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.MINDWTR_DB_PATH;
    delete process.env.MINDWTR_DB;

    expect(resolveMindwtrDbPath()).toBe(dbPath);
  });

  test('discovers the Snap database through the current revision link', () => {
    const home = mkdtempSync(join(tmpdir(), 'mindwtr-mcp-snap-'));
    tempDirs.push(home);

    const dbPath = join(home, 'snap', 'mindwtr', 'current', '.local', 'share', 'mindwtr', 'mindwtr.db');
    mkdirSync(join(dbPath, '..'), { recursive: true });
    writeFileSync(dbPath, '');

    process.env.HOME = home;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.MINDWTR_DB_PATH;
    delete process.env.MINDWTR_DB;

    expect(resolveMindwtrDbPath()).toBe(dbPath);
  });
});

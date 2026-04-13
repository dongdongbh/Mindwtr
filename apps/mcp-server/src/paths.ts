import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';

const APP_ID = 'tech.dongdongbh.mindwtr';
const APP_DIR = 'mindwtr';
const DB_FILE_NAME = 'mindwtr.db';
const DATA_FILE_NAME = 'data.json';

function getLinuxConfigHome() {
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

function getLinuxDataHome() {
  return process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
}

function getWindowsAppDataHome() {
  return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
}

function getMacAppSupportHome() {
  return join(homedir(), 'Library', 'Application Support');
}

function getMacSandboxAppSupportHome() {
  return join(homedir(), 'Library', 'Containers', APP_ID, 'Data', 'Library', 'Application Support');
}

function getConfigHome(): string {
  const platform = process.platform;
  if (platform === 'win32') return getWindowsAppDataHome();
  if (platform === 'darwin') return getMacAppSupportHome();
  return getLinuxConfigHome();
}

function getDataHome(): string {
  const platform = process.platform;
  if (platform === 'win32') return getWindowsAppDataHome();
  if (platform === 'darwin') return getMacAppSupportHome();
  return getLinuxDataHome();
}

function firstExisting(paths: string[]): string | null {
  for (const candidate of paths) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function getExplicitDbPath(overridePath?: string): string | null {
  const explicit = overridePath || process.env.MINDWTR_DB_PATH || process.env.MINDWTR_DB;
  return explicit ? resolve(explicit) : null;
}

function dedupe(paths: Array<string | null | undefined>): string[] {
  return Array.from(new Set(paths.filter((value): value is string => typeof value === 'string' && value.length > 0)));
}

function getDefaultStorageDirs(): string[] {
  const configHome = getConfigHome();
  const dataHome = getDataHome();
  const dirs = [
    join(dataHome, APP_DIR),
    join(configHome, APP_DIR),
    join(dataHome, APP_ID),
    join(configHome, APP_ID),
  ];

  if (process.platform === 'darwin') {
    const sandboxHome = getMacSandboxAppSupportHome();
    dirs.push(join(sandboxHome, APP_DIR));
    dirs.push(join(sandboxHome, APP_ID));
  }

  return dedupe(dirs);
}

export function resolveMindwtrDataJsonPath(overridePath?: string): string {
  const explicitDbPath = getExplicitDbPath(overridePath);
  const explicitDataPath = explicitDbPath ? join(dirname(explicitDbPath), DATA_FILE_NAME) : null;
  const candidates = dedupe([
    explicitDataPath,
    ...getDefaultStorageDirs().map((dir) => join(dir, DATA_FILE_NAME)),
  ]);

  return firstExisting(candidates) || explicitDataPath || candidates[0];
}

export function resolveMindwtrDbPath(overridePath?: string): string {
  const explicitDbPath = getExplicitDbPath(overridePath);
  if (explicitDbPath) return explicitDbPath;
  const candidates = getDefaultStorageDirs().map((dir) => join(dir, DB_FILE_NAME));

  return firstExisting(candidates) || candidates[0];
}

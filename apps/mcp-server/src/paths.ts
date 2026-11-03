import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';

const APP_ID = 'tech.dongdongbh.mindwtr';
const APP_DIR = 'mindwtr';
const DB_FILE_NAME = 'mindwtr.db';
const DATA_FILE_NAME = 'data.json';

function getHomeDir() {
  return process.env.HOME || homedir();
}

function getLinuxConfigHome() {
  return process.env.XDG_CONFIG_HOME || join(getHomeDir(), '.config');
}

function getLinuxDataHome() {
  return process.env.XDG_DATA_HOME || join(getHomeDir(), '.local', 'share');
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


function expandHome(value: string): string {
  if (value === '~') return getHomeDir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(getHomeDir(), value.slice(2));
  return value;
}

function getExplicitDbPath(overridePath?: string): string | null {
  const explicit = overridePath || process.env.MINDWTR_DB_PATH || process.env.MINDWTR_DB;
  return explicit ? resolve(expandHome(explicit)) : null;
}

function dedupe(paths: Array<string | null | undefined>): string[] {
  return Array.from(new Set(paths.filter((value): value is string => typeof value === 'string' && value.length > 0)));
}


export function getDesktopProfileDirs(): string[] {
  const configHome = getConfigHome();
  const dataHome = getDataHome();
  const dirs = [


    ...(process.platform === 'win32' || process.platform === 'darwin'
      ? [join(dataHome, APP_DIR, 'data')]
      : []),
    join(dataHome, APP_DIR),
    join(configHome, APP_DIR),
    join(dataHome, APP_ID),
    join(configHome, APP_ID),
  ];

  if (process.platform === 'linux') {
    const flatpakHome = join(getHomeDir(), '.var', 'app', APP_ID);
    dirs.push(join(flatpakHome, 'data', APP_DIR));
    dirs.push(join(flatpakHome, 'config', APP_DIR));

    dirs.push(join(getHomeDir(), 'snap', 'mindwtr', 'current', '.local', 'share', APP_DIR));
  }

  if (process.platform === 'darwin') {
    const sandboxHome = getMacSandboxAppSupportHome();
    dirs.push(join(sandboxHome, APP_DIR, 'data'));
    dirs.push(join(sandboxHome, APP_DIR));
    dirs.push(join(sandboxHome, APP_ID));
  }

  return dedupe(dirs);
}

export function resolveMindwtrDataJsonPath(overridePath?: string): string {
  const explicitDbPath = getExplicitDbPath(overridePath);
  if (explicitDbPath) {
    return join(dirname(explicitDbPath), DATA_FILE_NAME);
  }
  const candidates = dedupe([
    ...getDesktopProfileDirs().map((dir) => join(dir, DATA_FILE_NAME)),
  ]);

  return firstExisting(candidates) || candidates[0];
}

export function resolveMindwtrDbPath(overridePath?: string): string {
  const explicitDbPath = getExplicitDbPath(overridePath);
  if (explicitDbPath) return explicitDbPath;
  const candidates = getDesktopProfileDirs().map((dir) => join(dir, DB_FILE_NAME));

  return firstExisting(candidates) || candidates[0];
}

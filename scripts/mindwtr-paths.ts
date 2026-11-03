import { existsSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';


import { getDesktopProfileDirs } from '../apps/mcp-server/src/paths';

const DATA_FILE_NAME = 'data.json';
const DB_FILE_NAME = 'mindwtr.db';

function firstExisting(paths: string[]): string | null {
    for (const path of paths) {
        if (existsSync(path)) return path;
    }
    return null;
}


function withSiblingLayoutFallback(path: string): string {
    if (existsSync(path)) return path;
    const dir = dirname(path);
    const file = basename(path);
    const sibling = basename(dir) === 'data' ? join(dirname(dir), file) : join(dir, 'data', file);
    if (!existsSync(sibling) || !existsSync(join(dirname(sibling), DB_FILE_NAME))) return path;

    console.error(`[mindwtr] Using ${sibling} (nothing at the configured path: ${path})`);
    return sibling;
}

export function resolveMindwtrDataPath(overridePath?: string): string {
    const explicit = overridePath || process.env.MINDWTR_DATA;
    if (explicit) return withSiblingLayoutFallback(resolve(explicit));

    const candidates = getDesktopProfileDirs().map((root) => join(root, DATA_FILE_NAME));
    return firstExisting(candidates) || candidates[0];
}

export function resolveMindwtrDbPath(overridePath?: string, dataPath?: string): string {
    const explicit = overridePath || process.env.MINDWTR_DB_PATH || process.env.MINDWTR_DB;
    if (explicit) return withSiblingLayoutFallback(resolve(explicit));
    if (dataPath) return join(dirname(resolve(dataPath)), DB_FILE_NAME);

    const candidates = getDesktopProfileDirs().map((root) => join(root, DB_FILE_NAME));
    return firstExisting(candidates) || candidates[0];
}

export function resolveMindwtrStoragePaths(options?: { dataPath?: string; dbPath?: string }) {
    const dataPath = resolveMindwtrDataPath(options?.dataPath);
    const dbPath = resolveMindwtrDbPath(options?.dbPath, dataPath);
    return { dataPath, dbPath };
}

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { resolveMindwtrDataPath, resolveMindwtrDbPath } from './mindwtr-paths';

const originalPlatform = process.platform;
const originalEnv = {


    HOME: process.env.HOME,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    MINDWTR_DATA: process.env.MINDWTR_DATA,
    MINDWTR_DB_PATH: process.env.MINDWTR_DB_PATH,
    MINDWTR_DB: process.env.MINDWTR_DB,
};
const tempDirs: string[] = [];

const setPlatform = (platform: string) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
};

const makeTempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'mindwtr-paths-'));
    tempDirs.push(dir);
    return dir;
};

const touch = (path: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '');
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

const clearOverrides = () => {
    delete process.env.MINDWTR_DATA;
    delete process.env.MINDWTR_DB_PATH;
    delete process.env.MINDWTR_DB;
};

describe('automation script database discovery', () => {
    test('prefers the data/ subfolder on Windows over a flat root an older version left behind', () => {
        process.env.HOME = makeTempDir();
        const appData = makeTempDir();
        const flatDb = join(appData, 'mindwtr', 'mindwtr.db');
        const splitDb = join(appData, 'mindwtr', 'data', 'mindwtr.db');
        touch(flatDb);
        touch(splitDb);

        setPlatform('win32');
        process.env.APPDATA = appData;
        clearOverrides();

        expect(resolveMindwtrDbPath()).toBe(splitDb);
    });

    test('still finds a flat Windows root written by 1.3.1 and earlier', () => {
        process.env.HOME = makeTempDir();
        const appData = makeTempDir();
        const flatDb = join(appData, 'mindwtr', 'mindwtr.db');
        touch(flatDb);

        setPlatform('win32');
        process.env.APPDATA = appData;
        clearOverrides();

        expect(resolveMindwtrDbPath()).toBe(flatDb);
    });

    test('keeps the flat root on Linux, where the app never uses a data/ subfolder', () => {
        process.env.HOME = makeTempDir();
        const dataHome = makeTempDir();
        const flatDb = join(dataHome, 'mindwtr', 'mindwtr.db');
        const splitDb = join(dataHome, 'mindwtr', 'data', 'mindwtr.db');
        touch(flatDb);
        touch(splitDb);

        setPlatform('linux');
        process.env.XDG_DATA_HOME = dataHome;
        process.env.XDG_CONFIG_HOME = join(dataHome, 'config');
        clearOverrides();

        expect(resolveMindwtrDbPath()).toBe(flatDb);
    });


    test('finds a Flatpak profile on Linux when the XDG roots are empty', () => {
        const home = makeTempDir();
        const xdgHome = makeTempDir();
        const flatpakDb = join(
            home, '.var', 'app', 'tech.dongdongbh.mindwtr', 'data', 'mindwtr', 'mindwtr.db'
        );
        touch(flatpakDb);

        setPlatform('linux');
        process.env.HOME = home;
        process.env.XDG_DATA_HOME = join(xdgHome, 'share');
        process.env.XDG_CONFIG_HOME = join(xdgHome, 'config');
        clearOverrides();

        expect(resolveMindwtrDbPath()).toBe(flatpakDb);
    });
});

describe('automation script explicit paths', () => {
    test('follows a pinned flat path into the installed data/ layout', () => {
        const root = makeTempDir();
        const pinnedDb = join(root, 'mindwtr.db');
        const movedDb = join(root, 'data', 'mindwtr.db');
        const pinnedData = join(root, 'data.json');
        const movedData = join(root, 'data', 'data.json');
        touch(movedDb);
        touch(movedData);
        clearOverrides();
        const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            expect(resolveMindwtrDbPath(pinnedDb)).toBe(movedDb);
            expect(resolveMindwtrDataPath(pinnedData)).toBe(movedData);
            expect(errorSpy).toHaveBeenCalledWith(
                `[mindwtr] Using ${movedDb} (nothing at the configured path: ${pinnedDb})`
            );
        } finally {
            errorSpy.mockRestore();
        }
    });

    test('follows a pinned data/ path back to a flat profile an older version still uses', () => {
        const root = makeTempDir();
        const flatDb = join(root, 'mindwtr.db');
        touch(flatDb);
        clearOverrides();
        const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            expect(resolveMindwtrDbPath(join(root, 'data', 'mindwtr.db'))).toBe(flatDb);
        } finally {
            errorSpy.mockRestore();
        }
    });

    test('still creates the profile at an explicit path when neither layout exists', () => {
        const root = makeTempDir();
        const pinnedDb = join(root, 'scratch', 'mindwtr.db');
        const pinnedData = join(root, 'scratch', 'data.json');
        clearOverrides();


        expect(resolveMindwtrDbPath(pinnedDb)).toBe(pinnedDb);
        expect(resolveMindwtrDataPath(pinnedData)).toBe(pinnedData);
        expect(existsSync(join(root, 'scratch'))).toBe(false);
    });


    test('ignores a sibling folder that is not a Mindwtr profile', () => {
        const root = makeTempDir();
        const unrelated = join(root, 'data.json');
        const contents = '{"someOtherTool":true}';
        writeFileSync(unrelated, contents);
        const pinned = join(root, 'data', 'data.json');
        clearOverrides();

        expect(resolveMindwtrDataPath(pinned)).toBe(pinned);
        expect(readFileSync(unrelated, 'utf8')).toBe(contents);
    });

    test('ignores an unrelated data/data.json when no database sits beside it', () => {
        const root = makeTempDir();
        const unrelated = join(root, 'data', 'data.json');
        const contents = '{"someOtherTool":true}';
        touch(unrelated);
        writeFileSync(unrelated, contents);
        const pinned = join(root, 'data.json');
        clearOverrides();

        expect(resolveMindwtrDataPath(pinned)).toBe(pinned);
        expect(readFileSync(unrelated, 'utf8')).toBe(contents);
    });

    test('honours MINDWTR_DB_PATH and MINDWTR_DATA the same way', () => {
        const root = makeTempDir();
        const movedDb = join(root, 'data', 'mindwtr.db');
        const movedData = join(root, 'data', 'data.json');
        touch(movedDb);
        touch(movedData);
        clearOverrides();
        process.env.MINDWTR_DB_PATH = join(root, 'mindwtr.db');
        process.env.MINDWTR_DATA = join(root, 'data.json');
        const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            expect(resolveMindwtrDbPath()).toBe(movedDb);
            expect(resolveMindwtrDataPath()).toBe(movedData);
        } finally {
            errorSpy.mockRestore();
        }
    });
});

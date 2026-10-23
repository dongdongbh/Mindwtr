import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GmailReceiptDatabase, GmailReceiptStore } from './gmail-capture-storage';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expoSources = resolve(mobile, '../../node_modules/expo-file-system/src');

// The opener deliberately uses lazy require; evaluate its real source with native bindings,
// leaving Expo's constructors/path utilities and the maintained RN URL shim intact.
function evaluate<T>(file: string, dependencies: Record<string, unknown>, runtimeURL?: typeof URL): T {
    const module = { exports: {} as T };
    const source = transpileModule(readFileSync(file, 'utf8'), {
        fileName: file,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    runInNewContext(source, {
        module, exports: module.exports, URL: runtimeURL, URLSearchParams: undefined, Error, TypeError,
        require: (name: string) => {
            if (!(name in dependencies)) throw new Error(`Unexpected test dependency: ${name}`);
            return dependencies[name];
        },
    }, { filename: file });
    return module.exports;
}

let cleanUp: (() => void) | undefined;
afterEach(() => { cleanUp?.(); cleanUp = undefined; });

function openerHarness(fileCreationError?: Error) {
    const parent = join(homedir(), '.cache', 'mindwtr-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'gmail-opening-'));
    const document = join(root, 'Documents');
    mkdirSync(document);
    const documentURI = `${pathToFileURL(document).href}/`;
    const createdDirectories: string[] = [];
    const createdFiles: string[] = [];
    const databases: DatabaseSync[] = [];
    const closeDatabases = () => databases.splice(0).forEach((database) => database.close());
    cleanUp = () => { closeDatabases(); rmSync(root, { recursive: true, force: true }); };

    class NativeDirectory {
        readonly uri: string;
        constructor(uri: string) { this.uri = `${uri.replace(/\/$/, '')}/`; }
        validatePath() {
            if (existsSync(fileURLToPath(this.uri)) && !statSync(fileURLToPath(this.uri)).isDirectory()) {
                throw new Error('Directory path is a file');
            }
        }
        get exists() { return existsSync(fileURLToPath(this.uri)); }
        create() {
            mkdirSync(fileURLToPath(this.uri), { recursive: true });
            createdDirectories.push(this.uri);
        }
    }
    class NativeFile {
        constructor(readonly uri: string) {}
        validatePath() {
            if (existsSync(fileURLToPath(this.uri)) && statSync(fileURLToPath(this.uri)).isDirectory()) {
                throw new Error('File path is a directory');
            }
        }
        get exists() { return existsSync(fileURLToPath(this.uri)); }
        get size() { return statSync(fileURLToPath(this.uri)).size; }
        create() {
            if (fileCreationError) throw fileCreationError;
            writeFileSync(fileURLToPath(this.uri), '', { flag: 'wx' });
            createdFiles.push(this.uri);
        }
    }

    const fallback = evaluate<{ URL: typeof URL }>(join(mobile, 'shims/url-polyfill.js'), {});
    expect(fallback.URL.name).toBe('FallbackURL');
    const path = evaluate<Record<string, unknown>>(join(expoSources, 'pathUtilities/path.ts'), {}, fallback.URL);
    const url = evaluate<Record<string, unknown>>(join(expoSources, 'pathUtilities/url.ts'), { './path': path }, fallback.URL);
    const utilities = evaluate<Record<string, unknown>>(join(expoSources, 'pathUtilities/index.ts'), {
        './path': path, './url': url,
    }, fallback.URL);
    const fileSystem = evaluate<Record<string, unknown>>(join(expoSources, 'FileSystem.ts'), {
        './ExpoFileSystem': { __esModule: true, default: {
            FileSystemDirectory: NativeDirectory, FileSystemFile: NativeFile, documentDirectory: documentURI,
        } },
        './pathUtilities': utilities,
        './streams': {},
    }, fallback.URL);
    const open = vi.fn(({ name, location }: { name: string; location: string }) => {
        const database = new DatabaseSync(join(location, name));
        databases.push(database);
        return {
            executeSync(sql, params = []) {
                const statement = database.prepare(sql);
                if (statement.columns().length) return { rows: statement.all(...params) };
                statement.run(...params);
                return { rows: [] };
            },
        } satisfies GmailReceiptDatabase;
    });
    const logWarn = vi.fn();
    const reload = () => evaluate<{ getGmailReceiptStore: () => GmailReceiptStore }>(join(mobile, 'lib/gmail-capture-storage.ts'), {
        'expo-file-system': fileSystem,
        '@op-engineering/op-sqlite': { open },
        './app-log': { logWarn },
    }, fallback.URL);
    return { reload, document, createdDirectories, createdFiles, open, closeDatabases, logWarn };
}

describe('Gmail receipt storage opening under the RN URL shim', () => {
    it('creates the real GmailCapture child paths and reopens durable receipts', () => {
        const harness = openerHarness();
        const receiptDirectory = join(harness.document, 'GmailCapture');
        const receiptPath = join(receiptDirectory, 'receipts.sqlite');
        const module = harness.reload();
        const store = module.getGmailReceiptStore();
        expect(harness.createdDirectories).toEqual([`${pathToFileURL(receiptDirectory).href}/`]);
        expect(harness.createdFiles).toEqual([pathToFileURL(receiptPath).href]);
        expect(harness.open).toHaveBeenCalledExactlyOnceWith({ name: 'receipts.sqlite', location: `${receiptDirectory}/` });
        expect(module.getGmailReceiptStore()).toBe(store);
        store.acknowledge('account-a', ['message-a']);
        store.configure({ account: 'account-a', label: 'label-a', enabled: true, blocked: false });
        harness.closeDatabases();

        const reopened = harness.reload().getGmailReceiptStore();
        expect(reopened.seen('account-a', 'message-a')).toBe(true);
        expect(reopened.config()).toEqual({ account: 'account-a', label: 'label-a', enabled: true, blocked: false });
        expect(harness.open).toHaveBeenCalledTimes(2);
        expect(harness.createdDirectories).toHaveLength(1);
        expect(harness.createdFiles).toHaveLength(1);
        expect(statSync(receiptPath).size).toBeGreaterThan(100);
    });

    it('forces a fixed file-stage diagnostic without exposing the native failure', async () => {
        const harness = openerHarness(new Error('PRIVATE_NATIVE_DETAIL_WITH_MAIL_AND_CREDENTIALS'));
        const module = harness.reload();
        expect(() => module.getGmailReceiptStore()).toThrow();
        expect(() => module.getGmailReceiptStore()).toThrow();
        await vi.waitFor(() => expect(harness.logWarn).toHaveBeenCalledExactlyOnceWith(
            'Gmail receipt storage unavailable',
            { force: true, scope: 'gmail-capture', extra: {
                releaseCheck: 'v1.3.7/gmail-capture-storage', stage: 'file', errorKind: 'native',
            } },
        ));
        expect(harness.open).not.toHaveBeenCalled();
    });
});

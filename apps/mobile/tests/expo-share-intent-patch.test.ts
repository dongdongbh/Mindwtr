import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The installed expo-share-intent, as patches/expo-share-intent@5.1.1.patch leaves it (bun applies the patch on install;
// scripts/ci/apply_bun_patches.sh applies it to npm installs). The module has no test set, so these pin its source: each
// security expression exactly, and each pin is shown to fail on the change it guards against (the mutations below).
const require = createRequire(import.meta.url);
const moduleSource = readFileSync(path.join(path.dirname(require.resolve('expo-share-intent/package.json')),
    'android/src/main/java/expo/modules/shareintent/ExpoShareIntentModule.kt'), 'utf8');

/** One function's text: from `fun name(` to the closing brace at its own indent. */
const body = (source: string, name: string) => {
    const start = source.indexOf(`fun ${name}(`);
    if (start < 0) return '';
    const lineStart = source.lastIndexOf('\n', start) + 1;
    const indent = source.slice(lineStart, start).match(/^ */)?.[0] ?? '';
    const end = source.indexOf(`\n${indent}}\n`, start);
    return source.slice(start, end < 0 ? undefined : end);
};

/** The pins that fail on [source]: empty when every security expression is in place. */
const failedPins = (source: string): string[] => {
    const guard = body(source, 'isForeignContentUri');
    const handle = body(source, 'handleShareIntent');
    const cacheFile = body(source, 'sharedCacheFile');
    const resolve = body(source, 'getAbsolutePath');
    const info = body(source, 'getFileInfo');
    const pins: [string, boolean][] = [
        // A hostile share (Dirty Stream): only another app's content URI is taken.
        ['scheme', guard.includes('if (!"content".equals(uri.scheme, ignoreCase = true)) return false')],
        // ContentResolver opens content://0@<authority> as <authority>: the check looks up that same name.
        ['authority', guard.includes("val authority = uri.authority?.substringAfterLast('@')?.takeIf { it.isNotEmpty() } ?: return false")],
        ['owner', guard.includes('return owner != context.packageName')],
        ['lookup error', /resolveContentProvider\(authority, 0\)\?\.packageName\n\s*\} catch \(e: Exception\) \{\n\s*return false\n/.test(guard)],
        ['one file', handle.includes('if (uri != null && isForeignContentUri(uri))')],
        ['several files', handle.includes('EXTRA_STREAM)?.filter { isForeignContentUri(it) }')],
        // The cache copy's name is generated; the display name is a title only.
        ['extension', cacheFile.includes('?.takeIf { it.matches(Regex("[A-Za-z0-9]{1,8}")) }')],
        ['cache name', cacheFile.includes('return File(context.cacheDir, "share-${UUID.randomUUID()}" + (extension?.let { ".$it" } ?: ""))')],
        ['no name in path', !/File\(context\.cacheDir,[^\n]*displayName/.test(source) && !/File\(context\.cacheDir,\s*fileName\)/.test(source)],
        ['copy uses it', body(source, 'getDataColumn').includes('val targetFile = sharedCacheFile(displayName, resolver.getType(uri))')],
        // A shared-storage document is copied through its provider (the sender's grant), never read by a built path.
        ['no built path', !source.includes('getExternalStorageDirectory()')
            && /isExternalStorageDocument\(uri\)\) \{\n(\s*\/\/[^\n]*\n)*\s*return getDataColumn\(uri, null, null\)\n/.test(resolve)],
        // One copy per shared file.
        ['one copy', info.includes('retriever.setDataSource(filePath)') && info.includes('"filePath" to filePath,')],
        // No URI in an error message (it reaches the diagnostics log).
        ['no uri in errors', !/notifyError\([^\n]*\$uri/.test(source)],
    ];
    return pins.filter(([, ok]) => !ok).map(([name]) => name);
};

const mutations: Record<string, (source: string) => string> = {
    'scheme': (s) => s.replace('if (!"content".equals(uri.scheme, ignoreCase = true)) return false', 'if (uri.scheme == null) return false'),
    'authority': (s) => s.replace("uri.authority?.substringAfterLast('@')?.takeIf { it.isNotEmpty() } ?: return false", 'uri.authority ?: return false'),
    'owner': (s) => s.replace('return owner != context.packageName', 'return owner == null || owner == context.packageName'),
    'lookup error': (s) => s.replace(/(resolveContentProvider\(authority, 0\)\?\.packageName\n\s*\} catch \(e: Exception\) \{\n\s*)return false/, '$1null'),
    'one file': (s) => s.replace('if (uri != null && isForeignContentUri(uri))', 'if (uri != null)'),
    'several files': (s) => s.replace('EXTRA_STREAM)?.filter { isForeignContentUri(it) }', 'EXTRA_STREAM)'),
    'extension': (s) => s.replace('?.takeIf { it.matches(Regex("[A-Za-z0-9]{1,8}")) }', ''),
    'cache name': (s) => s.replace('"share-${UUID.randomUUID()}"', '"share-${UUID.randomUUID()}-$displayName"'),
    'no name in path': (s) => s.replace('val targetFile = sharedCacheFile(displayName, resolver.getType(uri))', 'val targetFile = File(context.cacheDir, displayName ?: "x")'),
    'no built path': (s) => s.replace(/(isExternalStorageDocument\(uri\)\) \{\n(\s*\/\/[^\n]*\n)*\s*)return getDataColumn\(uri, null, null\)/,
        '$1return android.os.Environment.getExternalStorageDirectory().toString() + "/" + DocumentsContract.getDocumentId(uri)'),
    'one copy': (s) => s.replace('retriever.setDataSource(filePath)', 'retriever.setDataSource(instance?.getAbsolutePath(uri))'),
    'no uri in errors': (s) => s.replace('notifyError("cannot retrieve the shared file\'s path")', 'notifyError("cannot retrieve $uri")'),
};

describe('expo-share-intent patch: a hostile share (Dirty Stream)', () => {
    it('keeps every security expression of the patch', () => {
        expect(failedPins(moduleSource)).toEqual([]);
    });

    it.each(Object.keys(mutations))('catches the change that undoes "%s"', (name) => {
        const mutated = mutations[name](moduleSource);
        expect(mutated, `the "${name}" mutation applies`).not.toBe(moduleSource);
        expect(failedPins(mutated)).toContain(name);
    });
});

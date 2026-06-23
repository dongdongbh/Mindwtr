#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { en } from '../packages/core/src/i18n/locales/en';
import { hasTranslatableEnglishText, isAllowedEnglishMirrorKey } from '../packages/core/src/i18n/locale-quality';

type Dictionary = Record<string, string>;

type LocaleTarget = {
    locale: string;
    path: string;
    fullParity?: boolean;
};

const LOCALES: LocaleTarget[] = [
    { locale: 'ar', path: 'packages/core/src/i18n/locales/ar.ts' },
    { locale: 'cs', path: 'packages/core/src/i18n/locales/cs.ts' },
    { locale: 'de', path: 'packages/core/src/i18n/locales/de.ts' },
    { locale: 'es', path: 'packages/core/src/i18n/locales/es.ts' },
    { locale: 'fr', path: 'packages/core/src/i18n/locales/fr.ts' },
    { locale: 'hi', path: 'packages/core/src/i18n/locales/hi.ts' },
    { locale: 'it', path: 'packages/core/src/i18n/locales/it.ts' },
    { locale: 'ja', path: 'packages/core/src/i18n/locales/ja.ts' },
    { locale: 'ko', path: 'packages/core/src/i18n/locales/ko.ts' },
    { locale: 'nl', path: 'packages/core/src/i18n/locales/nl.ts' },
    { locale: 'pl', path: 'packages/core/src/i18n/locales/pl.ts' },
    { locale: 'pt', path: 'packages/core/src/i18n/locales/pt.ts' },
    { locale: 'ru', path: 'packages/core/src/i18n/locales/ru.ts' },
    { locale: 'tr', path: 'packages/core/src/i18n/locales/tr.ts' },
    { locale: 'vi', path: 'packages/core/src/i18n/locales/vi.ts' },
    { locale: 'zh-Hans', path: 'packages/core/src/i18n/locales/zh-Hans.ts', fullParity: true },
    { locale: 'zh-Hant', path: 'packages/core/src/i18n/locales/zh-Hant.ts', fullParity: true },
];
const NON_LATIN_PARTIAL_LOCALES = new Set(['ar', 'hi', 'ja', 'ko', 'ru']);

const args = new Set(process.argv.slice(2));
const shouldFix = args.has('--fix');
const shouldCheck = args.has('--check') || !shouldFix;

function resolveDictionary(moduleExports: Record<string, unknown>): Dictionary {
    if (moduleExports.zhHans && typeof moduleExports.zhHans === 'object') return moduleExports.zhHans as Dictionary;
    if (moduleExports.zhHant && typeof moduleExports.zhHant === 'object') return moduleExports.zhHant as Dictionary;
    const overrideEntry = Object.entries(moduleExports).find(([name, value]) => (
        name.endsWith('Overrides') && value && typeof value === 'object'
    ));
    if (overrideEntry) return overrideEntry[1] as Dictionary;
    throw new Error('Could not find a locale dictionary export.');
}

function removeKeys(filePath: string, keys: Set<string>) {
    const entryPattern = /^\s*'([^']+)':\s*/;
    const source = readFileSync(filePath, 'utf8');
    const nextLines: string[] = [];
    for (const line of source.split('\n')) {
        const match = line.match(entryPattern);
        if (match && keys.has(match[1])) {
            if (nextLines.at(-1)?.trim() === '// English fallbacks keep shipped locale files in key parity.') {
                nextLines.pop();
            }
            continue;
        }
        nextLines.push(line);
    }
    writeFileSync(filePath, nextLines.join('\n'));
}

const englishKeys = Object.keys(en).sort();
const englishKeySet = new Set(englishKeys);
let problemCount = 0;

for (const target of LOCALES) {
    const modulePath = join('..', target.path);
    const moduleExports = await import(modulePath);
    const dictionary = resolveDictionary(moduleExports);
    const localeKeys = new Set(Object.keys(dictionary));

    const unknownKeys = Object.keys(dictionary).filter((key) => !englishKeySet.has(key));
    const mirroredEnglishKeys = Object.keys(dictionary)
        .filter((key) => dictionary[key] === en[key]
            && hasTranslatableEnglishText(en[key])
            && !isAllowedEnglishMirrorKey(target.locale, key));
    const mixedEnglishKeys = !target.fullParity && NON_LATIN_PARTIAL_LOCALES.has(target.locale)
        ? Object.keys(dictionary).filter((key) => hasTranslatableEnglishText(dictionary[key]))
        : [];
    const missingKeys = target.fullParity
        ? englishKeys.filter((key) => !localeKeys.has(key))
        : [];
    const fixableKeys = new Set([...unknownKeys, ...mirroredEnglishKeys, ...mixedEnglishKeys]);

    if (missingKeys.length === 0 && unknownKeys.length === 0 && mirroredEnglishKeys.length === 0 && mixedEnglishKeys.length === 0) {
        console.log(`${target.locale}: ok`);
        continue;
    }

    problemCount += missingKeys.length + unknownKeys.length + mirroredEnglishKeys.length + mixedEnglishKeys.length;
    if (missingKeys.length > 0) console.log(`${target.locale}: missing ${missingKeys.length} keys`);
    if (unknownKeys.length > 0) console.log(`${target.locale}: unknown ${unknownKeys.length} keys`);
    if (mirroredEnglishKeys.length > 0) console.log(`${target.locale}: mirrored English ${mirroredEnglishKeys.length} keys`);
    if (mixedEnglishKeys.length > 0) console.log(`${target.locale}: mixed English ${mixedEnglishKeys.length} keys`);
    if (shouldFix) {
        if (missingKeys.length > 0) {
            console.log(`${target.locale}: missing full-parity translations require manual translation`);
        }
        if (fixableKeys.size > 0) {
            removeKeys(target.path, fixableKeys);
            console.log(`${target.locale}: removed stale override entries`);
        }
    } else if (shouldCheck) {
        for (const [label, keys] of [
            ['missing', missingKeys],
            ['unknown', unknownKeys],
            ['mirrored', mirroredEnglishKeys],
            ['mixed English', mixedEnglishKeys],
        ] as const) {
            for (const key of keys.slice(0, 20)) {
                console.log(`  - ${label}: ${key}`);
            }
            if (keys.length > 20) {
                console.log(`  ...and ${keys.length - 20} more ${label}`);
            }
        }
    }
}

if (problemCount > 0 && shouldCheck && !shouldFix) {
    console.error(`Locale parity failed: ${problemCount} problems. Run bun run scripts/i18n-locale-parity.ts --fix to remove stale override entries.`);
    process.exit(1);
}

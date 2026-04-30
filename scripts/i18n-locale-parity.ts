#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { en } from '../packages/core/src/i18n/locales/en';

type Dictionary = Record<string, string>;

type LocaleTarget = {
    locale: string;
    path: string;
};

const LOCALES: LocaleTarget[] = [
    { locale: 'ar', path: 'packages/core/src/i18n/locales/ar.ts' },
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
    { locale: 'zh-Hans', path: 'packages/core/src/i18n/locales/zh-Hans.ts' },
    { locale: 'zh-Hant', path: 'packages/core/src/i18n/locales/zh-Hant.ts' },
];

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

const quote = (value: string): string => (
    `'${value
        .replace(/\\/g, '\\\\')
        .replace(/'/g, '\\\'')
        .replace(/\n/g, '\\n')}'`
);

function appendMissingKeys(filePath: string, missingKeys: string[]) {
    const source = readFileSync(filePath, 'utf8');
    const insertionPoint = source.lastIndexOf('};');
    if (insertionPoint < 0) {
        throw new Error(`Could not find dictionary end marker in ${filePath}`);
    }
    const lines = [
        '        // English fallbacks keep shipped locale files in key parity.',
        ...missingKeys.map((key) => `        ${quote(key)}: ${quote(en[key])},`),
    ];
    const prefix = source.slice(0, insertionPoint).replace(/\s*$/, '\n');
    const suffix = source.slice(insertionPoint);
    writeFileSync(filePath, `${prefix}${lines.join('\n')}\n${suffix}`);
}

const englishKeys = Object.keys(en).sort();
let missingCount = 0;

for (const target of LOCALES) {
    const modulePath = join('..', target.path);
    const moduleExports = await import(modulePath);
    const dictionary = resolveDictionary(moduleExports);
    const localeKeys = new Set(Object.keys(dictionary));
    const missingKeys = englishKeys.filter((key) => !localeKeys.has(key));
    if (missingKeys.length === 0) {
        console.log(`${target.locale}: ok`);
        continue;
    }

    missingCount += missingKeys.length;
    console.log(`${target.locale}: missing ${missingKeys.length} keys`);
    if (shouldFix) {
        appendMissingKeys(target.path, missingKeys);
        console.log(`${target.locale}: added English fallback entries`);
    } else if (shouldCheck) {
        for (const key of missingKeys.slice(0, 20)) {
            console.log(`  - ${key}`);
        }
        if (missingKeys.length > 20) {
            console.log(`  ...and ${missingKeys.length - 20} more`);
        }
    }
}

if (missingCount > 0 && shouldCheck && !shouldFix) {
    console.error(`Locale parity failed: ${missingCount} missing keys. Run bun run scripts/i18n-locale-parity.ts --fix to add explicit fallbacks.`);
    process.exit(1);
}

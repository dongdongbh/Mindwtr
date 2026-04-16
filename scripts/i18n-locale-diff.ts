#!/usr/bin/env bun
import { en } from '../packages/core/src/i18n/locales/en';

type Dictionary = Record<string, string>;

function usage(exitCode: number) {
    console.log([
        'i18n-locale-diff',
        '',
        'Usage:',
        '  bun run scripts/i18n-locale-diff.ts <locale>',
        '',
        'Examples:',
        '  bun run scripts/i18n-locale-diff.ts de',
        '  bun run scripts/i18n-locale-diff.ts fr',
    ].join('\n'));
    process.exit(exitCode);
}

function resolveDictionary(moduleExports: Record<string, unknown>): Dictionary {
    if (moduleExports.en && typeof moduleExports.en === 'object') {
        return moduleExports.en as Dictionary;
    }
    if (moduleExports.zhHans && typeof moduleExports.zhHans === 'object') {
        return moduleExports.zhHans as Dictionary;
    }
    if (moduleExports.zhHant && typeof moduleExports.zhHant === 'object') {
        return moduleExports.zhHant as Dictionary;
    }

    const overrideEntry = Object.entries(moduleExports).find(([name, value]) => (
        name.endsWith('Overrides') && value && typeof value === 'object'
    ));
    if (overrideEntry) {
        return overrideEntry[1] as Dictionary;
    }

    throw new Error('Could not find a locale dictionary export in the requested file.');
}

const locale = process.argv[2]?.trim();
if (!locale) usage(1);

let localeDictionary: Dictionary;
try {
    const localeModule = await import(`../packages/core/src/i18n/locales/${locale}.ts`);
    localeDictionary = resolveDictionary(localeModule);
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to load locale "${locale}": ${message}`);
    process.exit(1);
}

const sourceKeys = Object.keys(en).sort();
const localeKeys = Object.keys(localeDictionary).sort();
const sourceKeySet = new Set(sourceKeys);
const localeKeySet = new Set(localeKeys);

const missingKeys = sourceKeys.filter((key) => !localeKeySet.has(key));
const extraKeys = localeKeys.filter((key) => !sourceKeySet.has(key));

console.log(`Locale: ${locale}`);
console.log(`English keys: ${sourceKeys.length}`);
console.log(`Locale keys: ${localeKeys.length}`);
console.log(`Missing keys: ${missingKeys.length}`);
console.log(`Extra keys: ${extraKeys.length}`);

if (missingKeys.length) {
    console.log('\nMissing keys (currently falling back to English):');
    missingKeys.forEach((key) => console.log(`- ${key}`));
}

if (extraKeys.length) {
    console.log('\nExtra keys (not present in en.ts):');
    extraKeys.forEach((key) => console.log(`- ${key}`));
}

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export type Surface = { page: string; source: string };

export const SURFACES: Surface[] = [
    { page: 'desktop.md', source: 'apps/desktop/src' },
    { page: 'mobile.md', source: 'apps/mobile' },
    { page: 'android-native.md', source: 'apps/android-native' },
    { page: 'ios-native.md', source: 'apps/ios-native' },
];

export const DEVICE_SCRIPT_PAGE = 'android-native.md';
const DEVICE_SCRIPT = /^apps\/android-native\/scripts\/check-[^/]+-device\.mjs$/;
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|kt|java|swift|m|xml)$/;

export type MapInput = {
    pages: Record<string, string>;
    sources: Record<string, string>;
    trackedFiles: string[];
    exists: (path: string) => boolean;
};

export const fieldValues = (markdown: string, field: string): string[] => {
    const values: string[] = [];
    let inFence = false;
    for (const line of markdown.split(/\r?\n/)) {
        if (/^\s*```/.test(line)) inFence = !inFence;
        if (inFence || !line.startsWith(`- ${field}:`)) continue;
        for (const match of line.matchAll(/`([^`]+)`/g)) values.push(match[1]);
    }
    return values;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const appearsQuoted = (source: string, selector: string) =>
    new RegExp(`["'\`]${escapeRegExp(selector)}`).test(source);

export const findFeatureMapProblems = ({ pages, sources, trackedFiles, exists }: MapInput): string[] => {
    const problems: string[] = [];
    for (const { page, source } of SURFACES) {
        const markdown = pages[page];
        if (markdown === undefined) {
            problems.push(`${page}: page is missing`);
            continue;
        }
        for (const field of ['Code', 'Checks']) {
            for (const path of fieldValues(markdown, field)) {
                if (!exists(path)) problems.push(`${page}: ${field} path does not exist: ${path}`);
            }
        }
        for (const selector of fieldValues(markdown, 'Selectors')) {
            if (!appearsQuoted(sources[source] ?? '', selector)) {
                problems.push(`${page}: selector not found in ${source}: ${selector}`);
            }
        }
    }
    const listedChecks = new Set(fieldValues(pages[DEVICE_SCRIPT_PAGE] ?? '', 'Checks'));
    for (const file of trackedFiles) {
        if (DEVICE_SCRIPT.test(file) && !listedChecks.has(file)) {
            problems.push(`${DEVICE_SCRIPT_PAGE}: device script is not on any Checks line: ${file}`);
        }
    }
    return problems;
};

const readSurfaceSource = (root: string, trackedFiles: string[], source: string) =>
    trackedFiles
        .filter((file) => file.startsWith(`${source}/`) && SOURCE_FILE.test(file))
        .map((file) => readFileSync(join(root, file), 'utf8'))
        .join('\n');

const main = () => {
    const root = join(import.meta.dir, '..');
    const trackedFiles = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
    const pageDir = join(root, 'docs/feature-map');
    const pages: Record<string, string> = {};
    const sources: Record<string, string> = {};
    for (const { page, source } of SURFACES) {
        const pagePath = join(pageDir, page);
        if (existsSync(pagePath)) pages[page] = readFileSync(pagePath, 'utf8');
        sources[source] = readSurfaceSource(root, trackedFiles, source);
    }
    const problems = findFeatureMapProblems({ pages, sources, trackedFiles, exists: (path) => existsSync(join(root, path)) });
    if (problems.length > 0) {
        for (const problem of problems) console.error(problem);
        console.error(`Feature map check failed with ${problems.length} problem(s). See docs/feature-map/README.md.`);
        process.exit(1);
    }
    console.log('Feature map check passed.');
};

if (import.meta.main) main();

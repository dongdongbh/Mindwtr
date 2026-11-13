import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const liveIndexForEach = /ForEach\(\s*model\.[^{}\n]*?\.indices\b/g;

export function liveIndexForEachSites(appDirectory) {
    const sites = [];
    for (const name of readdirSync(appDirectory).filter((entry) => entry.endsWith('.swift')).sort()) {
        const text = readFileSync(resolve(appDirectory, name), 'utf8');
        for (const match of text.matchAll(liveIndexForEach)) {
            sites.push(`${name}:${text.slice(0, match.index).split('\n').length}: ForEach over a live model array's indices; iterate Array(<array>.enumerated()) or a body snapshot instead`);
        }
    }
    return sites;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const sites = liveIndexForEachSites(resolve(dirname(fileURLToPath(import.meta.url)), '../App'));
    if (sites.length) { console.error(sites.join('\n')); process.exit(1); }
    console.log('No iOS ForEach indexes a live model array');
}

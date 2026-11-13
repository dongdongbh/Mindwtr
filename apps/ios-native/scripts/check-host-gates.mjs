import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const literalNames = (expression) => [...expression.matchAll(/(\?\s*)?(==|!=)?\s*"([A-Za-z0-9]+)"(\s*:)?/g)]
    .filter((match) => !match[2] && (!match[4] || match[1])).map((match) => match[3]);

function firstArgument(text) {
    let depth = 0, out = '';
    for (const ch of text) {
        if ('([{'.includes(ch)) depth += 1;
        if (')]}'.includes(ch)) { if (depth === 0) break; depth -= 1; }
        if (ch === ',' && depth === 0) break;
        out += ch;
    }
    return out.trim();
}

function enclosingFunction(lines, index) {
    for (let at = index; at >= 0; at -= 1) {
        const match = lines[at].match(/\bfunc ([A-Za-z0-9_]+)\(/);
        if (match) return { start: at, name: match[1] };
    }
    return null;
}

function resolveNames(lines, index, expression, depth = 0) {
    const direct = literalNames(expression);
    if (direct.length || depth > 3) return direct;
    const variable = expression.match(/^[a-z][A-Za-z0-9]*$/)?.[0];
    if (!variable) return [];
    const scope = enclosingFunction(lines, index);
    if (!scope) return [];
    const names = [];
    for (let at = scope.start; at <= index; at += 1) {
        const line = lines[at];
        const binding = line.match(new RegExp(`\\b(?:let|var)\\s+${variable}\\b[^=]*=\\s*(.+)$`));
        if (binding) names.push(...resolveNames(lines, at, binding[1].trim(), depth + 1));
        const member = new RegExp(`\\[([^\\]]*)\\]\\.contains\\(${variable}\\)`).exec(line);
        if (member) names.push(...literalNames(member[1]));
    }
    if (names.length) return names;
    const property = lines.findIndex((line) => new RegExp(`\\bvar ${variable}: String \\{`).test(line));
    if (property >= 0) return literalNames(lines[property].slice(lines[property].indexOf('{')));
    if (new RegExp(`\\b${variable}: String\\b`).test(lines[scope.start])) {
        const label = new RegExp(`\\b${scope.name}\\((?:${variable}:\\s*|_?)`);
        lines.forEach((line, at) => {
            const call = line.match(label);
            if (!call || at === scope.start) return;
            const argument = firstArgument(line.slice(call.index + call[0].length));
            names.push(...resolveNames(lines, at, argument.replace(new RegExp(`^${variable}:\\s*`), ''), depth + 1));
        });
    }
    return names;
}

export function menuReadSends(appDirectory) {
    const sends = [];
    for (const file of readdirSync(appDirectory).filter((name) => name.endsWith('.swift')).sort()) {
        const lines = readFileSync(resolve(appDirectory, file), 'utf8').split('\n');
        lines.forEach((line, index) => {
            const call = line.match(/"menuRead",\s*(?:argumentsJSON:\s*)?(?:(?:self\.)?json\()?\[/);
            if (!call) return;
            const expression = firstArgument(line.slice(call.index + call[0].length));
            sends.push({ where: `${file}:${index + 1}`, expression, names: [...new Set(resolveNames(lines, index, expression))] });
        });
    }
    return sends;
}

export function swiftMenuReadAllowlist(coreHost) {
    const gate = coreHost.split('\n').find((line) => line.includes('guard let name = args[0] as? String, ["more"'));
    if (!gate) throw new Error('CoreHost.swift menuRead name allowlist moved');
    return new Set(literalNames(gate.slice(0, gate.indexOf('].contains(name)'))));
}

const swiftBoolean = (expression) => expression
    .replace(/input\["([A-Za-z]+)"\] as\? Bool != true/g, 'input.$1 !== true')
    .replace(/input\["([A-Za-z]+)"\] == nil/g, 'input.$1 === undefined')
    .replace(/input\["([A-Za-z]+)"\] != nil/g, 'input.$1 !== undefined');

export function bulkOrganizeGaps(coreHost, bulkActionsTs, taskListBulkTs) {
    const organizeLists = new Set();
    for (const source of [taskListBulkTs, bulkActionsTs]) {
        for (const match of source.matchAll(/^\s+([a-z]+): \{ status: '[a-z]+', organize: (true|false),/gm)) {
            if (match[2] === 'true') organizeLists.add(match[1]); else organizeLists.delete(match[1]);
        }
    }
    if (!organizeLists.size) throw new Error('core bulk screen table moved');
    const bulkGate = coreHost.slice(coreHost.indexOf('if name == "bulk" {'));
    const chain = (pattern, label) => {
        const match = bulkGate.match(pattern);
        if (!match) throw new Error(`CoreHost.swift bulk ${label} gate moved`);
        return new Set([...match[1].matchAll(/([a-z]+)Selection/g)].map((selection) => selection[1]));
    };
    const organize = chain(/guard ((?:[a-z]+Selection(?: \|\| )?)+), let value = organize as\? \[String: Any\]/, 'Organize');
    const picker = chain(/\(\(((?:[a-z]+Selection(?: \|\| )?)+)\) && input\["organize"\] != nil && \["project", "area"\]/, 'picker');
    const shownStart = bulkGate.indexOf('!(reviewSelection || contextsSelection) ||');
    const shownEnd = bulkGate.indexOf('Set(input.keys).isSubset(of: selectionKeys)', shownStart);
    if (shownStart < 0 || shownEnd < 0) throw new Error('CoreHost.swift Review and Contexts bulk gate moved');
    const shownExpression = swiftBoolean(bulkGate.slice(shownStart, shownEnd).trim().replace(/,\s*$/, ''));
    const gaps = [];
    for (const list of organizeLists) {
        if (!organize.has(list)) gaps.push(`bulk Organize gate refuses ${list}`);
        if (!picker.has(list)) gaps.push(`bulk Organize picker gate refuses ${list}`);
        const flags = Object.fromEntries(['review', 'contexts'].map((name) => [`${name}Selection`, name === list]));
        const admits = new Function(...Object.keys(flags), 'input', `return ${shownExpression};`)(...Object.values(flags), { organize: {}, picker: {} });
        if (!admits) gaps.push(`Review and Contexts bulk gate refuses Organize for ${list}`);
    }
    return gaps;
}

export function hostGateGaps(iosDirectory) {
    const repo = resolve(iosDirectory, '../..');
    const coreHost = readFileSync(resolve(iosDirectory, 'Sources/MindwtrNativeCore/CoreHost.swift'), 'utf8');
    const allowed = swiftMenuReadAllowlist(coreHost);
    const gaps = [];
    for (const send of menuReadSends(resolve(iosDirectory, 'App'))) {
        if (!send.names.length) gaps.push(`${send.where}: menuRead name ${send.expression} cannot be resolved to literals`);
        for (const name of send.names) if (!allowed.has(name)) gaps.push(`${send.where}: menuRead "${name}" is not in the CoreHost.swift allowlist`);
    }
    gaps.push(...bulkOrganizeGaps(coreHost,
        readFileSync(resolve(repo, 'packages/core/src/native-host-contract-bulk-actions.ts'), 'utf8'),
        readFileSync(resolve(repo, 'packages/core/src/task-list-bulk-actions.ts'), 'utf8')));
    return gaps;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const gaps = hostGateGaps(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
    if (gaps.length) { console.error(gaps.join('\n')); process.exit(1); }
    console.log('iOS host gates admit every menuRead name the app sends and every Organize list core offers');
}

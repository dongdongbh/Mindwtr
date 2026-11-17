import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '../..');
const swiftString = /"((?:[^"\\]|\\.)*)"/g;

export function allowedClientDiagnostics(coreHost: string): Set<string> {
    const start = coreHost.indexOf('private func validateClientDiagnosticArguments(');
    const end = coreHost.indexOf('guard valid else { throw invalid }', start);
    if (start < 0 || end < 0) throw new Error('validateClientDiagnosticArguments not found');
    const allowed = new Set<string>();
    for (const line of coreHost.slice(start, end).split('\n')) {
        const match = /^\s*case\s+(".*"):\s*$/.exec(line);
        if (match) for (const literal of match[1].matchAll(swiftString)) allowed.add(literal[1]);
    }
    return allowed;
}

const messageLiteral = /^(?:try\??\s+)?(?:self\.)?json\(\[\s*"((?:[^"\\]|\\.)*)"/;
const lineOf = (source: string, index: number) => source.slice(0, index).split('\n').length;

export function clientDiagnosticMessages(source: string): { message: string; line: number }[] {
    const found: { message: string; line: number }[] = [], variables = new Set<string>();
    for (const call of source.matchAll(/\.call\("logLine",\s*argumentsJSON:\s*/g)) {
        const rest = source.slice(call.index! + call[0].length);
        const literal = messageLiteral.exec(rest);
        if (literal) found.push({ message: literal[1], line: lineOf(source, call.index!) });
        const variable = /^(\w+)\s*\)/.exec(rest);
        if (variable) variables.add(variable[1]);
    }
    for (const name of variables) {
        for (const binding of source.matchAll(new RegExp(`let ${name}\\s*=\\s*`, 'g'))) {
            const literal = messageLiteral.exec(source.slice(binding.index! + binding[0].length));
            if (literal) found.push({ message: literal[1], line: lineOf(source, binding.index!) });
        }
    }
    return found;
}

const swiftFiles = (directory: string): string[] => readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? swiftFiles(path) : path.endsWith('.swift') ? [path] : [];
});

describe('native iOS client diagnostics', () => {
    it('admits every literal logLine message the app sends, so no marker is silently refused', () => {
        const allowed = allowedClientDiagnostics(readFileSync(join(root, 'apps/ios-native/Sources/MindwtrNativeCore/CoreHost.swift'), 'utf8'));
        const sent = swiftFiles(join(root, 'apps/ios-native/App')).flatMap((path) =>
            clientDiagnosticMessages(readFileSync(path, 'utf8')).map((entry) => ({ ...entry, path: path.slice(root.length + 1) })));
        expect(sent.length).toBeGreaterThan(50);
        expect(sent.filter((entry) => !allowed.has(entry.message)).map((entry) => `${entry.path}:${entry.line} ${entry.message}`)).toEqual([]);
    });

    it('reads literal messages and case lists, and skips messages built elsewhere', () => {
        const source = [
            '_ = try? await host.call("logLine", argumentsJSON: json([',
            '    "Native iOS sample", #"{"releaseCheck":"v1.3.9/x"}"#]))',
            '_ = try await host.call("logLine", argumentsJSON: self.json(["Native iOS second", try json([:])]))',
            'Task { _ = try? await host.call("logLine", argumentsJSON: line) }',
            'let line = try? self.json(["Native iOS built first", try self.json([:])])',
            'let other = try? json(["Never logged", 1])',
        ].join('\n');
        expect(clientDiagnosticMessages(source)).toEqual([{ message: 'Native iOS sample', line: 1 },
            { message: 'Native iOS second', line: 3 }, { message: 'Native iOS built first', line: 5 }]);
        const host = ['private func validateClientDiagnosticArguments(_ args: [Any]) throws {', '        case "A", "B":', '        case "C":',
            '        guard valid else { throw invalid }'].join('\n');
        expect([...allowedClientDiagnostics(host)]).toEqual(['A', 'B', 'C']);
    });
});

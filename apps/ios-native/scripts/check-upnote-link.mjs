import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(app, 'App/TaskViewSheet.swift'), 'utf8');
const start = source.indexOf('enum NativeMarkdownLinkURL {');
const end = source.indexOf('\nprivate struct NativeExternalLinkDiagnostic:', start);
if (start < 0 || end < 0) throw new Error('NativeMarkdownLinkURL source boundary changed');
const original = 'upnote://x-callback-url/openNote?noteId=Note%2FCase%2520&new_window=true';
const swift = `import Foundation
typealias CoreObject = [String: Any]
extension Dictionary where Key == String, Value == Any {
    func text(_ name: String) -> String { self[name] as? String ?? "" }
    func object(_ name: String) -> CoreObject { self[name] as? CoreObject ?? [:] }
}
${source.slice(start, end)}
let original = ${JSON.stringify(original)}
let opened = NativeMarkdownLinkURL.externalURL(original)!
precondition(opened.absoluteString == original)
let obsidian = "obsidian://open?vault=Obsidian%20Vault&file=Folder%2FNote%2520&heading=Section%20One"
precondition(NativeMarkdownLinkURL.externalURL(obsidian)?.absoluteString == obsidian)
let runs: [CoreObject] = [["type": "link", "target": ["kind": "external", "href": original]]]
precondition(NativeMarkdownLinkURL.originalHref(opened, runs: runs) == original)
for href in ["https://example.org", "http://example.org", "mailto:a@example.org", "tel:123"] {
    precondition(NativeMarkdownLinkURL.externalURL(href) != nil)
}
for href in ["javascript:alert(1)", "file:///secret", "data:text/plain,x", "obsidian:opaque", "upnote:opaque"] {
    precondition(NativeMarkdownLinkURL.externalURL(href) == nil)
}
precondition(NativeMarkdownLinkURL.originalHref(opened, runs: [["type": "link", "target": ["kind": "task", "href": original]]]) == nil)
print("Native external URL policy: exact encoded URI, original lookup, Obsidian, 4 ordinary and 5 blocked schemes passed")
`;
const folder = resolve(app, '../../.orchestrator/tasks/native/swift-check');
mkdirSync(folder, { recursive: true });
const path = resolve(folder, 'check.swift');
writeFileSync(path, swift);
if (process.argv.includes('--emit-only')) console.log(path);
else {
    const result = spawnSync('swift', [path], { stdio: 'inherit', env: { ...process.env, TMPDIR: folder } });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
}

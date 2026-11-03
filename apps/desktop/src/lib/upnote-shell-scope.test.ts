import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const scope = new RegExp(config.plugins.shell.open);
describe('Tauri external shell scope', () => {
    it.each([
        'upnote://x-callback-url/openNote?noteId=Note%2FCase%2520&new_window=true',
        'UPNOTE://x-callback-url/openNote?noteId=Case%2520',
        'joplin://x-callback-url/openNote?id=Note%2FCase%2520',
        'JOPLIN://x-callback-url/openNote?id=Case%2520',
        'https://example.com', 'http://example.com', 'mailto:a@example.com', 'tel:1234',
        'mid:a@example.com', 'obsidian://open?file=a', 'ms-windows-store://pdp/?ProductId=a',
    ])('allows %s', (href) => expect(scope.test(href)).toBe(true));
    it.each([
        'upnote://a bad', 'upnote://a\nbad', 'upnote://a\tbad', 'upnote://',
        'joplin://a bad', 'joplin://a\nbad', 'joplin://a\tbad', 'joplin://',
        'javascript:alert(1)', 'data:text/html,bad', 'file:///private/doc', 'custom://open',
    ])('blocks %s', (href) => expect(scope.test(href)).toBe(false));
});

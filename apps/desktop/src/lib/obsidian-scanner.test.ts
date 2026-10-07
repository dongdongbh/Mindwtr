import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
    DEFAULT_OBSIDIAN_INBOX_FILE,
    isObsidianFileInScanFolders,
    MAX_OBSIDIAN_MARKDOWN_BYTES,
    MAX_OBSIDIAN_SCAN_WARNINGS,
    normalizeObsidianConfig,
    scanObsidianFile,
    scanObsidianVault,
    type ObsidianScannerDependencies,
} from './obsidian-scanner';

const fixtureRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../packages/core/src/__fixtures__/obsidian-test-vault'
);

const nodeFsDeps: ObsidianScannerDependencies = {
    exists: async (path) => existsSync(path),
    readDir: async (path) => {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.map((entry) => ({
            name: entry.name,
            isFile: entry.isFile(),
            isDirectory: entry.isDirectory(),
        }));
    },
    readTextFile: async (path) => readFile(path, 'utf8'),
    stat: async (path) => {
        const fileInfo = await stat(path);
        return {
            mtime: fileInfo.mtime,
            isFile: fileInfo.isFile(),
            isDirectory: fileInfo.isDirectory(),
        };
    },
};

describe('scanObsidianVault', () => {
    it('walks the fixture vault and skips hidden Obsidian directories', async () => {
        const result = await scanObsidianVault({
            vaultPath: fixtureRoot,
            enabled: true,
            scanFolders: ['/'],
        }, nodeFsDeps);

        expect(result.scannedFileCount).toBe(12);
        expect(result.scannedRelativePaths).toHaveLength(12);
        expect(result.importMode).toBe('tasknotes');
        expect(result.taskNotesDetectedPaths).toEqual([
            'TaskNotes/Archive/Old task.md',
            'TaskNotes/Boolean status.md',
            'TaskNotes/Buy groceries.md',
            'TaskNotes/Review quarterly report.md',
        ]);
        expect(result.tasks).toHaveLength(3);
        expect(result.warnings).toEqual([]);
        expect(result.tasks.map((task) => task.source.relativeFilePath)).not.toContain('.trash/Deleted.md');
        expect(result.tasks.map((task) => task.source.relativeFilePath)).not.toContain('.obsidian/.gitkeep');
        expect(result.tasks.every((task) => task.format === 'tasknotes')).toBe(true);
        expect(result.scannedRelativePaths).not.toContain('.trash/Deleted.md');
        expect(result.scannedRelativePaths).not.toContain('TaskNotes/Views/tasks-default.md');
        expect(result.tasks[0]?.source.relativeFilePath).toBe('TaskNotes/Boolean status.md');
        expect(result.tasks[result.tasks.length - 1]?.source.relativeFilePath).toBe('TaskNotes/Review quarterly report.md');
    });

    it('respects configured scan folders', async () => {
        const result = await scanObsidianVault({
            vaultPath: fixtureRoot,
            enabled: true,
            scanFolders: ['Projects'],
        }, nodeFsDeps);

        expect(result.scannedFileCount).toBe(2);
        expect(result.tasks).toHaveLength(6);
        expect(result.importMode).toBe('inline');
        expect(result.taskNotesDetectedPaths).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect([...new Set(result.tasks.map((task) => task.source.relativeFilePath))]).toEqual([
            'Projects/Alpha.md',
            'Projects/Beta.md',
        ]);
    });

    it('ignores hidden scan folders and can scan a single markdown file path', async () => {
        const hiddenResult = await scanObsidianVault({
            vaultPath: fixtureRoot,
            enabled: true,
            scanFolders: ['.obsidian', 'Projects'],
        }, nodeFsDeps);
        const singleFileResult = await scanObsidianVault({
            vaultPath: fixtureRoot,
            enabled: true,
            scanFolders: ['Inbox.md'],
        }, nodeFsDeps);

        expect(hiddenResult.scannedFileCount).toBe(2);
        expect(hiddenResult.tasks).toHaveLength(6);
        expect(hiddenResult.importMode).toBe('inline');
        expect(hiddenResult.taskNotesDetectedPaths).toEqual([]);
        expect(hiddenResult.warnings).toEqual(['Skipped invalid scan folder: .obsidian']);
        expect(singleFileResult.scannedFileCount).toBe(1);
        expect(singleFileResult.importMode).toBe('inline');
        expect(singleFileResult.taskNotesDetectedPaths).toEqual([]);
        expect(singleFileResult.tasks.map((task) => task.text)).toEqual([
            'Buy groceries #errands',
            'Pay rent [[Bills]]',
            'Review docs #writing/reference',
        ]);
        expect(singleFileResult.warnings).toEqual([]);
    });

    it('skips markdown files larger than the size limit and reports a warning', async () => {
        const deps: ObsidianScannerDependencies = {
            exists: async () => true,
            readDir: async (path) => {
                if (path === '/Vault') {
                    return [{ name: 'Huge.md', isFile: true, isDirectory: false }];
                }
                return [];
            },
            readTextFile: async () => '- [ ] should never be read',
            stat: async (path) => ({
                mtime: new Date('2026-03-14T12:00:00.000Z'),
                isFile: path.endsWith('.md'),
                isDirectory: !path.endsWith('.md'),
                size: path.endsWith('.md') ? MAX_OBSIDIAN_MARKDOWN_BYTES + 1 : 0,
            }),
        };

        const result = await scanObsidianVault({
            vaultPath: '/Vault',
            enabled: true,
            scanFolders: ['/'],
        }, deps);

        expect(result.scannedFileCount).toBe(0);
        expect(result.tasks).toHaveLength(0);
        expect(result.importMode).toBe('inline');
        expect(result.taskNotesDetectedPaths).toEqual([]);
        expect(result.warnings).toEqual(['Skipped large Markdown file: Huge.md']);
    });

    it('caps accumulated scan warnings', async () => {
        const deps: ObsidianScannerDependencies = {
            exists: async () => true,
            readDir: async (path) => {
                if (path === '/Vault') {
                    return Array.from({ length: MAX_OBSIDIAN_SCAN_WARNINGS + 5 }, (_, index) => ({
                        name: `Huge-${index}.md`,
                        isFile: true,
                        isDirectory: false,
                    }));
                }
                return [];
            },
            readTextFile: async () => '- [ ] should never be read',
            stat: async (path) => ({
                mtime: new Date('2026-03-14T12:00:00.000Z'),
                isFile: path.endsWith('.md'),
                isDirectory: !path.endsWith('.md'),
                size: path.endsWith('.md') ? MAX_OBSIDIAN_MARKDOWN_BYTES + 1 : 0,
            }),
        };

        const result = await scanObsidianVault({
            vaultPath: '/Vault',
            enabled: true,
            scanFolders: ['/'],
        }, deps);

        expect(result.warnings).toHaveLength(MAX_OBSIDIAN_SCAN_WARNINGS);
        expect(result.importMode).toBe('inline');
        expect(result.taskNotesDetectedPaths).toEqual([]);
        expect(result.warnings[0]).toBe('Skipped large Markdown file: Huge-0.md');
        expect(result.warnings[result.warnings.length - 1]).toBe(
            `Skipped large Markdown file: Huge-${MAX_OBSIDIAN_SCAN_WARNINGS - 1}.md`
        );
    });

    it('incrementally rescans a single changed markdown file', async () => {
        const result = await scanObsidianFile({
            vaultPath: fixtureRoot,
            enabled: true,
            scanFolders: ['/'],
        }, 'Projects/Alpha.md', nodeFsDeps);

        expect(result.isTracked).toBe(true);
        expect(result.warning).toBeNull();
        expect(result.detectedTaskNotes).toBe(false);
        expect(result.tasks.map((task) => task.text)).toEqual([
            'Follow up on [[Meeting Notes 2026-03-14]] #work #urgent',
            'Review [[Project Alpha|Alpha project]] proposal',
        ]);
    });

    it('imports Dataview metadata only when configured', async () => {
        const deps: ObsidianScannerDependencies = {
            exists: async () => true,
            readDir: async (path) => {
                if (path === '/Vault') {
                    return [{ name: 'Inbox.md', isFile: true, isDirectory: false }];
                }
                return [];
            },
            readTextFile: async () => '- [ ] Draft launch note [project:: Launch] [context:: @desk] [due:: 2026-05-01] [priority:: medium]',
            stat: async (path) => ({
                mtime: new Date('2026-03-14T12:00:00.000Z'),
                isFile: path.endsWith('.md'),
                isDirectory: !path.endsWith('.md'),
            }),
        };

        const disabledResult = await scanObsidianVault({
            vaultPath: '/Vault',
            enabled: true,
            scanFolders: ['/'],
        }, deps);
        const enabledResult = await scanObsidianVault({
            vaultPath: '/Vault',
            enabled: true,
            scanFolders: ['/'],
            dataviewMetadataEnabled: true,
        }, deps);

        expect(disabledResult.tasks[0]?.dataviewData).toBeUndefined();
        expect(enabledResult.tasks[0]?.dataviewData).toMatchObject({
            priority: 'medium',
            dueDate: '2026-05-01',
            contexts: ['desk'],
            projects: ['Launch'],
        });
    });

    it('can include archived tasknotes files when configured', async () => {
        const result = await scanObsidianVault({
            vaultPath: fixtureRoot,
            enabled: true,
            scanFolders: ['TaskNotes'],
            requiredInlineTag: '',
            taskNotesIncludeArchived: true,
        }, nodeFsDeps);

        expect(result.importMode).toBe('tasknotes');
        expect(result.taskNotesDetectedPaths).toEqual([
            'TaskNotes/Archive/Old task.md',
            'TaskNotes/Boolean status.md',
            'TaskNotes/Buy groceries.md',
            'TaskNotes/Review quarterly report.md',
        ]);
        expect(result.tasks.map((task) => task.text)).toEqual([
            'Archived task',
            'Close support thread',
            'Buy groceries',
            'Review quarterly report',
        ]);
    });
});

describe('isObsidianFileInScanFolders', () => {
    it('matches folder and file based scan scopes', () => {
        expect(isObsidianFileInScanFolders('Projects/Alpha.md', ['/'])).toBe(true);
        expect(isObsidianFileInScanFolders('Projects/Alpha.md', ['Projects'])).toBe(true);
        expect(isObsidianFileInScanFolders('Projects/Alpha.md', ['Inbox.md'])).toBe(false);
        expect(isObsidianFileInScanFolders('Inbox.md', ['Inbox.md'])).toBe(true);
        expect(isObsidianFileInScanFolders('.obsidian/config.md', ['/'])).toBe(false);
    });
});

describe('normalizeObsidianConfig', () => {
    it('derives vault name and disables the integration without a vault path', () => {
        expect(normalizeObsidianConfig({
            vaultPath: '  ',
            enabled: true,
            scanFolders: [],
        })).toEqual({
            vaultPath: null,
            vaultName: '',
            scanFolders: ['/'],
            inboxFile: DEFAULT_OBSIDIAN_INBOX_FILE,
            requiredInlineTag: '',
            taskNotesIncludeArchived: false,
            dataviewMetadataEnabled: false,
            newTaskFormat: 'auto',
            lastScannedAt: null,
            enabled: false,
        });

        expect(normalizeObsidianConfig({
            vaultPath: '/Users/dd/Notes',
            enabled: true,
            scanFolders: ['Projects', './Daily'],
        })).toMatchObject({
            vaultPath: '/Users/dd/Notes',
            vaultName: 'Notes',
            enabled: true,
            scanFolders: ['Projects', 'Daily'],
            inboxFile: DEFAULT_OBSIDIAN_INBOX_FILE,
            requiredInlineTag: '',
            taskNotesIncludeArchived: false,
            dataviewMetadataEnabled: false,
            newTaskFormat: 'auto',
        });
    });
});


it('applies the same inline tag filter on full scans and live file reads', async () => {
    let markdown = '---\ntags: [task]\n---\n- [ ] Checklist\n- [ ] Action #task/work\n- [ ] Other #tasks';
    const deps: ObsidianScannerDependencies = {
        exists: async () => true,
        readDir: async () => [{ name: 'Inbox.md', isFile: true }],
        readTextFile: async () => markdown,
        stat: async () => ({ isFile: true, size: 100, mtime: new Date('2026-10-07') }),
    };
    const config = normalizeObsidianConfig({ vaultPath: '/Vault', enabled: true, requiredInlineTag: '#task' });
    const full = await scanObsidianVault(config, deps);
    const live = await scanObsidianFile(config, 'Inbox.md', deps);
    expect(full.tasks).toEqual(live.tasks);
    expect(live.tasks.map((task) => [task.text, task.source.lineNumber])).toEqual([['Action #task/work', 5]]);
    markdown = markdown.replace('#task/work', '#plain');
    expect((await scanObsidianFile(config, 'Inbox.md', deps)).tasks).toEqual([]);
    const taskNotes = await scanObsidianVault({ vaultPath: fixtureRoot, enabled: true, requiredInlineTag: '#not-present' }, nodeFsDeps);
    expect(taskNotes.tasks).toHaveLength(3);
    expect(taskNotes.tasks.every((task) => task.format === 'tasknotes')).toBe(true);
});

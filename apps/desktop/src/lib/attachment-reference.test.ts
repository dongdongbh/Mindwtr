import { describe, expect, it } from 'vitest';
import { isBareFileReference } from './attachment-reference';

const managedDirPrefix = 'C:/Users/me/AppData/Roaming/mindwtr/attachments/';

describe('isBareFileReference', () => {
    it('flags file attachments pointing outside the managed attachments dir with no cloud copy', () => {
        expect(isBareFileReference(
            { kind: 'file', uri: 'D:\\docs\\report.pdf' },
            managedDirPrefix,
        )).toBe(true);
        expect(isBareFileReference(
            { kind: 'file', uri: 'file:///D:/docs/report.pdf' },
            managedDirPrefix,
        )).toBe(true);

        expect(isBareFileReference(
            { kind: 'file', uri: 'C:\\Users\\me\\AppData\\Roaming\\OtherApp\\export.pdf' },
            managedDirPrefix,
        )).toBe(true);

        expect(isBareFileReference(
            { kind: 'file', uri: 'C:\\Users\\me\\AppData\\Roaming\\mindwtr\\attachments-old\\id.pdf' },
            managedDirPrefix,
        )).toBe(true);
    });

    it('treats managed copies, synced files, links, and remote uris as owned', () => {
        expect(isBareFileReference(
            { kind: 'file', uri: 'C:\\Users\\me\\AppData\\Roaming\\mindwtr\\attachments\\id.pdf' },
            managedDirPrefix,
        )).toBe(false);
        expect(isBareFileReference(
            { kind: 'file', uri: 'D:\\docs\\report.pdf', cloudKey: 'attachments/id.pdf' },
            managedDirPrefix,
        )).toBe(false);
        expect(isBareFileReference(
            { kind: 'link', uri: 'https://example.com' },
            managedDirPrefix,
        )).toBe(false);
        expect(isBareFileReference(
            { kind: 'file', uri: 'https://example.com/file.pdf' },
            managedDirPrefix,
        )).toBe(false);
    });

    it('defaults to owned while the managed dir is still unknown', () => {
        expect(isBareFileReference({ kind: 'file', uri: 'D:\\docs\\report.pdf' }, null)).toBe(false);
    });
});

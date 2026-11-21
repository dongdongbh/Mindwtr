import { describe, expect, it } from 'vitest';
import { formatImportDiagnostic } from './import-diagnostics';
import { parseImportSource } from './import-runner';

describe('Microsoft To Do CSV', () => {
    it('reads simplified Chinese fields and statuses from a semicolon-separated Tasks export', () => {
        const parsed = parseImportSource('microsoft-todo', {
            fileName: '办公.csv',
            text: [
                '\uFEFF"主题";"开始日期";"截止日期";"完成日期";"完成百分比";"注释";"类别";"优先级";"状态"',
                '采购;2026/11/22;2026年11月24日;;;"收到后再确认";"采购；工程";高;等待其他人',
                '旅行;无;1/1/4501;;;;;低;延迟',
                '回访;;;;;;;正常;已完成',
                '整理;;;;1;;;普通;正在进行',
                '寄送;;;;100%;;;;',
                '修理;;;;1;;;;',
            ].join('\n'),
        });

        expect(parsed.diagnostics).toEqual([]);
        expect(parsed.preview?.projects).toEqual([{ name: '办公', taskCount: 6 }]);
        expect(parsed.parsedData?.tasks).toMatchObject([
            { title: '采购', description: '收到后再确认', tags: ['#采购', '#工程'], priority: 'high', status: 'waiting', startTime: '2026-11-22', dueDate: '2026-11-24' },
            { title: '旅行', priority: 'low', status: 'someday', startTime: undefined, dueDate: undefined },
            { title: '回访', priority: 'medium', status: 'done' },
            { title: '整理', status: 'next' },
            { title: '寄送', status: 'done' },
            { title: '修理', status: 'inbox' },
        ]);
    });

    it('warns by row and column about ambiguous or impossible dates and keeps unambiguous dates', () => {
        const parsed = parseImportSource('microsoft-todo', {
            fileName: 'Tasks.csv',
            text: [
                'Subject,Start Date,Due Date,Status',
                'Ambiguous,01/02/2026,2026-02-29,unknown',
                '',
                'Known,24/3/2026,3/26/2026,Not Started',
                'Impossible,2026-07-19T24:00,2026-07-20T05:00+99:00,2',
            ].join('\n'),
        });

        expect(parsed.parsedData?.tasks).toMatchObject([
            { title: 'Ambiguous', startTime: undefined, dueDate: undefined, status: 'inbox' },
            { title: 'Known', startTime: '2026-03-24', dueDate: '2026-03-26' },
            { title: 'Impossible', startTime: undefined, dueDate: undefined, status: 'done' },
        ]);
        expect(parsed.diagnostics).toEqual([
            { code: 'unmapped-date', params: { count: 4, locations: '0:2:2,0:2:3,0:5:2,0:5:3', omittedLocations: 0 }, severity: 'warning' },
            { code: 'unmapped-status', params: { count: 1 }, severity: 'warning' },
        ]);
    });

    it.each([
        ['calendar', 'Subject,Start Date,End Date,Categories\nAppointment,2026-11-21,2026-11-21,Work'],
        ['contacts', 'First Name,Last Name,Notes\nAda,Lovelace,Note'],
        ['mail', 'Subject,From,Due Date\nMessage,Ada,2026-11-21'],
        ['generic', 'Title,Status\nTask,next'],
        ['broken', 'Subject,Status,Notes\nTask,Not Started,"Unclosed'],
    ])('rejects a %s CSV as a Tasks import', (_, text) => {
        const parsed = parseImportSource('microsoft-todo', { fileName: 'Tasks.csv', text });
        expect(parsed).toMatchObject({ valid: false, parsedData: null, preview: null });
        expect(parsed.diagnostics[0]?.severity).toBe('error');
    });

    it.each([true, false])('reads UTF-16 byte order with littleEndian=%s', (littleEndian) => {
        const text = '主题,状态\n归档📂,已完成';
        const bytes = new Uint8Array(text.length * 2 + 2);
        const view = new DataView(bytes.buffer);
        view.setUint16(0, 0xfeff, littleEndian);
        for (let index = 0; index < text.length; index += 1) {
            view.setUint16(index * 2 + 2, text.charCodeAt(index), littleEndian);
        }
        const parsed = parseImportSource('microsoft-todo', { fileName: 'Tasks.csv', bytes });
        expect(parsed.parsedData?.tasks).toMatchObject([{ title: '归档📂', status: 'done' }]);
    });

    it('keeps UTF-8 text with a BOM and rejects legacy Windows bytes with an encoding diagnostic', () => {
        const bytes = new TextEncoder().encode('\uFEFFSubject,Status\nCafé,Not Started');
        const parsed = parseImportSource('microsoft-todo', { fileName: 'Tasks.csv', bytes });
        expect(parsed.parsedData?.tasks).toMatchObject([{ title: 'Café' }]);

        const legacyBytes = Uint8Array.from('Subject,Status\nCafé,Not Started', (character) => character.charCodeAt(0));
        const invalid = parseImportSource('microsoft-todo', { fileName: 'Tasks.csv', bytes: legacyBytes });
        expect(invalid.valid).toBe(false);
        expect(invalid.errors[0]).toContain('Re-save the Outlook export as UTF-8 CSV');
        expect(invalid.diagnostics).toEqual([{ code: 'unsupported-text-encoding', params: {}, severity: 'error' }]);
        expect(formatImportDiagnostic(invalid.diagnostics[0], (key) => key)).toBe('settings.importDiagnostics.unsupportedTextEncoding');
    });
});

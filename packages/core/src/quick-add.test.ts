import { afterEach, describe, it, expect } from 'vitest';
import { getTaskDateCoherenceIssues } from './task-date-coherence';
import { configureDateFormatting } from './date';
import type { Person, Task } from './types';
import { buildQuickAddParseOptions, getQuickAddProjectInitialProps, parseProjectNextActionInput, parseQuickAdd, parseQuickAddDateCommands, splitQuickAddBulkLines } from './quick-add';

describe('quick-add', () => {
    it('splits bulk quick-add text into trimmed nonblank lines', () => {
        expect(splitQuickAddBulkLines('  Email Bob  \r\nCall Alice\nReview notes +Work  ')).toEqual([
            'Email Bob',
            'Call Alice',
            'Review notes +Work',
        ]);
        expect(splitQuickAddBulkLines('WeCom message one\r\n  \r\nWeCom message two')).toEqual([
            'WeCom message one WeCom message two',
        ]);
        expect(splitQuickAddBulkLines('One task only')).toEqual(['One task only']);
        expect(splitQuickAddBulkLines(' \n\t\r\n ')).toEqual([]);
    });

    it('parses status, due, note, tags, contexts', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const result = parseQuickAdd('Call mom @phone #family /next /due:tomorrow 5pm /note:ask about trip', undefined, now);

        expect(result.title).toBe('Call mom');
        expect(result.props.status).toBe('next');
        expect(result.props.contexts).toEqual(['@phone']);
        expect(result.props.tags).toEqual(['#family']);
        expect(result.props.description).toBe('ask about trip');
        const expectedLocal = new Date(2025, 0, 2, 17, 0, 0, 0).toISOString();
        expect(result.props.dueDate).toBe(expectedLocal);
    });

    it('leaves an email address alone instead of reading its @ as a context (#1087)', () => {
        const now = new Date('2026-08-27T10:00:00Z');
        const result = parseQuickAdd('Email bob@example.com', undefined, now);

        expect(result.title).toBe('Email bob@example.com');
        expect(result.props.contexts ?? []).toEqual([]);
    });

    it('only opens a context or tag at a word start (#1087)', () => {
        const now = new Date('2026-08-27T10:00:00Z');
        // A marker mid-word belongs to the word: an address, a URL fragment.
        const url = parseQuickAdd('Read https://example.com/docs#install', undefined, now);
        expect(url.title).toBe('Read https://example.com/docs#install');
        expect(url.props.tags ?? []).toEqual([]);

        // A real token still parses when it starts a word, including alongside
        // an address in the same line.
        const mixed = parseQuickAdd('Email bob@example.com @phone #followup', undefined, now);
        expect(mixed.title).toBe('Email bob@example.com');
        expect(mixed.props.contexts).toEqual(['@phone']);
        expect(mixed.props.tags).toEqual(['#followup']);
    });

    it('parses focus quick-add tokens and implies next when no status is supplied', () => {
        const result = parseQuickAdd('Call plumber /* focus');

        expect(result.title).toBe('Call plumber');
        expect(result.props.status).toBe('next');
        expect(result.props.isFocusedToday).toBe(true);
    });

    it('keeps explicit status when parsing focus quick-add tokens', () => {
        const result = parseQuickAdd('Review someday idea /someday /*');

        expect(result.title).toBe('Review someday idea');
        expect(result.props.status).toBe('someday');
        expect(result.props.isFocusedToday).toBe(true);
    });

    it('parses energy quick-add commands', () => {
        const result = parseQuickAdd('Draft proposal /energy:High /next');

        expect(result.title).toBe('Draft proposal');
        expect(result.props.energyLevel).toBe('high');
        expect(result.props.status).toBe('next');
    });

    it('keeps parsing later energy commands after a note', () => {
        const result = parseQuickAdd('Call mom /note:ask about trip /energy:low /next');

        expect(result.title).toBe('Call mom');
        expect(result.props.description).toBe('ask about trip');
        expect(result.props.energyLevel).toBe('low');
        expect(result.props.status).toBe('next');
    });

    it('parses URL notes into the description field', () => {
        const now = new Date('2026-03-30T10:00:00Z');
        const result = parseQuickAdd('Check website /note:https://example.com', undefined, now);

        expect(result.title).toBe('Check website');
        expect(result.props.description).toBe('https://example.com');
    });

    it('keeps parsing later commands after a URL note', () => {
        const now = new Date('2026-03-30T10:00:00Z');
        const result = parseQuickAdd('Check website /note:https://example.com /next', undefined, now);

        expect(result.title).toBe('Check website');
        expect(result.props.description).toBe('https://example.com');
        expect(result.props.status).toBe('next');
    });

    it('parses a link command into a link attachment without consuming later commands', () => {
        const now = new Date('2026-03-30T10:00:00Z');
        const result = parseQuickAdd(
            'Read source /link:https://example.com/docs#section /next @desk',
            undefined,
            now
        );

        expect(result.title).toBe('Read source');
        expect(result.props.status).toBe('next');
        expect(result.props.contexts).toEqual(['@desk']);
        expect(result.props.tags).toBeUndefined();
        expect(result.props.attachments).toEqual([
            expect.objectContaining({
                createdAt: now.toISOString(),
                kind: 'link',
                title: 'example.com/docs',
                updatedAt: now.toISOString(),
                uri: 'https://example.com/docs#section',
            }),
        ]);
        expect(result.props.attachments?.[0]?.id).toEqual(expect.any(String));
    });

    it('keeps URI-style link commands as lightweight link attachments', () => {
        const now = new Date('2026-03-30T10:00:00Z');
        const result = parseQuickAdd(
            'Email Alex /link:mailto:alex@example.com /note:Ask for the update',
            undefined,
            now
        );

        expect(result.title).toBe('Email Alex');
        expect(result.props.contexts).toBeUndefined();
        expect(result.props.description).toBe('Ask for the update');
        expect(result.props.attachments?.[0]).toEqual(expect.objectContaining({
            kind: 'link',
            title: 'alex@example.com',
            uri: 'mailto:alex@example.com',
        }));
    });

    it('supports labeled link commands', () => {
        const now = new Date('2026-03-30T10:00:00Z');
        const result = parseQuickAdd('Review plan /link:Sprint Plan | https://example.com/doc', undefined, now);

        expect(result.title).toBe('Review plan');
        expect(result.props.attachments?.[0]).toEqual(expect.objectContaining({
            kind: 'link',
            title: 'Sprint Plan',
            uri: 'https://example.com/doc',
        }));
    });

    it('keeps due commands date-only when no time is explicit', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const result = parseQuickAdd(
            'Review proposal /start:tomorrow /review:friday /due:next week',
            undefined,
            now
        );

        expect(result.title).toBe('Review proposal');
        expect(result.props.startTime).toBe('2025-01-02');
        expect(result.props.reviewAt).toBe('2025-01-03');
        expect(result.props.dueDate).toBe('2025-01-08');
    });

    it('uses default schedule time for start and review commands without explicit time', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const result = parseQuickAdd(
            'Review proposal /start:tomorrow /review:friday /due:next week',
            undefined,
            now,
            undefined,
            { defaultScheduleTime: '09:30' },
        );

        const relativeResult = parseQuickAdd('Task /start: 1d', undefined, now, undefined, {
            defaultScheduleTime: '09:30',
        });

        expect(result.title).toBe('Review proposal');
        expect(result.props.startTime).toBe(new Date(2025, 0, 2, 9, 30, 0, 0).toISOString());
        expect(result.props.reviewAt).toBe(new Date(2025, 0, 3, 9, 30, 0, 0).toISOString());
        expect(result.props.dueDate).toBe('2025-01-08');
        expect(relativeResult.props.startTime).toBe(new Date(2025, 0, 2, 9, 30, 0, 0).toISOString());
    });

    it('keeps explicit quick-add times ahead of the default schedule time', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const result = parseQuickAdd(
            'Review proposal /start:tomorrow 2:15pm /review:friday 11am',
            undefined,
            now,
            undefined,
            { defaultScheduleTime: '09:30' },
        );

        expect(result.props.startTime).toBe(new Date(2025, 0, 2, 14, 15, 0, 0).toISOString());
        expect(result.props.reviewAt).toBe(new Date(2025, 0, 3, 11, 0, 0, 0).toISOString());
    });

    it('parses abbreviated weekday commands like /start:mon', () => {
        const now = new Date('2026-02-27T09:40:00Z');
        const result = parseQuickAdd('Task /start:mon', undefined, now);
        expect(result.props.startTime).toBe('2026-03-02');
        expect(result.invalidDateCommands).toBeUndefined();
    });

    it('exposes date incoherence from parsed quick-add dates without changing the dates', () => {
        const now = new Date('2026-04-20T09:40:00Z');
        const result = parseQuickAdd('Task /due:tomorrow /start:friday', undefined, now);

        expect(result.props.dueDate).toBe('2026-04-21');
        expect(result.props.startTime).toBe('2026-04-24');
        expect(getTaskDateCoherenceIssues(result.props)).toEqual([{
            code: 'start_after_due',
            field: 'startTime',
            relatedField: 'dueDate',
        }]);
    });

    it('reports invalid date commands instead of silently dropping them', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const result = parseQuickAdd('Task /start:monx /due:tomorrow', undefined, now);
        expect(result.invalidDateCommands).toEqual(['/start:monx']);
        expect(result.props.startTime).toBeUndefined();
        expect(result.props.dueDate).toBe('2025-01-02');
    });

    it('parses date commands without stripping unrelated quick-add tokens', () => {
        const now = new Date('2026-04-13T10:00:00Z');
        const result = parseQuickAddDateCommands(
            'Review talk @school #urgent /start:tomorrow /due:friday 2pm /review:next monday',
            now
        );

        expect(result.title).toBe('Review talk @school #urgent');
        expect(result.props.startTime).toBe('2026-04-14');
        expect(result.props.dueDate).toBe(new Date(2026, 3, 17, 14, 0, 0, 0).toISOString());
        expect(result.props.reviewAt).toBe('2026-04-20');
    });

    it('keeps invalid date commands in the title-only parser output', () => {
        const now = new Date('2026-04-13T10:00:00Z');
        const result = parseQuickAddDateCommands('Task /due:2026-04-31', now);

        expect(result.title).toBe('Task /due:2026-04-31');
        expect(result.invalidDateCommands).toEqual(['/due:2026-04-31']);
        expect(result.props.dueDate).toBeUndefined();
    });

    it('parses relative due dates with numbers without treating numbers as time tokens', () => {
        const now = new Date('2026-03-01T10:30:00Z');
        const result = parseQuickAdd('Task /due:in 3 days', undefined, now);
        expect(result.invalidDateCommands).toBeUndefined();
        expect(result.props.dueDate).toBe('2026-03-04');
    });

    it('parses ISO due dates as date-only without corrupting the date token', () => {
        const now = new Date('2026-03-01T10:30:00Z');
        const result = parseQuickAdd('Task /due:2026-03-15', undefined, now);
        expect(result.invalidDateCommands).toBeUndefined();
        expect(result.props.dueDate).toBe('2026-03-15');
    });

    it('parses richer chrono expressions in explicit date commands', () => {
        const now = new Date('2026-04-06T10:00:00Z');
        const result = parseQuickAdd('Call dentist /due:next friday at 3pm', undefined, now);

        expect(result.invalidDateCommands).toBeUndefined();
        expect(result.props.dueDate).toBe(new Date(2026, 3, 17, 15, 0, 0, 0).toISOString());
    });

    it('keeps explicit calendar due dates date-only without a time', () => {
        const now = new Date('2026-02-01T10:00:00Z');
        const result = parseQuickAdd('Submit report /due:march 15', undefined, now);

        expect(result.invalidDateCommands).toBeUndefined();
        expect(result.props.dueDate).toBe('2026-03-15');
    });

    it('detects a trailing natural-language due date without auto-applying it in core', () => {
        const now = new Date('2026-04-06T10:00:00Z');
        const result = parseQuickAdd('Call mom tomorrow at 3pm @phone /next', undefined, now);

        expect(result.title).toBe('Call mom tomorrow at 3pm');
        expect(result.props.status).toBe('next');
        expect(result.props.contexts).toEqual(['@phone']);
        expect(result.props.dueDate).toBeUndefined();
        expect(result.detectedDate).toEqual({
            date: new Date(2026, 3, 7, 15, 0, 0, 0).toISOString(),
            matchedText: 'tomorrow at 3pm',
            titleWithoutDate: 'Call mom',
        });
    });

    it('does not auto-detect dates from the middle of the title', () => {
        const now = new Date('2026-04-06T10:00:00Z');
        const result = parseQuickAdd('Call March about the report', undefined, now);

        expect(result.title).toBe('Call March about the report');
        expect(result.detectedDate).toBeUndefined();
    });

    it('does not auto-detect pure time-only suffixes', () => {
        const now = new Date('2026-04-06T10:00:00Z');
        const result = parseQuickAdd('Task at 3', undefined, now);

        expect(result.title).toBe('Task at 3');
        expect(result.detectedDate).toBeUndefined();
    });

    it('does not auto-detect when the entire title is just a date phrase', () => {
        const now = new Date('2026-04-06T10:00:00Z');
        const result = parseQuickAdd('tomorrow', undefined, now);

        expect(result.title).toBe('tomorrow');
        expect(result.detectedDate).toBeUndefined();
    });

    it('does not auto-detect bare month names at the end of the title', () => {
        const now = new Date('2026-04-06T10:00:00Z');
        const result = parseQuickAdd('Call March', undefined, now);

        expect(result.title).toBe('Call March');
        expect(result.detectedDate).toBeUndefined();
    });

    it('strips unicode dashes before an auto-detected trailing date', () => {
        const now = new Date('2026-04-16T10:00:00Z');
        const result = parseQuickAdd('Tax deadline — April 15', undefined, now);

        expect(result.detectedDate).toEqual({
            date: '2027-04-15',
            matchedText: 'April 15',
            titleWithoutDate: 'Tax deadline',
        });
    });

    it('skips trailing NLP detection when an explicit due command is present', () => {
        const now = new Date('2026-04-06T10:00:00Z');
        const result = parseQuickAdd('Call mom tomorrow /due:friday', undefined, now);

        expect(result.props.dueDate).toBe('2026-04-10');
        expect(result.detectedDate).toBeUndefined();
        expect(result.title).toBe('Call mom tomorrow');
    });

    // #742 (2026-07-16 comment): naturalLanguageDates governs BARE phrase
    // detection only. Matrix: {toggle on, toggle off} x {preserveText on,
    // off} x {bare NL phrase, explicit /due:NL-value, @context + #tag, plain
    // title}.
    // Ambiguous slash dates follow the active date-format setting: `/due:10/8`
    // is August 10 under d/m/y, October 8 under m/d/y (#1006).
    describe('slash dates follow the date format setting (#1006)', () => {
        afterEach(() => {
            configureDateFormatting({});
        });

        it('parses day-first under the dmy setting', () => {
            configureDateFormatting({ dateFormat: 'dmy' });
            const now = new Date('2026-08-04T10:00:00');
            const result = parseQuickAdd('Pay rent /due:10/8', undefined, now);
            expect(result.props.dueDate).toContain('2026-08-10');
        });

        it('parses month-first under the mdy setting', () => {
            configureDateFormatting({ dateFormat: 'mdy' });
            const now = new Date('2026-08-04T10:00:00');
            const result = parseQuickAdd('Pay rent /due:10/8', undefined, now);
            expect(result.props.dueDate).toContain('2026-10-08');
        });

        it('applies day-first to trailing title dates too', () => {
            configureDateFormatting({ dateFormat: 'dmy' });
            const now = new Date('2026-08-04T10:00:00');
            const result = parseQuickAdd('Pay rent 10/8', undefined, now);
            expect(result.detectedDate?.date ?? result.props.dueDate).toContain('2026-08-10');
        });

        it('keeps unambiguous dot dates day-first in both modes', () => {
            configureDateFormatting({ dateFormat: 'mdy' });
            const now = new Date('2026-08-04T10:00:00');
            const result = parseQuickAdd('Pay rent /due:10.08.', undefined, now);
            expect(result.props.dueDate).toContain('2026-08-10');
        });
    });

    // #1059: quick-add's natural-language date parsing uses chrono-node's
    // locale parsers for the app languages chrono supports, keyed off the
    // active app language, always falling back to the English parser so an
    // English phrase still works no matter the UI language.
    describe('locale-aware natural language dates (#1059)', () => {
        afterEach(() => {
            configureDateFormatting({});
        });

        it('detects a French bare date phrase', () => {
            configureDateFormatting({ language: 'fr' });
            const now = new Date('2026-08-04T10:00:00');
            const result = parseQuickAdd('Appeler le dentiste vendredi prochain', undefined, now);
            expect(result.detectedDate?.matchedText).toBe('vendredi prochain');
            expect(result.detectedDate?.titleWithoutDate).toBe('Appeler le dentiste');
        });

        it('detects a German bare date phrase', () => {
            configureDateFormatting({ language: 'de' });
            const now = new Date('2026-08-04T10:00:00');
            const result = parseQuickAdd('Zahnarzt anrufen nächsten Freitag', undefined, now);
            expect(result.detectedDate?.date).toBeTruthy();
            expect(result.detectedDate?.titleWithoutDate).toBe('Zahnarzt anrufen');
        });

        it('detects a Spanish bare date phrase', () => {
            configureDateFormatting({ language: 'es' });
            const now = new Date('2026-08-04T10:00:00');
            const result = parseQuickAdd('Llamar al dentista el próximo viernes', undefined, now);
            expect(result.detectedDate?.matchedText).toBe('próximo viernes');
            expect(result.detectedDate?.titleWithoutDate).toBe('Llamar al dentista');
        });

        // The es/fr/pt/it chrono parsers leave the preposition and article that
        // introduce a date out of the match, so the cleaned title used to keep a
        // dangling "el"/"le"/"no dia"/"il".
        it('drops the date-introducing words the Romance parsers exclude', () => {
            const now = new Date('2026-08-04T10:00:00');
            const cases: Array<{ language: 'es' | 'fr' | 'pt' | 'it'; input: string; title: string }> = [
                { language: 'es', input: 'Revisar informe el lunes', title: 'Revisar informe' },
                { language: 'es', input: 'Enviar informe para el 5 de septiembre', title: 'Enviar informe' },
                { language: 'fr', input: 'Revoir le rapport le lundi', title: 'Revoir le rapport' },
                { language: 'fr', input: 'Payer le loyer pour le 5 septembre', title: 'Payer le loyer' },
                { language: 'fr', input: 'Réunion au 12 septembre', title: 'Réunion' },
                { language: 'pt', input: 'Pagar aluguel no dia 5 de setembro', title: 'Pagar aluguel' },
                { language: 'pt', input: 'Revisar relatório na próxima segunda', title: 'Revisar relatório' },
                { language: 'it', input: 'Pagare affitto il 10 settembre', title: 'Pagare affitto' },
                { language: 'it', input: 'Rivedere report il prossimo lunedì', title: 'Rivedere report' },
                { language: 'it', input: 'Riunione per domani', title: 'Riunione' },
            ];
            for (const { language, input, title } of cases) {
                configureDateFormatting({ language });
                const result = parseQuickAdd(input, undefined, now);
                expect(result.detectedDate?.date, input).toBeTruthy();
                expect(result.detectedDate?.titleWithoutDate, input).toBe(title);
            }
        });

        it('keeps title words that only look like date-introducing words', () => {
            const now = new Date('2026-08-04T10:00:00');
            const cases: Array<{ language: 'es' | 'fr' | 'pt' | 'it'; input: string; title: string }> = [
                { language: 'es', input: 'Comprar leche del super mañana', title: 'Comprar leche del super' },
                { language: 'es', input: 'Preparar la charla para el equipo mañana', title: 'Preparar la charla para el equipo' },
                { language: 'fr', input: 'Acheter du pain demain', title: 'Acheter du pain' },
                { language: 'pt', input: 'Comprar pão amanhã', title: 'Comprar pão' },
            ];
            for (const { language, input, title } of cases) {
                configureDateFormatting({ language });
                const result = parseQuickAdd(input, undefined, now);
                expect(result.detectedDate?.titleWithoutDate, input).toBe(title);
            }
        });

        it('resolves a Simplified Chinese /due: command', () => {
            configureDateFormatting({ language: 'zh' });
            const now = new Date('2026-08-04T10:00:00');
            const result = parseQuickAddDateCommands('Buy groceries /due:明天', now);
            expect(result.props.dueDate).toBe('2026-08-05');
        });

        it('falls back to the English parser for an English phrase under a French UI', () => {
            configureDateFormatting({ language: 'fr' });
            const now = new Date('2026-08-04T10:00:00');
            const result = parseQuickAdd('Call dentist tomorrow', undefined, now);
            expect(result.detectedDate?.matchedText).toBe('tomorrow');
            expect(result.detectedDate?.titleWithoutDate).toBe('Call dentist');
        });

        it('does not auto-detect a bare month name under French', () => {
            configureDateFormatting({ language: 'fr' });
            const now = new Date('2026-08-04T10:00:00');
            const result = parseQuickAdd('Réunion budget mai', undefined, now);
            expect(result.title).toBe('Réunion budget mai');
            expect(result.detectedDate).toBeUndefined();
        });

        // Unlike fr, chrono's Italian parser DOES match a bare trailing month
        // name, so this exercises the localized bare-month skip itself.
        it('skips a bare Italian month name the locale parser matches', () => {
            configureDateFormatting({ language: 'it' });
            const now = new Date('2026-08-04T10:00:00');
            const result = parseQuickAdd('Rivedere budget maggio', undefined, now);
            expect(result.title).toBe('Rivedere budget maggio');
            expect(result.detectedDate).toBeUndefined();
        });

        // Russian inflects months inside dates ("января", genitive) differently
        // from the standalone form ("январь") the locale table lists first —
        // chrono.ru matches the inflected form, so the skip must cover it too.
        it('skips inflected Russian bare month names', () => {
            configureDateFormatting({ language: 'ru' });
            const now = new Date('2026-08-04T10:00:00');
            for (const title of ['Отчет января', 'Отчет мар.', 'Отчет январь']) {
                const result = parseQuickAdd(title, undefined, now);
                expect(result.detectedDate).toBeUndefined();
                expect(result.title).toBe(title);
            }
        });

        it('keeps unsupported-locale UI languages English-only', () => {
            configureDateFormatting({ language: 'pl' });
            const now = new Date('2026-08-04T10:00:00');
            const english = parseQuickAdd('Call dentist tomorrow', undefined, now);
            expect(english.detectedDate?.matchedText).toBe('tomorrow');
            expect(english.detectedDate?.titleWithoutDate).toBe('Call dentist');

            const polish = parseQuickAdd('Zadzwon do dentysty jutro', undefined, now);
            expect(polish.detectedDate).toBeUndefined();
            expect(polish.title).toBe('Zadzwon do dentysty jutro');
        });

        it('resolves a French /due: command with a locale date word', () => {
            configureDateFormatting({ language: 'fr' });
            const now = new Date('2026-08-04T10:00:00');
            const result = parseQuickAddDateCommands('Payer le loyer /due:demain', now);
            expect(result.props.dueDate).toBe('2026-08-05');
        });

        it('keeps the dot-date parser on the locale chrono instance', () => {
            configureDateFormatting({ language: 'fr' });
            const now = new Date('2026-08-04T10:00:00');
            const result = parseQuickAddDateCommands('Payer le loyer /due:26.08.2026', now);
            expect(result.props.dueDate).toBe('2026-08-26');
        });

        it('naturalLanguageDates: false still suppresses bare detection under French', () => {
            configureDateFormatting({ language: 'fr' });
            const now = new Date('2026-08-04T10:00:00');
            const result = parseQuickAdd(
                'Appeler le dentiste vendredi prochain',
                undefined,
                now,
                undefined,
                { naturalLanguageDates: false },
            );
            expect(result.detectedDate).toBeUndefined();
            expect(result.title).toBe('Appeler le dentiste vendredi prochain');
        });
    });

    // A purely numeric date carries no locale signal, so the date-format
    // setting decides it in every language, not the locale parser's own
    // convention (#1006 x #1059) — chrono's locale bundles ship one numeric
    // order each (day-first for de/es/fr/pt, month-first for it/ja).
    describe('locale numeric dates follow the date format setting', () => {
        afterEach(() => {
            configureDateFormatting({});
        });

        it('reads a day-first locale month-first under the mdy setting', () => {
            configureDateFormatting({ language: 'de', dateFormat: 'mdy' });
            const now = new Date('2026-08-04T10:00:00');
            expect(parseQuickAdd('Miete zahlen /due:10/8', undefined, now).props.dueDate).toContain('2026-10-08');
            expect(parseQuickAdd('Miete zahlen 10/8', undefined, now).detectedDate?.date).toContain('2026-10-08');
        });

        it('keeps a day-first locale day-first under the dmy setting', () => {
            configureDateFormatting({ language: 'fr', dateFormat: 'dmy' });
            const now = new Date('2026-08-04T10:00:00');
            expect(parseQuickAdd('Payer le loyer /due:10/8', undefined, now).props.dueDate).toContain('2026-08-10');
            expect(parseQuickAdd('Payer le loyer 10/8', undefined, now).detectedDate?.date).toContain('2026-08-10');
        });

        // The English instances resolve these, but the title cleanup still
        // belongs to the active language.
        it('still drops the date-introducing word ahead of a numeric date', () => {
            const now = new Date('2026-08-04T10:00:00');
            const cases: Array<{ language: 'es' | 'fr' | 'pt' | 'it'; input: string; title: string }> = [
                { language: 'es', input: 'Llamar al dentista el 10/8', title: 'Llamar al dentista' },
                { language: 'fr', input: 'Payer le loyer le 10/8', title: 'Payer le loyer' },
                { language: 'pt', input: 'Pagar aluguel no dia 10/8', title: 'Pagar aluguel' },
                { language: 'it', input: 'Pagare affitto il 10/8', title: 'Pagare affitto' },
            ];
            for (const { language, input, title } of cases) {
                configureDateFormatting({ language });
                const result = parseQuickAdd(input, undefined, now);
                expect(result.detectedDate?.titleWithoutDate, input).toBe(title);
            }
        });

        it('reads a month-first locale day-first under the dmy setting', () => {
            configureDateFormatting({ language: 'it', dateFormat: 'dmy' });
            const now = new Date('2026-08-04T10:00:00');
            expect(parseQuickAdd('Pagare affitto /due:10/8', undefined, now).props.dueDate).toContain('2026-08-10');
            expect(parseQuickAdd('Pagare affitto 10/8', undefined, now).detectedDate?.date).toContain('2026-08-10');
        });

        it('still parses word-based locale phrases under either setting', () => {
            const now = new Date('2026-08-04T10:00:00');
            for (const dateFormat of ['mdy', 'dmy'] as const) {
                configureDateFormatting({ language: 'de', dateFormat });
                const bare = parseQuickAdd('Zahnarzt anrufen nächsten Freitag', undefined, now);
                expect(bare.detectedDate?.date, dateFormat).toContain('2026-08-14');
                configureDateFormatting({ language: 'fr', dateFormat });
                const command = parseQuickAddDateCommands('Payer le loyer /due:demain', now);
                expect(command.props.dueDate, dateFormat).toBe('2026-08-05');
            }
        });
    });

    describe('naturalLanguageDates toggle', () => {
        const now = new Date('2026-07-16T10:00:00Z');

        it('toggle on, preserveText off: bare phrase is detected (default behavior unchanged)', () => {
            const result = parseQuickAdd('Register for the race next week', undefined, now);

            expect(result.title).toBe('Register for the race next week');
            expect(result.props.dueDate).toBeUndefined();
            expect(result.detectedDate).toBeDefined();
            expect(result.detectedDate?.titleWithoutDate).toBe('Register for the race');
        });

        it('toggle off, preserveText off: bare phrase stays literal, no detected date', () => {
            const result = parseQuickAdd('Register for the race next week', undefined, now, undefined, {
                naturalLanguageDates: false,
            });

            expect(result.title).toBe('Register for the race next week');
            expect(result.props.dueDate).toBeUndefined();
            expect(result.detectedDate).toBeUndefined();
        });

        it('toggle off, preserveText on: bare phrase stays literal, no detected date', () => {
            const result = parseQuickAdd('Register for the race next week', undefined, now, undefined, {
                naturalLanguageDates: false,
                preserveText: true,
            });

            expect(result.title).toBe('Register for the race next week');
            expect(result.props.dueDate).toBeUndefined();
            expect(result.detectedDate).toBeUndefined();
        });

        it('toggle on, preserveText on: date is detected and applies, title stays as-typed (Reddit report: quick capture saved "do this jun 26 10am" verbatim with no date)', () => {
            const result = parseQuickAdd('Register for the race next week', undefined, now, undefined, {
                preserveText: true,
            });

            expect(result.title).toBe('Register for the race next week');
            expect(result.detectedDate).toBeDefined();
            // Preserve mode applies the date but never strips the text: the
            // consumer-facing titleWithoutDate is the verbatim title.
            expect(result.detectedDate?.titleWithoutDate).toBe('Register for the race next week');
        });

        it('preserveText on: explicit /due: still wins over detection', () => {
            const result = parseQuickAdd('Register next week /due:friday', undefined, now, undefined, {
                preserveText: true,
            });

            expect(result.props.dueDate).toBeDefined();
            expect(result.detectedDate).toBeUndefined();
        });

        it('toggle off: explicit /due:<natural language> still parses', () => {
            const result = parseQuickAdd('Register for the race /due:next week', undefined, now, undefined, {
                naturalLanguageDates: false,
            });

            expect(result.title).toBe('Register for the race');
            expect(result.props.dueDate).toBeDefined();
            expect(result.invalidDateCommands).toBeUndefined();
        });

        it('toggle off: explicit @context and #tag tokens still parse and strip', () => {
            const result = parseQuickAdd('Call mom @phone #family', undefined, now, undefined, {
                naturalLanguageDates: false,
            });

            expect(result.title).toBe('Call mom');
            expect(result.props.contexts).toEqual(['@phone']);
            expect(result.props.tags).toEqual(['#family']);
        });

        it('toggle off: a plain title with no dates or tokens is unaffected', () => {
            const result = parseQuickAdd('Buy milk', undefined, now, undefined, {
                naturalLanguageDates: false,
            });

            expect(result.title).toBe('Buy milk');
            expect(result.props.dueDate).toBeUndefined();
            expect(result.detectedDate).toBeUndefined();
        });

        it('unset naturalLanguageDates keeps current (on) behavior byte-for-byte', () => {
            const withUnset = parseQuickAdd('Register for the race next week', undefined, now);
            const withExplicitTrue = parseQuickAdd('Register for the race next week', undefined, now, undefined, {
                naturalLanguageDates: true,
            });

            expect(withUnset).toEqual(withExplicitTrue);
        });
    });

    it('matches project by title when provided', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const projects = [
            {
                id: 'p1',
                title: 'MyProject',
                status: 'active',
                color: '#000000',
                tagIds: [],
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            },
        ];

        const result = parseQuickAdd('Write spec +MyProject', projects as any, now);
        expect(result.title).toBe('Write spec');
        expect(result.props.projectId).toBe('p1');
        expect(result.projectTitle).toBeUndefined();
    });

    it('does not match archived projects by title', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const projects = [{
            id: 'p1',
            title: 'OldProject',
            status: 'archived',
            color: '#000000',
            order: 0,
            tagIds: [],
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
        }];

        const result = parseQuickAdd('Write spec +OldProject', projects as any, now);
        expect(result.title).toBe('Write spec');
        expect(result.props.projectId).toBeUndefined();
        expect(result.projectTitle).toBe('OldProject');
    });

    it('captures project title when project is missing', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const projects = [
            {
                id: 'p1',
                title: 'Existing',
                status: 'active',
                color: '#000000',
                tagIds: [],
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            },
        ];

        const result = parseQuickAdd('Draft outline +NewProject', projects as any, now);
        expect(result.title).toBe('Draft outline');
        expect(result.props.projectId).toBeUndefined();
        expect(result.projectTitle).toBe('NewProject');
    });

    it('captures multi-word project titles', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const projects = [
            {
                id: 'p1',
                title: 'Project Name',
                status: 'active',
                color: '#000000',
                tagIds: [],
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            },
        ];

        const result = parseQuickAdd('Plan roadmap +Project Name /next', projects as any, now);
        expect(result.title).toBe('Plan roadmap');
        expect(result.props.projectId).toBe('p1');
        expect(result.projectTitle).toBeUndefined();
    });

    it('matches area by name when provided', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const areas = [
            { id: 'a1', name: 'Work', color: '#111111', order: 0, createdAt: now.toISOString(), updatedAt: now.toISOString() },
            { id: 'a2', name: 'Personal', color: '#222222', order: 1, createdAt: now.toISOString(), updatedAt: now.toISOString() },
        ];

        const result = parseQuickAdd('Draft report !Work /next', undefined, now, areas as any);
        expect(result.title).toBe('Draft report');
        expect(result.props.areaId).toBe('a1');

        const explicitResult = parseQuickAdd('Plan budget /area:Personal /next', undefined, now, areas as any);
        expect(explicitResult.title).toBe('Plan budget');
        expect(explicitResult.props.areaId).toBe('a2');
    });

    it('matches an existing multi-word project and keeps trailing words in the title', () => {
        const now = new Date('2026-07-03T10:00:00Z');
        const projects = [
            { id: 'p1', title: 'My Project', status: 'active', color: '#000000', tagIds: [], order: 0, createdAt: now.toISOString(), updatedAt: now.toISOString() },
            { id: 'p2', title: 'My Project Extended', status: 'active', color: '#000000', tagIds: [], order: 1, createdAt: now.toISOString(), updatedAt: now.toISOString() },
        ];

        const trailing = parseQuickAdd('buy milk +My Project this week', projects as any, now);
        expect(trailing.props.projectId).toBe('p1');
        expect(trailing.projectTitle).toBeUndefined();
        expect(trailing.title).toContain('this week');

        const longest = parseQuickAdd('review +My Project Extended cleanup', projects as any, now);
        expect(longest.props.projectId).toBe('p2');
        expect(longest.title).toBe('review cleanup');

        const leading = parseQuickAdd('+My Project buy milk', projects as any, now);
        expect(leading.props.projectId).toBe('p1');
        expect(leading.title).toBe('buy milk');
    });

    it('matches an existing multi-word area and keeps trailing words in the title', () => {
        const now = new Date('2026-07-03T10:00:00Z');
        const areas = [
            { id: 'a1', name: 'Work', color: '#111111', order: 0, createdAt: now.toISOString(), updatedAt: now.toISOString() },
            { id: 'a2', name: 'Home Stuff', color: '#222222', order: 1, createdAt: now.toISOString(), updatedAt: now.toISOString() },
        ];

        const single = parseQuickAdd('buy milk !Work call bob', undefined, now, areas as any);
        expect(single.props.areaId).toBe('a1');
        expect(single.title).toBe('buy milk call bob');

        const multi = parseQuickAdd('plan !Home Stuff shelf build', undefined, now, areas as any);
        expect(multi.props.areaId).toBe('a2');
        expect(multi.title).toBe('plan shelf build');
    });

    it('leaves an unmatched area token in the text instead of swallowing it', () => {
        const now = new Date('2026-07-03T10:00:00Z');
        const areas = [
            { id: 'a1', name: 'Work', color: '#111111', order: 0, createdAt: now.toISOString(), updatedAt: now.toISOString() },
        ];

        const result = parseQuickAdd('buy milk !Nowhere extra words', undefined, now, areas as any);
        expect(result.props.areaId).toBeUndefined();
        expect(result.title).toBe('buy milk !Nowhere extra words');
    });

    it('supports quoted project and area names for explicit delimiting', () => {
        const now = new Date('2026-07-03T10:00:00Z');
        const projects = [
            { id: 'p1', title: 'My Project', status: 'active', color: '#000000', tagIds: [], order: 0, createdAt: now.toISOString(), updatedAt: now.toISOString() },
        ];
        const areas = [
            { id: 'a2', name: 'Home Stuff', color: '#222222', order: 1, createdAt: now.toISOString(), updatedAt: now.toISOString() },
        ];

        const createQuoted = parseQuickAdd('task +"Brand New Proj" more words', projects as any, now);
        expect(createQuoted.projectTitle).toBe('Brand New Proj');
        expect(createQuoted.title).toBe('task more words');

        const matchQuoted = parseQuickAdd('task +"My Project" more words', projects as any, now);
        expect(matchQuoted.props.projectId).toBe('p1');
        expect(matchQuoted.title).toBe('task more words');

        const areaQuoted = parseQuickAdd('task !"Home Stuff" more words', undefined, now, areas as any);
        expect(areaQuoted.props.areaId).toBe('a2');
        expect(areaQuoted.title).toBe('task more words');
    });

    it('parses a person token into assignedTo', () => {
        const now = new Date('2026-07-11T10:00:00Z');
        const result = parseQuickAdd('Ask %Jim for the budget /waiting', undefined, now);

        expect(result.title).toBe('Ask for the budget');
        expect(result.props.assignedTo).toBe('Jim');
        expect(result.props.status).toBe('waiting');
    });

    it('matches known multi-word people and keeps trailing words in the title', () => {
        const now = new Date('2026-07-11T10:00:00Z');
        const result = parseQuickAdd(
            'Follow up %Jim Smith about budget',
            undefined,
            now,
            undefined,
            { knownPeople: ['Jim Smith'] },
        );

        expect(result.props.assignedTo).toBe('Jim Smith');
        expect(result.title).toBe('Follow up about budget');
    });

    it('uses the canonical person name casing for known people', () => {
        const now = new Date('2026-07-11T10:00:00Z');
        const result = parseQuickAdd(
            'Ping %jim smith today',
            undefined,
            now,
            undefined,
            { knownPeople: ['Jim Smith'] },
        );

        expect(result.props.assignedTo).toBe('Jim Smith');
    });

    it('takes only the first word for unknown person names', () => {
        const now = new Date('2026-07-11T10:00:00Z');
        const result = parseQuickAdd('Ask %Jim Smith for report', undefined, now);

        expect(result.props.assignedTo).toBe('Jim');
        expect(result.title).toBe('Ask Smith for report');
    });

    it('parses European dot dates with a trailing dot or a year, day-first', () => {
        const now = new Date('2026-07-22T12:00:00');

        const trailingDot = parseQuickAdd('Pay rent 26.06.', undefined, now);
        expect(trailingDot.detectedDate?.date).toBe('2027-06-26');
        expect(trailingDot.detectedDate?.matchedText).toBe('26.06.');
        expect(trailingDot.detectedDate?.titleWithoutDate).toBe('Pay rent');

        const withYear = parseQuickAdd('Pay rent 26.06.2026', undefined, now);
        expect(withYear.detectedDate?.date).toBe('2026-06-26');

        const singleDigits = parseQuickAdd('Miete zahlen 1.7.', undefined, now);
        expect(singleDigits.detectedDate?.date).toBe('2027-07-01');

        const explicitCommand = parseQuickAdd('Task /due:26.06.', undefined, now);
        expect(explicitCommand.props.dueDate).toBe('2027-06-26');

        const withTime = parseQuickAdd('Pay rent 26.06. 18:00', undefined, now);
        expect(withTime.detectedDate?.date).toBe(new Date(2027, 5, 26, 18, 0, 0, 0).toISOString());
    });

    it('never reads version numbers or bare decimals as dot dates', () => {
        const now = new Date('2026-07-22T12:00:00');

        const version = parseQuickAdd('Upgrade to python 3.12', undefined, now);
        expect(version.detectedDate).toBeUndefined();
        expect(version.title).toBe('Upgrade to python 3.12');

        const bareDecimal = parseQuickAdd('Read chapter 26.06', undefined, now);
        expect(bareDecimal.detectedDate).toBeUndefined();

        const invalidMonth = parseQuickAdd('Ship build 26.13.', undefined, now);
        expect(invalidMonth.detectedDate).toBeUndefined();
    });

    it('accepts typographic and mixed quote styles around person names (#849 keyboard smart quotes)', () => {
        const now = new Date('2026-07-22T10:00:00Z');
        const variants = [
            'Task %"Jim Smith" /next',
            'Task %“Jim Smith” /next',
            'Task %“Jim Smith" /next',
            'Task %„Jim Smith" /next',
            "Task %'Jim Smith' /next",
            'Task %’Jim Smith’ /next',
            'Task %‘Jim Smith’ /next',
        ];
        for (const input of variants) {
            const result = parseQuickAdd(input, undefined, now);
            expect(result.props.assignedTo, input).toBe('Jim Smith');
            expect(result.title, input).toBe('Task');
            expect(result.props.status, input).toBe('next');
        }
    });

    it('accepts a closing-glyph opener after the marker (#1094 macOS smart quotes)', () => {
        // macOS smart punctuation sees the marker character before the quote and
        // substitutes the CLOSING glyph for both quotes: %"Jim" becomes %”Jim”.
        const now = new Date('2026-08-27T10:00:00Z');
        for (const input of ['Do something %”my neighbor”', 'Do something %”my neighbor"']) {
            const result = parseQuickAdd(input, undefined, now);
            expect(result.props.assignedTo, input).toBe('my neighbor');
            expect(result.title, input).toBe('Do something');
        }
        const areas = [{ id: 'area-1', name: 'Deep Work' }];
        const area = parseQuickAdd('Task !”Deep Work”', undefined, now, areas as any);
        expect(area.props.areaId).toBe('area-1');
        expect(area.title).toBe('Task');
    });

    it('accepts curly quotes around @/# tokens (#1094)', () => {
        const now = new Date('2026-08-27T10:00:00Z');
        for (const input of ['Call @”deep work” #”home office”', 'Call @“deep work” #“home office”']) {
            const result = parseQuickAdd(input, undefined, now);
            expect(result.props.contexts, input).toEqual(['@deep work']);
            expect(result.props.tags, input).toEqual(['#home office']);
            expect(result.title, input).toBe('Call');
        }
    });

    it('supports quoted person names for explicit delimiting', () => {
        const now = new Date('2026-07-11T10:00:00Z');
        const result = parseQuickAdd('task %"Jane Doe" more words', undefined, now);

        expect(result.props.assignedTo).toBe('Jane Doe');
        expect(result.title).toBe('task more words');
    });

    it('supports macOS smart quotes around person names (#849)', () => {
        const now = new Date('2026-07-22T10:00:00Z');
        const result = parseQuickAdd('Task %“Jim Smith” /next', undefined, now);

        expect(result.title).toBe('Task');
        expect(result.props.assignedTo).toBe('Jim Smith');
        expect(result.props.status).toBe('next');
    });

    it('parses person tokens alongside contexts and tags', () => {
        const now = new Date('2026-07-11T10:00:00Z');
        const result = parseQuickAdd('Ask %Jim @phone #budget', undefined, now);

        expect(result.props.assignedTo).toBe('Jim');
        expect(result.props.contexts).toEqual(['@phone']);
        expect(result.props.tags).toEqual(['#budget']);
        expect(result.title).toBe('Ask');
    });

    it('escapes percent signs so they stay in the title', () => {
        const now = new Date('2026-07-11T10:00:00Z');
        const result = parseQuickAdd('Cut budget by \\%10', undefined, now);

        expect(result.props.assignedTo).toBeUndefined();
        expect(result.title).toBe('Cut budget by %10');
    });

    it('uses parsed area before fallback area when creating a project from quick add', () => {
        expect(getQuickAddProjectInitialProps({ areaId: 'parsed-area' }, 'fallback-area')).toEqual({ areaId: 'parsed-area' });
        expect(getQuickAddProjectInitialProps({}, 'fallback-area')).toEqual({ areaId: 'fallback-area' });
        expect(getQuickAddProjectInitialProps({})).toBeUndefined();
    });

    it('supports unicode tags and contexts', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const result = parseQuickAdd('计划 @工作 #项目 /next', undefined, now);

        expect(result.title).toBe('计划');
        expect(result.props.contexts).toEqual(['@工作']);
        expect(result.props.tags).toEqual(['#项目']);
        expect(result.props.status).toBe('next');
    });

    it('supports emoji-starting tags selected from quick add suggestions', () => {
        const now = new Date('2026-05-19T10:00:00Z');
        const areas = [
            { id: 'a1', name: 'Perso', color: '#111111', order: 0, createdAt: now.toISOString(), updatedAt: now.toISOString() },
        ];

        const result = parseQuickAdd(
            'Inscription to the competition !Perso #🐴 - Horse riding /next',
            undefined,
            now,
            areas as any,
        );

        expect(result.title).toBe('Inscription to the competition');
        expect(result.props.areaId).toBe('a1');
        expect(result.props.tags).toEqual(['#🐴 - Horse riding']);
        expect(result.props.status).toBe('next');
    });

    it('matches the longest existing multi-word tag from quick add tokens', () => {
        const now = new Date('2026-05-19T10:00:00Z');
        const result = parseQuickAdd(
            'Buy headset #home office',
            undefined,
            now,
            undefined,
            { knownTags: ['#home', '#home office'] },
        );

        expect(result.title).toBe('Buy headset');
        expect(result.props.tags).toEqual(['#home office']);
    });

    it('leaves trailing words in the title after a matched multi-word tag', () => {
        const now = new Date('2026-05-19T10:00:00Z');
        const result = parseQuickAdd(
            'Buy headset #home office supplies',
            undefined,
            now,
            undefined,
            { knownTags: ['#home office'] },
        );

        expect(result.title).toBe('Buy headset supplies');
        expect(result.props.tags).toEqual(['#home office']);
    });

    it('supports quoted multi-word tags without known tag lookup', () => {
        const result = parseQuickAdd('Buy headset #"home office"');

        expect(result.title).toBe('Buy headset');
        expect(result.props.tags).toEqual(['#home office']);
    });

    it('keeps unknown unquoted multi-word tags single-word to avoid guessing', () => {
        const result = parseQuickAdd('Buy headset #home office');

        expect(result.title).toBe('Buy headset office');
        expect(result.props.tags).toEqual(['#home']);
    });

    it('keeps simple single-word tags from consuming following title text', () => {
        const now = new Date('2026-05-19T10:00:00Z');
        const result = parseQuickAdd('Email #project stakeholders /next', undefined, now);

        expect(result.title).toBe('Email stakeholders');
        expect(result.props.tags).toEqual(['#project']);
        expect(result.props.status).toBe('next');
    });

    it('preserveText still drops the tokens it applied, whatever the cleanup setting says', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const input = 'Call mom @phone #family /due:tomorrow';
        const result = parseQuickAdd(input, undefined, now, undefined, { preserveText: true });

        // Was 'Call mom @phone #family /due:tomorrow' until a reporter asked why
        // '/next' stayed in the title of the task it had already set to Next.
        expect(result.title).toBe('Call mom');
        expect(result.props.contexts).toEqual(['@phone']);
        expect(result.props.tags).toEqual(['#family']);
        expect(result.props.dueDate).toBeTruthy();
    });

    it('leaves a pasted URL untouched while a trailing date still applies', () => {
        // The URL-integrity guarantee of preserve mode is the verbatim title;
        // a trailing date phrase outside the URL still becomes the due date
        // (same stance as shortcut captures, which resolve relative dates at
        // capture time). Consumers that must never infer dates pass
        // naturalLanguageDates: false.
        const now = new Date('2025-01-01T10:00:00Z');
        const input = 'Read https://en.wikipedia.org/wiki/Foo_(bar) tomorrow';
        const result = parseQuickAdd(input, undefined, now, undefined, { preserveText: true });

        expect(result.title).toBe(input);
        expect(result.detectedDate?.matchedText).toBe('tomorrow');
        expect(result.detectedDate?.titleWithoutDate).toBe(input);
        expect(result.props.dueDate).toBeUndefined();
    });

    describe('applied tokens leave the title whatever quickAddAutoClean says', () => {
        const now = new Date('2025-01-01T10:00:00Z');

        it('drops /next with cleanup off and on alike', () => {
            for (const preserveText of [true, false]) {
                const result = parseQuickAdd('Appeler maman /next', undefined, now, undefined, { preserveText });
                expect(result.title).toBe('Appeler maman');
                expect(result.props.status).toBe('next');
            }
        });

        it('drops several commands from the middle and end of a sentence', () => {
            const result = parseQuickAdd(
                'Call the plumber @phone about the leak /waiting /due:tomorrow',
                undefined,
                now,
                undefined,
                { preserveText: true },
            );
            expect(result.title).toBe('Call the plumber about the leak');
            expect(result.props.contexts).toEqual(['@phone']);
            expect(result.props.status).toBe('waiting');
            expect(result.props.dueDate).toBeTruthy();
        });

        it('leaves slash text it does not recognise alone', () => {
            const result = parseQuickAdd('Read the TCP/IP chapter /someday-maybe', undefined, now, undefined, {
                preserveText: true,
            });
            expect(result.title).toBe('Read the TCP/IP chapter /someday-maybe');
            expect(result.props.status).toBeUndefined();
        });

        it('leaves a slash-prefixed path inside a URL alone', () => {
            // Only whole tokens count: a substring match would cut the path out
            // of the link now that stripping is unconditional.
            const result = parseQuickAdd(
                'Read https://example.com/next and https://example.com/area:5',
                undefined,
                now,
                undefined,
                { preserveText: true },
            );
            expect(result.title).toBe('Read https://example.com/next and https://example.com/area:5');
            expect(result.props.status).toBeUndefined();
        });

        it('keeps a prose date in the title with cleanup off and removes it with cleanup on', () => {
            const input = 'Book the dentist tomorrow';
            const preserved = parseQuickAdd(input, undefined, now, undefined, { preserveText: true });
            expect(preserved.title).toBe(input);
            expect(preserved.detectedDate?.titleWithoutDate).toBe(input);

            const cleaned = parseQuickAdd(input, undefined, now, undefined, { preserveText: false });
            expect(cleaned.detectedDate?.titleWithoutDate).toBe('Book the dentist');
        });
    });

    it('default mode still strips recognized tokens (preserve is opt-in)', () => {
        const result = parseQuickAdd('Buy milk #grocery', undefined, undefined, undefined, {
            knownTags: ['#grocery'],
        });

        expect(result.title).toBe('Buy milk');
        expect(result.props.tags).toEqual(['#grocery']);
    });

    it('parseQuickAddDateCommands preserves the title when requested (#742)', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const stripped = parseQuickAddDateCommands('Submit report /due:tomorrow', now);
        expect(stripped.title).toBe('Submit report');
        expect(stripped.props.dueDate).toBeTruthy();

        // /due: is explicit syntax, so preserve mode has nothing ambiguous to keep.
        const preserved = parseQuickAddDateCommands('Submit report /due:tomorrow', now, { preserveText: true });
        expect(preserved.title).toBe('Submit report');
        expect(preserved.props.dueDate).toBeTruthy();
    });

    describe('parseProjectNextActionInput (#859)', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const projects = [
            {
                id: 'p1',
                title: 'MyProject',
                status: 'active',
                color: '#000000',
                tagIds: [],
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            },
            {
                id: 'p2',
                title: 'OtherProject',
                status: 'active',
                color: '#000000',
                tagIds: [],
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            },
        ] as any;

        it('defaults to a next action in the prompt project and section', () => {
            const result = parseProjectNextActionInput('Draft the report', {
                projectId: 'p1',
                sectionId: 's1',
                projects,
                now,
            });
            expect(result.title).toBe('Draft the report');
            expect(result.props).toEqual({ status: 'next', projectId: 'p1', sectionId: 's1' });
        });

        it('a /waiting token creates the task as waiting-for directly', () => {
            const result = parseProjectNextActionInput('Chase reply /waiting %Bob', {
                projectId: 'p1',
                projects,
                now,
            });
            expect(result.title).toBe('Chase reply');
            expect(result.props.status).toBe('waiting');
            expect(result.props.assignedTo).toBe('Bob');
            expect(result.props.projectId).toBe('p1');
        });

        it('context and date tokens apply like in the quick-add box', () => {
            const result = parseProjectNextActionInput('Call plumber @phone /due:2025-01-05', {
                projectId: 'p1',
                sectionId: 's1',
                projects,
                now,
            });
            expect(result.props.contexts).toEqual(['@phone']);
            expect(result.props.dueDate).toContain('2025-01-05');
            expect(result.props.status).toBe('next');
        });

        it('an existing +project token retargets and drops the prompt section', () => {
            const result = parseProjectNextActionInput('Hand off notes +OtherProject', {
                projectId: 'p1',
                sectionId: 's1',
                projects,
                now,
            });
            expect(result.props.projectId).toBe('p2');
            expect(result.props.sectionId).toBeUndefined();
        });

        it('an unknown +project name stays in the title and never creates a project', () => {
            const result = parseProjectNextActionInput('Plan trip +Vacations', {
                projectId: 'p1',
                projects,
                now,
            });
            expect(result.title).toBe('Plan trip +Vacations');
            expect(result.props.projectId).toBe('p1');
        });

        it('preserve-text mode still consumes the tokens it applied', () => {
            const result = parseProjectNextActionInput('Chase reply /waiting', {
                projectId: 'p1',
                projects,
                now,
                parseOptions: { preserveText: true },
            });
            expect(result.title).toBe('Chase reply');
            expect(result.props.status).toBe('waiting');
        });

        it('reports invalid date commands so prompts can warn instead of silently dropping them', () => {
            const result = parseProjectNextActionInput('Call plumber /due:notadate', {
                projectId: 'p1',
                projects,
                now,
            });
            expect(result.invalidDateCommands).toEqual(['/due:notadate']);
        });

        it('reports no invalid date commands for valid input', () => {
            const result = parseProjectNextActionInput('Call plumber /due:2025-01-05', {
                projectId: 'p1',
                projects,
                now,
            });
            expect(result.invalidDateCommands).toBeUndefined();
        });
    });

    describe('buildQuickAddParseOptions', () => {
        const task = (props: Partial<Task>): Task => ({
            id: 't1',
            title: 'T',
            status: 'inbox',
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
            ...props,
        } as Task);

        const person = (name: string): Person => ({
            id: `person-${name}`,
            name,
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
        } as Person);

        it('collects contexts, tags and people from the store snapshot', () => {
            const options = buildQuickAddParseOptions(
                { quickAddAutoClean: true, gtd: { defaultScheduleTime: '9:00' } },
                {
                    tasks: [task({ contexts: ['@office'], tags: ['#deep'], assignedTo: 'Ada Byron' })],
                    people: [person('Jim Smith')],
                },
            );

            expect(options.knownContexts).toEqual(['@office']);
            expect(options.knownTags).toEqual(['#deep']);
            expect(options.knownPeople).toEqual(['Jim Smith', 'Ada Byron']);
            expect(options.defaultScheduleTime).toBe('09:00');
            expect(options.preserveText).toBe(false);
            expect(options.naturalLanguageDates).toBe(true);
        });

        it('keeps preserve-text on and natural-language dates off when settings say so', () => {
            const options = buildQuickAddParseOptions({ gtd: { naturalLanguageDates: false } });

            expect(options.preserveText).toBe(true);
            expect(options.naturalLanguageDates).toBe(false);
            expect(options.defaultScheduleTime).toBeUndefined();
            expect(options.knownPeople).toEqual([]);
        });

        // The regression that let the capture surfaces drift: every field in the
        // bag is optional, so a surface that dropped knownPeople still compiled
        // and only showed up as `%Jim Smith` capturing as `%Jim`.
        it('resolves a multi-word known person, which a bag missing knownPeople cannot', () => {
            const source = { tasks: [], people: [person('Jim Smith')] };
            const now = new Date('2026-07-11T10:00:00Z');
            const input = 'Follow up %Jim Smith about budget';

            const withPeople = parseQuickAdd(input, undefined, now, undefined, buildQuickAddParseOptions({}, source));
            expect(withPeople.props.assignedTo).toBe('Jim Smith');
            expect(withPeople.title).toBe('Follow up about budget');

            const withoutPeople = parseQuickAdd(input, undefined, now, undefined, {
                ...buildQuickAddParseOptions({}, source),
                knownPeople: undefined,
            });
            expect(withoutPeople.props.assignedTo).toBe('Jim');
        });
    });
});

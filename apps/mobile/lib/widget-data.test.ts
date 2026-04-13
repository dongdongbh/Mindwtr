import { describe, expect, it } from 'vitest';
import type { AppData } from '@mindwtr/core';
import { buildWidgetPayload, resolveWidgetLanguage } from './widget-data';

const baseData: AppData = {
    tasks: [],
    projects: [],
    areas: [],
    sections: [],
    settings: {},
};

describe('widget-data', () => {
    it('resolves widget language with fallback', () => {
        expect(resolveWidgetLanguage('zh', undefined)).toBe('zh');
        expect(resolveWidgetLanguage('unknown', undefined)).toBe('en');
        expect(resolveWidgetLanguage(null, 'es')).toBe('es');
    });

    it('builds payload with focus-list tasks and defaults to three items', () => {
        const now = new Date().toISOString();
        const data: AppData = {
            ...baseData,
            tasks: [
                { id: '1', title: 'Focused 1', status: 'next', isFocusedToday: true, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '2', title: 'Focused 2', status: 'next', isFocusedToday: true, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '3', title: 'Focused 3', status: 'next', isFocusedToday: true, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '4', title: 'Focused 4', status: 'next', isFocusedToday: true, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '5', title: 'Next', status: 'next', isFocusedToday: false, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '6', title: 'Inbox', status: 'inbox', isFocusedToday: false, tags: [], contexts: [], createdAt: now, updatedAt: now },
            ],
        };
        const payload = buildWidgetPayload(data, 'en');
        expect(payload.headerTitle).toBeTruthy();
        expect(payload.items).toHaveLength(3);
        expect(payload.items.map((item) => item.title)).toEqual(['Focused 1', 'Focused 2', 'Focused 3']);
        expect(payload.inboxCount).toBe(1);
        expect(payload.subtitle).toBe('Inbox: 1 · +2 More');
    });

    it('honors maxItems option for larger widgets', () => {
        const now = new Date().toISOString();
        const data: AppData = {
            ...baseData,
            tasks: [
                { id: '1', title: 'Focused 1', status: 'next', isFocusedToday: true, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '2', title: 'Focused 2', status: 'next', isFocusedToday: true, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '3', title: 'Focused 3', status: 'next', isFocusedToday: true, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '4', title: 'Focused 4', status: 'next', isFocusedToday: true, tags: [], contexts: [], createdAt: now, updatedAt: now },
                { id: '5', title: 'Focused 5', status: 'next', isFocusedToday: true, tags: [], contexts: [], createdAt: now, updatedAt: now },
            ],
        };
        const payload = buildWidgetPayload(data, 'en', { maxItems: 5 });
        expect(payload.items).toHaveLength(5);
        expect(payload.items.map((item) => item.title)).toEqual([
            'Focused 1',
            'Focused 2',
            'Focused 3',
            'Focused 4',
            'Focused 5',
        ]);
        expect(payload.subtitle).toBe('Inbox: 0');
    });

    it('includes focus-page schedule/next tasks even when none are explicitly focused', () => {
        const now = new Date().toISOString();
        const data: AppData = {
            ...baseData,
            tasks: [
                {
                    id: 'next-due',
                    title: 'Next due today',
                    status: 'next',
                    dueDate: '2000-01-01',
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                },
                {
                    id: 'next-now',
                    title: 'Next action',
                    status: 'next',
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                },
                {
                    id: 'next-future',
                    title: 'Future next action',
                    status: 'next',
                    startTime: '2999-01-01T00:00:00.000Z',
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                },
            ],
        };
        const payload = buildWidgetPayload(data, 'en');
        expect(payload.items.map((item) => item.id)).toEqual(['next-due', 'next-now']);
    });

    it('keeps future-start tasks out of the widget payload even when focused', () => {
        const created = new Date().toISOString();
        const future = '2999-01-01T09:00:00.000Z';
        const data: AppData = {
            ...baseData,
            tasks: [
                {
                    id: 'focus-future',
                    title: 'Focused future',
                    status: 'next',
                    isFocusedToday: true,
                    startTime: future,
                    tags: [],
                    contexts: [],
                    createdAt: created,
                    updatedAt: created,
                },
                {
                    id: 'non-focus-future',
                    title: 'Non-focus future',
                    status: 'next',
                    isFocusedToday: false,
                    startTime: future,
                    tags: [],
                    contexts: [],
                    createdAt: created,
                    updatedAt: created,
                },
            ],
        };
        const payload = buildWidgetPayload(data, 'en');
        expect(payload.items).toHaveLength(0);
    });

    it('orders focused tasks using task sort setting before taking top three', () => {
        const data: AppData = {
            ...baseData,
            settings: { taskSortBy: 'created-desc' },
            tasks: [
                {
                    id: 'old',
                    title: 'Old',
                    status: 'next',
                    isFocusedToday: true,
                    tags: [],
                    contexts: [],
                    createdAt: '2026-02-20T10:00:00.000Z',
                    updatedAt: '2026-02-20T10:00:00.000Z',
                },
                {
                    id: 'newest',
                    title: 'Newest',
                    status: 'next',
                    isFocusedToday: true,
                    tags: [],
                    contexts: [],
                    createdAt: '2026-02-22T10:00:00.000Z',
                    updatedAt: '2026-02-22T10:00:00.000Z',
                },
                {
                    id: 'middle',
                    title: 'Middle',
                    status: 'next',
                    isFocusedToday: true,
                    tags: [],
                    contexts: [],
                    createdAt: '2026-02-21T10:00:00.000Z',
                    updatedAt: '2026-02-21T10:00:00.000Z',
                },
                {
                    id: 'older',
                    title: 'Older',
                    status: 'next',
                    isFocusedToday: true,
                    tags: [],
                    contexts: [],
                    createdAt: '2026-02-19T10:00:00.000Z',
                    updatedAt: '2026-02-19T10:00:00.000Z',
                },
            ],
        };
        const payload = buildWidgetPayload(data, 'en');
        expect(payload.items.map((item) => item.id)).toEqual(['newest', 'middle', 'old']);
    });
});

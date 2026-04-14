import { describe, it, expect } from 'vitest';
import { mergeAppData } from './sync';
import { createMockArea, mockAppData } from './sync-test-utils';
import { AppData } from './types';

describe('Sync Logic', () => {
    describe('mergeAppData', () => {
        it('should preserve local settings regardless of incoming settings', () => {
            const local: AppData = { ...mockAppData(), settings: { theme: 'dark' } };
            const incoming: AppData = { ...mockAppData(), settings: { theme: 'light' } };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.theme).toBe('dark');
        });

        it('merges synced language settings per field', () => {
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    language: 'en',
                    weekStart: 'monday',
                    dateFormat: 'yyyy-MM-dd',
                    timeFormat: '24h',
                    syncPreferences: { language: true },
                    syncPreferencesUpdatedAt: {
                        preferences: '2024-01-01T00:00:00.000Z',
                        language: '2024-01-01T00:00:00.000Z',
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    language: 'es',
                    weekStart: 'monday',
                    timeFormat: '12h',
                    syncPreferences: { language: true },
                    syncPreferencesUpdatedAt: {
                        preferences: '2024-01-02T00:00:00.000Z',
                        language: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.language).toBe('es');
            expect(merged.settings.weekStart).toBe('monday');
            expect(merged.settings.dateFormat).toBe('yyyy-MM-dd');
            expect(merged.settings.timeFormat).toBe('12h');
        });

        it('merges language settings even when sync preferences are empty', () => {
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    language: 'en',
                    syncPreferences: {},
                    syncPreferencesUpdatedAt: {
                        language: '2024-01-01T00:00:00.000Z',
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    language: 'es',
                    syncPreferences: {},
                    syncPreferencesUpdatedAt: {
                        language: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.language).toBe('es');
        });

        it('merges settings for disabled preference groups instead of dropping them', () => {
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    theme: 'dark',
                    syncPreferences: { appearance: false },
                    syncPreferencesUpdatedAt: {
                        appearance: '2024-01-01T00:00:00.000Z',
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    theme: 'light',
                    syncPreferences: { appearance: false },
                    syncPreferencesUpdatedAt: {
                        appearance: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.theme).toBe('light');
        });

        it('merges synced appearance settings including text size', () => {
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    appearance: { density: 'compact' },
                    syncPreferences: { appearance: true },
                    syncPreferencesUpdatedAt: {
                        preferences: '2024-01-01T00:00:00.000Z',
                        appearance: '2024-01-01T00:00:00.000Z',
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    appearance: { density: 'compact', textSize: 'large' },
                    syncPreferences: { appearance: true },
                    syncPreferencesUpdatedAt: {
                        preferences: '2024-01-02T00:00:00.000Z',
                        appearance: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.appearance).toEqual({ density: 'compact', textSize: 'large' });
        });

        it('deep-clones merged settings arrays to avoid shared references', () => {
            const incomingCalendars = [
                { id: 'cal-1', name: 'Team', url: 'https://calendar.example.com/team.ics', enabled: true },
            ];
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    externalCalendars: [
                        { id: 'cal-local', name: 'Local', url: 'https://calendar.example.com/local.ics', enabled: true },
                    ],
                    syncPreferencesUpdatedAt: {
                        externalCalendars: '2024-01-01T00:00:00.000Z',
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    externalCalendars: incomingCalendars,
                    syncPreferencesUpdatedAt: {
                        externalCalendars: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.externalCalendars).toEqual(incomingCalendars);
            expect(merged.settings.externalCalendars).not.toBe(incomingCalendars);

            incomingCalendars[0].name = 'Mutated Incoming';
            expect(merged.settings.externalCalendars?.[0]?.name).toBe('Team');
        });

        it('falls back to local values when incoming synced settings are malformed', () => {
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    language: 'en',
                    weekStart: 'monday',
                    dateFormat: 'yyyy-MM-dd',
                    externalCalendars: [
                        { id: 'cal-local', name: 'Local', url: 'https://calendar.example.com/local.ics', enabled: true },
                    ],
                    syncPreferences: {
                        language: true,
                        externalCalendars: true,
                    },
                    syncPreferencesUpdatedAt: {
                        preferences: '2024-01-01T00:00:00.000Z',
                        language: '2024-01-01T00:00:00.000Z',
                        externalCalendars: '2024-01-01T00:00:00.000Z',
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    language: 'xx' as AppData['settings']['language'],
                    weekStart: 'friday' as AppData['settings']['weekStart'],
                    dateFormat: 123 as unknown as string,
                    externalCalendars: [
                        { id: '', name: 'Broken', url: '', enabled: true },
                    ] as AppData['settings']['externalCalendars'],
                    syncPreferences: {
                        language: 'yes' as unknown as boolean,
                    },
                    syncPreferencesUpdatedAt: {
                        preferences: '2024-01-02T00:00:00.000Z',
                        language: '2024-01-02T00:00:00.000Z',
                        externalCalendars: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.language).toBe('en');
            expect(merged.settings.weekStart).toBe('monday');
            expect(merged.settings.dateFormat).toBe('yyyy-MM-dd');
            expect(merged.settings.externalCalendars).toEqual(local.settings.externalCalendars);
            expect(merged.settings.syncPreferences).toEqual(local.settings.syncPreferences);
        });

        it('keeps area tombstones so deletions sync across devices', () => {
            const local: AppData = {
                ...mockAppData(),
                areas: [createMockArea('a1', '2023-01-01T00:00:00.000Z')],
            };
            const incoming: AppData = {
                ...mockAppData(),
                areas: [createMockArea('a1', '2023-01-03T00:00:00.000Z', '2023-01-03T00:00:00.000Z')],
            };

            const merged = mergeAppData(local, incoming);
            expect(merged.areas).toHaveLength(1);
            expect(merged.areas[0].deletedAt).toBe('2023-01-03T00:00:00.000Z');
        });

        it('does not globally re-sort areas after merge', () => {
            const local: AppData = {
                ...mockAppData(),
                areas: [
                    { ...createMockArea('a1', '2023-01-04T00:00:00.000Z'), order: 10 },
                    { ...createMockArea('a2', '2023-01-04T00:00:00.000Z'), order: 0 },
                ],
            };
            const incoming: AppData = {
                ...mockAppData(),
                areas: [],
            };

            const merged = mergeAppData(local, incoming);
            expect(merged.areas.map((area) => area.id)).toEqual(['a1', 'a2']);
            expect(merged.areas.map((area) => area.order)).toEqual([10, 0]);
        });

        it('normalizes blank area metadata before merge', () => {
            const now = '2023-01-04T00:00:00.000Z';
            const local: AppData = {
                ...mockAppData(),
                areas: [{
                    ...createMockArea('a1', now),
                    color: '   ',
                    icon: '',
                    order: Number.NaN as unknown as number,
                    createdAt: '',
                }],
            };
            const incoming: AppData = {
                ...mockAppData(),
                areas: [{
                    ...createMockArea('a1', now),
                    color: undefined,
                    icon: undefined,
                    order: Number.NaN as unknown as number,
                    createdAt: now,
                }],
            };

            const merged = mergeAppData(local, incoming);
            expect(merged.areas).toHaveLength(1);
            expect(merged.areas[0].color).toBeUndefined();
            expect(merged.areas[0].icon).toBeUndefined();
            expect(merged.areas[0].order).toBe(0);
            expect(merged.areas[0].createdAt).toBe(now);
            expect(merged.areas[0].updatedAt).toBe(now);
        });
    });
});

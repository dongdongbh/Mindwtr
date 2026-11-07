import { describe, it, expect } from 'vitest';
import { DELETE_VS_LIVE_AMBIGUOUS_WINDOW_MS, mergeAppData } from './sync';
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

        it('merges synced language and GTD settings per field', () => {
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    gtd: {
                        defaultScheduleTime: '08:00',
                        defaultAreaMode: 'fixed',
                        defaultAreaId: 'area-local',
                        focusTaskLimit: 3,
                        focusGroupBy: 'context',
                        defaultProjectFlowMode: 'parallel',
                        inboxProcessing: { scheduleEnabled: true },
                    },
                    language: 'en',
                    weekStart: 'monday',
                    dateFormat: 'yyyy-MM-dd',
                    timeFormat: '24h',
                    syncPreferences: { gtd: true, language: true },
                    syncPreferencesUpdatedAt: {
                        gtd: '2024-01-01T00:00:00.000Z',
                        preferences: '2024-01-01T00:00:00.000Z',
                        language: '2024-01-01T00:00:00.000Z',
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    gtd: {
                        defaultScheduleTime: '09:30',
                        defaultAreaMode: 'active',
                        defaultAreaId: 'area-incoming',
                        focusTaskLimit: 5,
                        focusGroupBy: 'project',
                        defaultProjectFlowMode: 'sequential',
                    },
                    language: 'es',
                    weekStart: 'monday',
                    timeFormat: '12h',
                    syncPreferences: { gtd: true, language: true },
                    syncPreferencesUpdatedAt: {
                        gtd: '2024-01-02T00:00:00.000Z',
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
            expect(merged.settings.gtd?.defaultScheduleTime).toBe('09:30');
            expect(merged.settings.gtd?.defaultAreaMode).toBe('active');
            expect(merged.settings.gtd?.defaultAreaId).toBe('area-incoming');
            expect(merged.settings.gtd?.focusTaskLimit).toBe(5);
            expect(merged.settings.gtd?.focusGroupBy).toBe('project');
            expect(merged.settings.gtd?.defaultProjectFlowMode).toBe('sequential');
            expect(merged.settings.gtd?.inboxProcessing?.scheduleEnabled).toBe(true);
        });

        it('retains an explicit Focus start-date choice when an older peer omits it', () => {
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    gtd: { focusIncludeStartDates: false },
                    syncPreferences: { gtd: true },
                    syncPreferencesUpdatedAt: { gtd: '2024-01-01T00:00:00.000Z' },
                },
            };
            const olderPeer: AppData = {
                ...mockAppData(),
                settings: {
                    gtd: { focusTaskLimit: 5 },
                    syncPreferences: { gtd: true },
                    syncPreferencesUpdatedAt: { gtd: '2024-01-02T00:00:00.000Z' },
                },
            };
            const merged = mergeAppData(local, olderPeer);
            expect(merged.settings.gtd?.focusIncludeStartDates).toBe(false);
            expect(merged.settings.gtd?.focusTaskLimit).toBe(5);
            expect(mergeAppData(merged, olderPeer).settings.gtd?.focusIncludeStartDates).toBe(false);
        });

        it('syncs clearing the default area mode as an explicit GTD setting', () => {
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    gtd: { defaultAreaMode: 'active', defaultAreaId: null },
                    syncPreferences: { gtd: true },
                    syncPreferencesUpdatedAt: {
                        gtd: '2024-01-01T00:00:00.000Z',
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    gtd: { defaultAreaMode: 'none', defaultAreaId: null },
                    syncPreferences: { gtd: true },
                    syncPreferencesUpdatedAt: {
                        gtd: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.gtd?.defaultAreaMode).toBe('none');
            expect(merged.settings.gtd?.defaultAreaId).toBeNull();
        });

        it('syncs clearing the default area as an explicit GTD setting', () => {
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    gtd: { defaultAreaId: 'area-work' },
                    syncPreferences: { gtd: true },
                    syncPreferencesUpdatedAt: {
                        gtd: '2024-01-01T00:00:00.000Z',
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    gtd: { defaultAreaId: null },
                    syncPreferences: { gtd: true },
                    syncPreferencesUpdatedAt: {
                        gtd: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.gtd?.defaultAreaId).toBeNull();
        });

        it('tombstones duplicate live areas by name during sync repair', () => {
            const nowIso = '2026-06-12T12:00:00.000Z';
            const local: AppData = {
                ...mockAppData(),
                tasks: [{
                    id: 'task-a',
                    title: 'Area task',
                    status: 'next',
                    tags: [],
                    contexts: [],
                    areaId: 'area-b',
                    createdAt: '2026-06-01T00:00:00.000Z',
                    updatedAt: '2026-06-01T00:00:00.000Z',
                }],
                projects: [{
                    id: 'project-a',
                    title: 'Launch',
                    status: 'active',
                    color: '#3B82F6',
                    order: 0,
                    tagIds: [],
                    areaId: 'area-b',
                    areaTitle: 'Work',
                    createdAt: '2026-06-01T00:00:00.000Z',
                    updatedAt: '2026-06-01T00:00:00.000Z',
                }],
                areas: [
                    { ...createMockArea('area-a', '2026-06-01T00:00:00.000Z'), name: 'Work', order: 0 },
                    { ...createMockArea('area-b', '2026-06-02T00:00:00.000Z'), name: 'Work', order: 1 },
                ],
                settings: {
                    gtd: { defaultAreaId: 'area-b' },
                },
            };
            const incoming: AppData = { ...mockAppData(), areas: [] };

            const merged = mergeAppData(local, incoming, { nowIso });

            expect(merged.areas.find((area) => area.id === 'area-a')?.deletedAt).toBeUndefined();
            expect(merged.areas.find((area) => area.id === 'area-b')).toMatchObject({
                deletedAt: nowIso,
                updatedAt: nowIso,
            });
            expect(merged.projects.find((project) => project.id === 'project-a')?.areaId).toBe('area-a');
            expect(merged.tasks.find((task) => task.id === 'task-a')?.areaId).toBe('area-a');
            expect(merged.settings.gtd?.defaultAreaId).toBe('area-a');
            expect(merged.settings.syncPreferencesUpdatedAt?.gtd).toBe(nowIso);
        });

        it('does not sync default schedule time with the language group', () => {
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    gtd: { defaultScheduleTime: '08:00' },
                    language: 'en',
                    syncPreferences: { language: true },
                    syncPreferencesUpdatedAt: {
                        language: '2024-01-01T00:00:00.000Z',
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    gtd: { defaultScheduleTime: '09:30' },
                    language: 'es',
                    syncPreferences: { language: true },
                    syncPreferencesUpdatedAt: {
                        language: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.language).toBe('es');
            expect(merged.settings.gtd?.defaultScheduleTime).toBe('08:00');
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

        it('keeps local settings for disabled preference groups', () => {
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

            expect(merged.settings.theme).toBe('dark');
        });

        it('prevents incoming appearance from applying when the local device opted out', () => {
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    theme: 'dark',
                    syncPreferences: { appearance: false },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    theme: 'light',
                    syncPreferences: { appearance: true },
                    syncPreferencesUpdatedAt: {
                        appearance: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.theme).toBe('dark');
        });

        it('merges synced appearance settings including text size and mobile quick access', () => {
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    appearance: { density: 'compact', mobileQuickAccessView: 'review' },
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
                    appearance: { density: 'compact', textSize: 'small', mobileQuickAccessView: 'calendar' },
                    syncPreferences: { appearance: true },
                    syncPreferencesUpdatedAt: {
                        preferences: '2024-01-02T00:00:00.000Z',
                        appearance: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.appearance).toEqual({ density: 'compact', textSize: 'small', mobileQuickAccessView: 'calendar' });
        });

        it('keeps an incoming condensed density value through the merge sanitizer', () => {
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
                    appearance: { density: 'condensed' },
                    syncPreferences: { appearance: true },
                    syncPreferencesUpdatedAt: {
                        preferences: '2024-01-02T00:00:00.000Z',
                        appearance: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.appearance?.density).toBe('condensed');
        });

        it('sanitizes an unknown incoming density back to the local value', () => {
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
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    appearance: { density: 'ultra' as any },
                    syncPreferences: { appearance: true },
                    syncPreferencesUpdatedAt: {
                        preferences: '2024-01-02T00:00:00.000Z',
                        appearance: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.appearance?.density).toBe('compact');
        });

        it('sanitizes the incoming area filter style', () => {
            const appData = (appearance: AppData['settings']['appearance'], day: string): AppData => ({
                ...mockAppData(),
                settings: {
                    appearance,
                    syncPreferences: { appearance: true },
                    syncPreferencesUpdatedAt: {
                        preferences: `2024-01-0${day}T00:00:00.000Z`,
                        appearance: `2024-01-0${day}T00:00:00.000Z`,
                    },
                },
            });

            expect(mergeAppData(appData({ areaFilterStyle: 'list' }, '1'), appData({ areaFilterStyle: 'chips' }, '2'))
                .settings.appearance?.areaFilterStyle).toBe('chips');
            expect(mergeAppData(
                appData({ areaFilterStyle: 'chips' }, '1'),
                appData({ areaFilterStyle: 'grid' as unknown as 'list' }, '2'),
            ).settings.appearance?.areaFilterStyle).toBe('chips');
            const withoutLocal = mergeAppData(
                appData({ density: 'compact' }, '1'),
                appData({ density: 'compact', areaFilterStyle: 'grid' as unknown as 'list' }, '2'),
            ).settings.appearance;
            expect(withoutLocal).toEqual({ density: 'compact' });
            expect(mergeAppData(appData({ density: 'compact' }, '1'), appData({ density: 'condensed' }, '2'))
                .settings.appearance).toEqual({ density: 'condensed' });
        });

        it('preserves local mobile quick access when newer incoming appearance omits it', () => {
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    appearance: { mobileQuickAccessView: 'contexts' },
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
                    appearance: { density: 'compact', textSize: 'small' },
                    syncPreferences: { appearance: true },
                    syncPreferencesUpdatedAt: {
                        preferences: '2024-01-02T00:00:00.000Z',
                        appearance: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.appearance).toEqual({
                density: 'compact',
                textSize: 'small',
                mobileQuickAccessView: 'contexts',
            });
        });

        it('merges synced future-start visibility preference', () => {
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    appearance: { showFutureStarts: false },
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
                    appearance: { showFutureStarts: true },
                    syncPreferences: { appearance: true },
                    syncPreferencesUpdatedAt: {
                        preferences: '2024-01-02T00:00:00.000Z',
                        appearance: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.appearance).toEqual({ showFutureStarts: true });
        });

        it('falls back to local mobile quick access when incoming appearance is malformed', () => {
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    appearance: { mobileQuickAccessView: 'projects' },
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
                    appearance: { mobileQuickAccessView: 'trash' as AppData['settings']['appearance']['mobileQuickAccessView'] },
                    syncPreferences: { appearance: true },
                    syncPreferencesUpdatedAt: {
                        preferences: '2024-01-02T00:00:00.000Z',
                        appearance: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.appearance?.mobileQuickAccessView).toBe('projects');
        });

        it('deep-clones merged settings arrays to avoid shared references', () => {
            const incomingCalendars = [
                { id: 'cal-1', name: 'Team', url: 'https://calendar.example.com/team.ics', enabled: true, color: '#7c3aed' },
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

            expect(merged.settings.externalCalendars).toEqual([
                { id: 'cal-1', name: 'Team', url: 'https://calendar.example.com/team.ics', enabled: true, color: '#7C3AED' },
            ]);
            expect(merged.settings.externalCalendars).not.toBe(incomingCalendars);

            incomingCalendars[0].name = 'Mutated Incoming';
            expect(merged.settings.externalCalendars?.[0]?.name).toBe('Team');
        });

        it('keeps calendar Area associations when an older payload lacks the field and a second merge converges', () => {
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    externalCalendars: [{ id: 'cal-1', name: 'Team', url: 'https://calendar.example.com/team.ics', enabled: true, areaIds: ['work', 'deleted'] }],
                    syncPreferencesUpdatedAt: { externalCalendars: '2024-01-02T00:00:00.000Z' },
                },
            };
            const oldPeer: AppData = {
                ...mockAppData(),
                settings: {
                    externalCalendars: [{ id: 'cal-1', name: 'Team', url: 'https://calendar.example.com/team.ics', enabled: true }],
                    syncPreferencesUpdatedAt: { externalCalendars: '2024-01-01T00:00:00.000Z' },
                },
            };
            const merged = mergeAppData(local, oldPeer);
            expect(merged.settings.externalCalendars?.[0]?.areaIds).toEqual(['work', 'deleted']);
            expect(mergeAppData(merged, oldPeer).settings.externalCalendars).toEqual(merged.settings.externalCalendars);
        });

        it('keeps local file calendar sources out of synced settings merges', () => {
            const localCalendars = [
                { id: 'cal-local', name: 'Local', url: 'file:///home/user/agenda.ics', enabled: true, color: '#DB2777' },
                { id: 'cal-android-local', name: 'Android Local', url: 'content://calendar/agenda.ics', enabled: true, color: '#059669' },
            ];
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    externalCalendars: localCalendars,
                    syncPreferencesUpdatedAt: {
                        externalCalendars: '2024-01-01T00:00:00.000Z',
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    externalCalendars: [
                        { id: 'cal-file', name: 'File', url: 'file:///tmp/other.ics', enabled: true },
                        { id: 'cal-content', name: 'Android File', url: 'content://downloads/other.ics', enabled: true },
                        { id: 'cal-team', name: 'Team', url: 'https://calendar.example.com/team.ics', enabled: true, color: '#EA580C' },
                    ],
                    syncPreferencesUpdatedAt: {
                        externalCalendars: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.externalCalendars).toEqual([
                { id: 'cal-team', name: 'Team', url: 'https://calendar.example.com/team.ics', enabled: true, color: '#EA580C' },
                ...localCalendars,
            ]);
        });

        it('merges saved filters by id when their sync group is enabled', () => {
            const localFilter = {
                id: 'filter-local',
                name: 'Local Desk',
                view: 'focus' as const,
                criteria: { contexts: ['@desk'] },
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
            };
            const incomingFilter = {
                id: 'filter-incoming',
                name: 'Incoming Week',
                view: 'focus' as const,
                criteria: { dueDateRange: { preset: 'this_week' as const } },
                createdAt: '2024-01-02T00:00:00.000Z',
                updatedAt: '2024-01-02T00:00:00.000Z',
            };
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    savedFilters: [localFilter],
                    syncPreferences: { savedFilters: true },
                    syncPreferencesUpdatedAt: {
                        savedFilters: '2024-01-01T00:00:00.000Z',
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    savedFilters: [incomingFilter],
                    syncPreferences: { savedFilters: true },
                    syncPreferencesUpdatedAt: {
                        savedFilters: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);


            expect(merged.settings.savedFilters).toEqual([incomingFilter, localFilter]);
            expect(merged.settings.savedFilters).not.toBe(incoming.settings.savedFilters);
        });

        it('keeps the newer saved filter when the same id changed on both devices', () => {
            const localFilter = {
                id: 'filter-shared',
                name: 'Local Name',
                view: 'focus' as const,
                criteria: { contexts: ['@desk'] },
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-03T00:00:00.000Z',
            };
            const incomingFilter = {
                id: 'filter-shared',
                name: 'Incoming Name',
                view: 'focus' as const,
                criteria: { tags: ['#incoming'] },
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-04T00:00:00.000Z',
            };
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    savedFilters: [localFilter],
                    syncPreferences: { savedFilters: true },
                    syncPreferencesUpdatedAt: {
                        savedFilters: '2024-01-03T00:00:00.000Z',
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    savedFilters: [incomingFilter],
                    syncPreferences: { savedFilters: true },
                    syncPreferencesUpdatedAt: {
                        savedFilters: '2024-01-04T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.savedFilters).toEqual([incomingFilter]);
        });

        it('keeps a newer saved filter even when it falls inside the entity clock-skew window', () => {
            const localFilter = {
                id: 'filter-shared',
                name: 'zz older local',
                view: 'focus' as const,
                criteria: { tags: ['#older'] },
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-05T00:00:00.000Z',
            };
            const incomingFilter = {
                id: 'filter-shared',
                name: 'aa newer incoming',
                view: 'focus' as const,
                criteria: { tags: ['#newer'] },
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-05T00:03:00.000Z',
            };
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    savedFilters: [localFilter],
                    syncPreferences: { savedFilters: true },
                    syncPreferencesUpdatedAt: {
                        savedFilters: '2024-01-05T00:00:00.000Z',
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    savedFilters: [incomingFilter],
                    syncPreferences: { savedFilters: true },
                    syncPreferencesUpdatedAt: {
                        savedFilters: '2024-01-05T00:03:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.savedFilters).toEqual([incomingFilter]);
        });

        it('keeps saved filter tombstones from resurrecting older copies', () => {
            const deletedFilter = {
                id: 'filter-shared',
                name: 'Desk',
                view: 'focus' as const,
                criteria: { contexts: ['@desk'] },
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-05T00:00:00.000Z',
                deletedAt: '2024-01-05T00:00:00.000Z',
            };
            const staleActiveFilter = {
                id: 'filter-shared',
                name: 'Desk',
                view: 'focus' as const,
                criteria: { contexts: ['@desk'] },
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-02T00:00:00.000Z',
            };
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    savedFilters: [deletedFilter],
                    syncPreferences: { savedFilters: true },
                    syncPreferencesUpdatedAt: {
                        savedFilters: '2024-01-05T00:00:00.000Z',
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    savedFilters: [staleActiveFilter],
                    syncPreferences: { savedFilters: true },
                    syncPreferencesUpdatedAt: {
                        savedFilters: '2024-01-06T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.savedFilters).toEqual([deletedFilter]);
        });

        it('keeps saved filter tombstones when a live copy is only slightly newer', () => {
            const deletedAt = '2024-01-05T00:00:00.000Z';
            const liveUpdatedAt = new Date(Date.parse(deletedAt) + DELETE_VS_LIVE_AMBIGUOUS_WINDOW_MS - 1).toISOString();
            const deletedFilter = {
                id: 'filter-shared',
                name: 'Desk',
                view: 'focus' as const,
                criteria: { contexts: ['@desk'] },
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: deletedAt,
                deletedAt,
            };
            const slightlyNewerActiveFilter = {
                id: 'filter-shared',
                name: 'Desk active',
                view: 'focus' as const,
                criteria: { contexts: ['@desk'], tags: ['#active'] },
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: liveUpdatedAt,
            };
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    savedFilters: [deletedFilter],
                    syncPreferences: { savedFilters: true },
                    syncPreferencesUpdatedAt: {
                        savedFilters: deletedAt,
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    savedFilters: [slightlyNewerActiveFilter],
                    syncPreferences: { savedFilters: true },
                    syncPreferencesUpdatedAt: {
                        savedFilters: liveUpdatedAt,
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.savedFilters).toEqual([deletedFilter]);
        });

        it('lets a live saved filter edit win outside the delete ambiguity window', () => {
            const deletedAt = '2024-01-05T00:00:00.000Z';
            const liveUpdatedAt = new Date(Date.parse(deletedAt) + DELETE_VS_LIVE_AMBIGUOUS_WINDOW_MS + 1).toISOString();
            const deletedFilter = {
                id: 'filter-shared',
                name: 'Desk',
                view: 'focus' as const,
                criteria: { contexts: ['@desk'] },
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: deletedAt,
                deletedAt,
            };
            const newerActiveFilter = {
                id: 'filter-shared',
                name: 'Desk active',
                view: 'focus' as const,
                criteria: { contexts: ['@desk'], tags: ['#active'] },
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: liveUpdatedAt,
            };
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    savedFilters: [deletedFilter],
                    syncPreferences: { savedFilters: true },
                    syncPreferencesUpdatedAt: {
                        savedFilters: deletedAt,
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    savedFilters: [newerActiveFilter],
                    syncPreferences: { savedFilters: true },
                    syncPreferencesUpdatedAt: {
                        savedFilters: liveUpdatedAt,
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.savedFilters).toEqual([newerActiveFilter]);
        });

        it('chooses the same saved filter winner when update timestamps tie', () => {
            const updatedAt = '2024-01-05T00:00:00.000Z';
            const localFilter = {
                id: 'filter-shared',
                name: 'Desk',
                view: 'focus' as const,
                criteria: { contexts: ['@desk'] },
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt,
            };
            const incomingFilter = {
                id: 'filter-shared',
                name: 'Desk active',
                view: 'focus' as const,
                criteria: { contexts: ['@desk'], tags: ['#active'] },
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt,
            };
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    savedFilters: [localFilter],
                    syncPreferences: { savedFilters: true },
                    syncPreferencesUpdatedAt: {
                        savedFilters: updatedAt,
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    savedFilters: [incomingFilter],
                    syncPreferences: { savedFilters: true },
                    syncPreferencesUpdatedAt: {
                        savedFilters: updatedAt,
                    },
                },
            };

            const forward = mergeAppData(local, incoming);
            const reverse = mergeAppData(incoming, local);

            expect(forward.settings.savedFilters).toEqual(reverse.settings.savedFilters);
            expect(forward.settings.savedFilters).toEqual([expect.objectContaining({ id: 'filter-shared' })]);
        });

        it('keeps local saved filters when the local device opted out', () => {
            const localFilter = {
                id: 'filter-local',
                name: 'Local',
                view: 'focus' as const,
                criteria: { tags: ['#local'] },
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
            };
            const incomingFilter = {
                id: 'filter-incoming',
                name: 'Incoming',
                view: 'focus' as const,
                criteria: { tags: ['#incoming'] },
                createdAt: '2024-01-02T00:00:00.000Z',
                updatedAt: '2024-01-02T00:00:00.000Z',
            };
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    savedFilters: [localFilter],
                    syncPreferences: { savedFilters: false },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    savedFilters: [incomingFilter],
                    syncPreferences: { savedFilters: true },
                    syncPreferencesUpdatedAt: {
                        savedFilters: '2024-01-02T00:00:00.000Z',
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.savedFilters).toEqual([localFilter]);
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

        it('keeps Parakeet as a valid synced speech-to-text provider', () => {
            const local: AppData = {
                ...mockAppData(),
                settings: {
                    syncPreferences: { ai: true },
                    syncPreferencesUpdatedAt: { ai: '2024-01-01T00:00:00.000Z' },
                    ai: {
                        speechToText: {
                            enabled: true,
                            provider: 'whisper',
                            model: 'whisper-base',
                            offlineModelPath: '/local/whisper.bin',
                        },
                    },
                },
            };
            const incoming: AppData = {
                ...mockAppData(),
                settings: {
                    syncPreferences: { ai: true },
                    syncPreferencesUpdatedAt: { ai: '2024-01-02T00:00:00.000Z' },
                    ai: {
                        speechToText: {
                            enabled: true,
                            provider: 'parakeet',
                            model: 'parakeet-tdt-0.6b-v3-int8',
                            offlineModelPath: '/remote/parakeet',
                        },
                    },
                },
            };

            const merged = mergeAppData(local, incoming);

            expect(merged.settings.ai?.speechToText?.provider).toBe('parakeet');
            expect(merged.settings.ai?.speechToText?.model).toBe('parakeet-tdt-0.6b-v3-int8');
            expect(merged.settings.ai?.speechToText?.offlineModelPath).toBeUndefined();
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

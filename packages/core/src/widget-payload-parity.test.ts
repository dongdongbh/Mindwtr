


import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadTranslations } from './i18n/i18n-loader';
import type { Language } from './i18n/i18n-types';
import { getFocusWidgetFilter, resetFocusWidgetFilter, setFocusWidgetFilter, type FocusWidgetFilter } from './focus-widget-filter';
import type { AppData, AppSettings } from './types';
import { resolveWidgetListDestination } from './widget-list-destination';
import {
    buildAndroidWidgetPublication,
    buildShortcutsSnapshot,
    buildWidgetPayload,
    createPublishedWidgetProjection,
    createWidgetPayloadProjection,
    IOS_WIDGET_FAMILY_CACHE_ITEMS,
    iosWidgetProjectionOptions,
    resolveWidgetLanguage,
    type WidgetPayloadBuildOptions,
} from './widget-payload';

type Settings = Partial<AppSettings>;
type Scenario =
    | {
        kind: 'publish'; name: string; platform: 'android' | 'ios'; store: string; settings: Settings;
        savedLanguage: string | null; systemColorScheme: 'light' | 'dark' | null; focusFilter: FocusWidgetFilter | null;
        listSelections: string[]; noIntl?: boolean;
    }
    | {
        kind: 'build'; name: string; store: string; settings: Settings; language: Language;
        options: Omit<WidgetPayloadBuildOptions, 'systemColorScheme'> & { systemColorScheme?: 'light' | 'dark' | null }; noIntl?: boolean;
    }
    | { kind: 'destination'; name: string; store: string; settings: Settings; language: Language; focusFilter: FocusWidgetFilter | null; ids: unknown[] }
    | { kind: 'snapshot'; name: string; store: string; settings: Settings };

const fixture = JSON.parse(readFileSync(new URL('./widget-payload-parity.fixtures.json', import.meta.url), 'utf8')) as {
    now: string;
    languages: Language[];
    stores: Record<string, AppData>;
    scenarios: Scenario[];
    observations: Record<string, unknown>;
};


const IOS_FAMILIES = ['default', 'small', 'medium', 'large', 'extraLarge'] as const;

const storeFor = (scenario: { store: string; settings: Settings }): AppData => {
    const store = fixture.stores[scenario.store];
    return { ...store, settings: { ...store.settings, ...scenario.settings } as AppSettings };
};

const withoutIntl = <T,>(enabled: boolean | undefined, run: () => T): T => {
    if (!enabled) return run();
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((() => {
        throw new Error('no Intl in this engine');
    }) as unknown as typeof Intl.DateTimeFormat);
    try {
        return run();
    } finally {
        spy.mockRestore();
    }
};

function replay(scenario: Scenario): unknown {
    const data = storeFor(scenario);
    switch (scenario.kind) {
        case 'publish': {
            resetFocusWidgetFilter();
            if (scenario.focusFilter) setFocusWidgetFilter(scenario.focusFilter);
            const language = resolveWidgetLanguage(scenario.savedLanguage, data.settings?.language);
            const input = { systemColorScheme: scenario.systemColorScheme ?? undefined, focusFilter: getFocusWidgetFilter() };
            if (scenario.platform === 'android') {
                const payload = withoutIntl(scenario.noIntl, () => buildAndroidWidgetPublication(data, language, {
                    ...input,
                    listSelections: scenario.listSelections,
                }));
                return { published: true, android: [JSON.stringify(payload)] };
            }
            const frozen = (fixture.observations[scenario.name] as { ios: [string, string][] }).ios;
            const values = withoutIntl(scenario.noIntl, () => {
                const projection = createPublishedWidgetProjection(
                    createWidgetPayloadProjection(data, language, iosWidgetProjectionOptions(input)),
                    language,
                );
                return [
                    ...IOS_FAMILIES.map((family) => JSON.stringify(projection.build(IOS_WIDGET_FAMILY_CACHE_ITEMS[family]))),
                    JSON.stringify(buildShortcutsSnapshot(data)),
                ];
            });
            return { published: true, ios: values.map((value, index) => [frozen[index]?.[0], value]) };
        }
        case 'build': {
            const { systemColorScheme, ...options } = scenario.options;
            return withoutIntl(scenario.noIntl, () => JSON.stringify(buildWidgetPayload(data, scenario.language, {
                ...options,
                systemColorScheme: systemColorScheme ?? undefined,
            })));
        }
        case 'destination': {
            resetFocusWidgetFilter();
            if (scenario.focusFilter) setFocusWidgetFilter(scenario.focusFilter);
            return scenario.ids.map((id) => {
                const list = resolveWidgetListDestination(data, scenario.language, id);
                return list ? { title: list.title, taskIds: list.tasks.map((task) => task.id) } : null;
            });
        }
        case 'snapshot':
            return JSON.stringify(buildShortcutsSnapshot(data));
    }
}

describe('widget payload parity with React Native', () => {
    const originalTz = process.env.TZ;

    const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    const deviceLocale = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions');
    beforeAll(async () => {
        process.env.TZ = 'UTC';
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
        deviceLocale.mockImplementation(function (this: Intl.DateTimeFormat) {
            return { ...resolvedOptions.call(this), locale: 'und' };
        });
        for (const language of fixture.languages) await loadTranslations(language);
    }, 30_000);
    afterEach(() => resetFocusWidgetFilter());
    afterAll(() => {
        deviceLocale.mockRestore();
        vi.useRealTimers();
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });

    it('covers Android and iOS publications, every theme preset, date formats and a long list', () => {
        const names = fixture.scenarios.map((scenario) => scenario.name);
        expect(names).toEqual(expect.arrayContaining(['android-default', 'android-long', 'android-no-intl', 'ios-default', 'ios-no-intl']));
        const themes = new Set(fixture.scenarios.flatMap((scenario) => (scenario.settings.theme ? [scenario.settings.theme.toLowerCase()] : [])));
        for (const preset of ['eink', 'nord', 'sepia', 'oled', 'catppuccin-macchiato', 'dracula', 'system-oled']) expect(themes).toContain(preset);
        const longList = JSON.parse((fixture.observations['android-long'] as { android: string[] }).android[0]);
        expect(longList.lists.next.totalCount).toBeGreaterThan(longList.lists.next.items.length);
    });

    it.each(fixture.scenarios.map((scenario) => [scenario.name, scenario] as const))('%s replays byte for byte', (_name, scenario) => {
        expect(replay(scenario)).toEqual(fixture.observations[scenario.name]);
    });
});

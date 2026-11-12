import React, { Profiler } from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GeneralSettingsScreen } from './general-settings-screen';
import { GtdSettingsScreen } from './gtd-settings-screen';
import { SettingRow } from './setting-row';
import { LANGUAGES } from './settings.constants';
import { useSyncSettingsStoreSlice } from './use-sync-settings-store-slice';

const updateSettings = vi.hoisted(() => vi.fn(async () => undefined));
const storeHarness = vi.hoisted(() => ({
    listeners: new Set<() => void>(),
    state: {} as Record<string, unknown>,
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const ReactModule = await import('react');
    const identity = (state: unknown) => state;

    const useTaskStore = (
        selector: (state: Record<string, unknown>) => unknown = identity,
        equalityFn: (left: unknown, right: unknown) => boolean = Object.is,
    ) => {
        const selectorRef = ReactModule.useRef(selector);
        const equalityRef = ReactModule.useRef(equalityFn);
        const selectedRef = ReactModule.useRef(selector(storeHarness.state));
        const [, forceRender] = ReactModule.useReducer((count) => count + 1, 0);
        selectorRef.current = selector;
        equalityRef.current = equalityFn;

        const selectedDuringRender = selector(storeHarness.state);
        if (!equalityFn(selectedRef.current, selectedDuringRender)) {
            selectedRef.current = selectedDuringRender;
        }

        ReactModule.useEffect(() => {
            const listener = () => {
                const nextSelected = selectorRef.current(storeHarness.state);
                if (equalityRef.current(selectedRef.current, nextSelected)) return;
                selectedRef.current = nextSelected;
                forceRender();
            };
            storeHarness.listeners.add(listener);
            return () => {
                storeHarness.listeners.delete(listener);
            };
        }, []);

        return selectedRef.current;
    };

    return {
        ...actual,
        useTaskStore: Object.assign(useTaskStore, {
            getState: () => storeHarness.state,
        }),
    };
});

vi.mock('@/contexts/theme-context', () => ({
    useTheme: () => ({
        setThemeMode: vi.fn(),
        themeMode: 'system',
        themePreset: 'system',
    }),
}));

vi.mock('@/contexts/toast-context', () => ({
    ToastViewport: () => null,
    useToast: () => ({ dismissToast: vi.fn(), showToast: vi.fn() }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
    useThemeColors: () => ({
        bg: '#0f172a',
        border: '#334155',
        cardBg: '#111827',
        filterBg: '#1f2937',
        inputBg: '#111827',
        secondaryText: '#94a3b8',
        text: '#f8fafc',
        tint: '#3b82f6',
    }),
}));

vi.mock('@/hooks/use-filled-button-colors', () => ({
    useFilledButtonColors: () => ({ backgroundColor: '#3b82f6', textColor: '#ffffff' }),
}));

vi.mock('@/hooks/use-theme-tokens', () => ({
    useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { large: 16 } }),
}));

vi.mock('@/lib/mobile-app-lock', () => ({
    MobileAppLockEnableContext: React.createContext<() => void>(() => undefined),
    authenticateWithDeviceLock: vi.fn(async () => true),
    getMobileAppLockErrorKey: () => 'settings.mobileAppLockUnavailable',
}));

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: (props: Record<string, unknown>) => React.createElement(
        'SafeAreaView',
        props,
        props.children as React.ReactNode,
    ),
    useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

vi.mock('./settings.hooks', () => ({
    useSettingsLocalization: () => ({
        isChineseLanguage: false,
        language: 'en',
        setLanguage: vi.fn(),
        t: (key: string) => key,
        tr: (key: string) => key,
    }),
    useSettingsScrollContent: () => ({}),
}));

vi.mock('./settings.shell', () => ({
    SettingsTopBar: () => React.createElement('SettingsTopBar'),
}));

const renderAndCountCommits = (element: React.ReactElement) => {
    let commits = 0;
    let tree!: renderer.ReactTestRenderer;
    act(() => {
        tree = renderer.create(
            <Profiler id="settings-screen" onRender={() => { commits += 1; }}>
                {element}
            </Profiler>,
        );
    });
    return {
        get commits() {
            return commits;
        },
        tree,
    };
};

const SyncSettingsStoreProbe = () => {
    useSyncSettingsStoreSlice('sync');
    return null;
};

describe('settings store subscriptions', () => {
    beforeEach(() => {
        updateSettings.mockClear();
        storeHarness.listeners.clear();
        storeHarness.state = {
            areas: [],
            settings: {
                features: {
                    priorities: true,
                    timeEstimates: true,
                },
                gtd: {
                    taskEditor: {},
                },
            },
            tasks: [],
            updateSettings,
        };
    });

    it.each([
        ['General', () => <GeneralSettingsScreen />],
        ['GTD', () => <GtdSettingsScreen onNavigate={vi.fn()} screen="gtd" />],
    ])('does not rerender the %s settings screen for an unrelated task mutation', (_name, makeScreen) => {
        const rendered = renderAndCountCommits(makeScreen());
        const commitsBeforeTaskMutation = rendered.commits;

        act(() => {
            storeHarness.state = {
                ...storeHarness.state,
                tasks: [{ id: 'unrelated-task', title: 'Unrelated task' }],
            };
            storeHarness.listeners.forEach((listener) => listener());
        });

        expect(rendered.commits).toBe(commitsBeforeTaskMutation);
        act(() => rendered.tree.unmount());
    });

    it('shows native language names without translation-coverage labels', () => {
        const rendered = renderAndCountCommits(<GeneralSettingsScreen />);
        const languageRow = rendered.tree.root.findAllByType(SettingRow)
            .find((row) => row.props.label === 'settings.language')!;
        expect(languageRow.props.description).toBe('English');
        act(() => languageRow.props.onPress());
        const labels = rendered.tree.root.findAllByType(Text)
            .map((node) => node.props.children);
        for (const language of LANGUAGES) {
            expect(labels).toContain(language.native);
        }
        expect(labels.some((label) => typeof label === 'string' && label.includes('languagePartlyTranslated'))).toBe(false);
        act(() => rendered.tree.unmount());
    });

    it('keeps regional formats collapsed until requested', () => {
        const rendered = renderAndCountCommits(<GeneralSettingsScreen />);
        const labels = () => rendered.tree.root.findAllByType(SettingRow).map((row) => row.props.label);

        expect(labels()).toContain('settings.regionalFormats');
        expect(labels()).not.toContain('settings.weekStart');

        act(() => {
            rendered.tree.root.findByProps({ testID: 'regional-formats-toggle' }).props.onPress();
        });

        expect(labels()).toContain('settings.weekStart');
        expect(labels()).toContain('settings.dateFormat');
        expect(labels()).toContain('settings.timeFormat');
        act(() => rendered.tree.unmount());
    });

    it('does not rerender the Sync settings store slice for an unrelated task mutation', () => {
        const rendered = renderAndCountCommits(<SyncSettingsStoreProbe />);
        const commitsBeforeTaskMutation = rendered.commits;

        act(() => {
            storeHarness.state = {
                ...storeHarness.state,
                tasks: [{ id: 'unrelated-task', title: 'Unrelated task' }],
            };
            storeHarness.listeners.forEach((listener) => listener());
        });

        expect(rendered.commits).toBe(commitsBeforeTaskMutation);
        act(() => rendered.tree.unmount());
    });
});

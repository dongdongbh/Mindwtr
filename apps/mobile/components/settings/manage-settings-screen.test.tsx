import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ManageSettingsScreen } from './manage-settings-screen';

const asyncStorageMocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn().mockResolvedValue(undefined),
}));

const storeState = vi.hoisted(() => ({
  areas: [
    { id: 'area-1', name: 'Design', order: 0, color: '#3b82f6' },
  ],
  settings: {
    appearance: {
      density: 'compact',
    },
  },
  getDerivedState: () => ({
    allContexts: ['@office'],
    allTags: ['#design'],
  }),
  deleteArea: vi.fn().mockResolvedValue(undefined),
  updateArea: vi.fn().mockResolvedValue(undefined),
  updateSettings: vi.fn().mockResolvedValue(undefined),
  deleteTag: vi.fn(),
  renameTag: vi.fn(),
  deleteContext: vi.fn(),
  renameContext: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: asyncStorageMocks.getItem,
    setItem: asyncStorageMocks.setItem,
  },
}));

vi.mock('@mindwtr/core', () => ({
  AREA_PRESET_COLORS: ['#3b82f6', '#10b981'],
  DEFAULT_AREA_COLOR: '#3b82f6',
  useTaskStore: (selector?: (state: typeof storeState) => unknown) => (selector ? selector(storeState) : storeState),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#0f172a',
    cardBg: '#111827',
    inputBg: '#111827',
    border: '#334155',
    text: '#f8fafc',
    secondaryText: '#94a3b8',
    tint: '#3b82f6',
  }),
}));

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
}));

vi.mock('./settings.hooks', () => ({
  useSettingsLocalization: () => ({
    localize: (en: string) => en,
    t: (key: string) =>
      ({
        'settings.manage': 'Manage',
        'areas.manage': 'Manage areas',
        'contexts.title': 'Contexts',
        'projects.changeColor': 'Change color',
        'projects.noArea': 'No area',
        'projects.noTags': 'No tags',
      }[key] ?? key),
  }),
  useSettingsScrollContent: () => ({}),
}));

vi.mock('./settings.shell', () => ({
  SettingsTopBar: () => React.createElement('SettingsTopBar'),
  SubHeader: ({ title }: { title: string }) => React.createElement('SubHeader', { title }),
}));

const flushEffects = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('ManageSettingsScreen', () => {
  beforeEach(() => {
    asyncStorageMocks.getItem.mockReset();
    asyncStorageMocks.setItem.mockClear();
    storeState.deleteArea.mockClear();
    storeState.updateArea.mockClear();
    storeState.updateSettings.mockClear();
    storeState.deleteTag.mockClear();
    storeState.renameTag.mockClear();
    storeState.deleteContext.mockClear();
    storeState.renameContext.mockClear();
  });

  it('restores persisted open sections on mount', async () => {
    asyncStorageMocks.getItem.mockResolvedValue(JSON.stringify({ areas: true, tags: true }));

    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<ManageSettingsScreen />);
      await flushEffects();
    });

    expect(asyncStorageMocks.getItem).toHaveBeenCalledWith('mindwtr:settings:manage:openSections');
    expect(
      tree.root.findAll((node) => (node.type as unknown) === 'Text' && node.props.children === 'Design'),
    ).toHaveLength(1);
    expect(
      tree.root.findAll((node) => (node.type as unknown) === 'Text' && node.props.children === '#design'),
    ).toHaveLength(1);
  });

  it('persists section toggles after hydration', async () => {
    asyncStorageMocks.getItem.mockResolvedValue(null);

    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<ManageSettingsScreen />);
      await flushEffects();
    });

    const areasToggle = tree.root.find(
      (node) => node.props.testID === 'manage-section-toggle-areas' && typeof node.props.onPress === 'function',
    );

    await renderer.act(async () => {
      areasToggle.props.onPress();
      await flushEffects();
    });

    expect(asyncStorageMocks.setItem).toHaveBeenLastCalledWith(
      'mindwtr:settings:manage:openSections',
      JSON.stringify({ areas: true, contexts: false, tags: false }),
    );
  });

  it('stores the unassigned area color in appearance settings', async () => {
    asyncStorageMocks.getItem.mockResolvedValue(JSON.stringify({ areas: true }));

    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<ManageSettingsScreen />);
      await flushEffects();
    });

    await renderer.act(async () => {
      tree.root.findByProps({ testID: 'manage-unassigned-area-color' })
        .findAll((node) => typeof node.props.onPress === 'function')[0]
        .props.onPress();
      await flushEffects();
    });

    await renderer.act(async () => {
      tree.root.findByProps({ accessibilityLabel: 'Change color: #10b981' }).props.onPress();
      await flushEffects();
    });

    await renderer.act(async () => {
      tree.root.findByProps({ testID: 'manage-editor-save' }).props.onPress();
      await flushEffects();
    });

    expect(storeState.updateSettings).toHaveBeenCalledWith({
      appearance: {
        density: 'compact',
        unassignedAreaColor: '#10b981',
      },
    });
  });
});

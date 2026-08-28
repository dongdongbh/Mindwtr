import React from 'react';
import { Alert } from 'react-native';
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
  people: [
    {
      id: 'person-1',
      name: 'Alex',
      note: 'QA lead',
      referenceLink: 'obsidian://people/alex',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    },
  ],
  tasks: [
    { id: 'task-1', title: 'Review build', assignedTo: 'Alex' },
  ],
  settings: {
    appearance: {
      density: 'compact',
    },
    gtd: {
      viewSections: {
        someday: [{ id: 'books', title: 'Books to read', order: 0 }],
      },
    },
  },
  getDerivedState: () => ({
    allContexts: ['@office'],
    allTags: ['#design'],
  }),
  addArea: vi.fn().mockResolvedValue(null),
  deleteArea: vi.fn().mockResolvedValue(undefined),
  updateArea: vi.fn().mockResolvedValue(undefined),
  updateSettings: vi.fn().mockResolvedValue(undefined),
  deleteTag: vi.fn(),
  renameTag: vi.fn(),
  deleteContext: vi.fn(),
  renameContext: vi.fn(),
  addPerson: vi.fn().mockResolvedValue(null),
  updatePerson: vi.fn().mockResolvedValue({ success: true }),
  renamePerson: vi.fn().mockResolvedValue({ success: true }),
  deletePerson: vi.fn().mockResolvedValue({ success: true }),
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
  formatI18nTemplate: (template: string, values: Record<string, string>) => (
    template.replace(/{{(\w+)}}/g, (_match, key: string) => values[key] ?? '')
  ),
  getPersonNameKey: (value?: string) => value?.trim().toLowerCase() ?? '',
  sortViewSectionDefinitions: (definitions: any[] = []) => [...definitions].sort((a, b) => a.order - b.order),
  tFallback: (translate: (key: string) => string, key: string, fallback: string) => {
    const value = translate(key);
    return value && value !== key ? value : fallback;
  },
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
    tr: (key: string) => key,
    t: (key: string) =>
      ({
        'settings.manage': 'Manage',
        'areas.manage': 'Areas',
        'common.add': 'Add',
        'common.cancel': 'Cancel',
        'common.delete': 'Delete',
        'contexts.title': 'Contexts',
        'common.tasks': 'tasks',
        'projects.changeColor': 'Change color',
        'projects.noArea': 'No area',
        'projects.noTags': 'No tags',
        'viewSections.somedaySections': 'Someday sections',
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
    storeState.addArea.mockClear();
    storeState.deleteArea.mockClear();
    storeState.updateArea.mockClear();
    storeState.updateSettings.mockClear();
    storeState.deleteTag.mockClear();
    storeState.renameTag.mockClear();
    storeState.deleteContext.mockClear();
    storeState.renameContext.mockClear();
    storeState.addPerson.mockClear();
    storeState.updatePerson.mockClear();
    storeState.renamePerson.mockClear();
    storeState.deletePerson.mockClear();
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
      JSON.stringify({ areas: true, people: false, somedaySections: false, contexts: false, tags: false }),
    );
  });

  it('renders Someday sections collapsed by default and confirms deletion', async () => {
    asyncStorageMocks.getItem.mockResolvedValue(null);
    const alertSpy = vi.spyOn(Alert, 'alert');

    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<ManageSettingsScreen />);
      await flushEffects();
    });

    expect(tree.root.findByProps({ testID: 'manage-section-toggle-someday-sections' })).toBeTruthy();
    expect(
      tree.root.findAll((node) => (node.type as unknown) === 'Text' && node.props.children === 'Books to read'),
    ).toHaveLength(0);

    await renderer.act(async () => {
      tree.root
        .find(
          (node) =>
            node.props.testID === 'manage-section-toggle-someday-sections' &&
            typeof node.props.onPress === 'function',
        )
        .props.onPress();
      await flushEffects();
    });

    expect(
      tree.root.findAll((node) => (node.type as unknown) === 'Text' && node.props.children === 'Books to read'),
    ).toHaveLength(1);

    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Delete: Books to read' }).props.onPress();
    });
    expect(storeState.updateSettings).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledTimes(1);

    await renderer.act(async () => {
      alertSpy.mock.calls[0]?.[2]?.find((button) => button.style === 'destructive')?.onPress?.();
      await flushEffects();
    });
    expect(storeState.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      gtd: expect.objectContaining({
        viewSections: expect.objectContaining({ someday: [] }),
      }),
    }));
    alertSpy.mockRestore();
  });

  it('creates a managed person from the people section', async () => {
    asyncStorageMocks.getItem.mockResolvedValue(JSON.stringify({ people: true }));

    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<ManageSettingsScreen />);
      await flushEffects();
    });

    await renderer.act(async () => {
      tree.root.findByProps({ testID: 'manage-person-add' }).props.onPress();
      await flushEffects();
    });

    await renderer.act(async () => {
      tree.root.findByProps({ testID: 'manage-person-name-input' }).props.onChangeText('Morgan');
      tree.root.findByProps({ testID: 'manage-person-note-input' }).props.onChangeText('Ops lead');
      tree.root.findByProps({ testID: 'manage-person-reference-input' }).props.onChangeText('obsidian://people/morgan');
      await flushEffects();
    });

    await renderer.act(async () => {
      tree.root.findByProps({ testID: 'manage-editor-save' }).props.onPress();
      await flushEffects();
    });

    expect(storeState.addPerson).toHaveBeenCalledWith('Morgan', {
      note: 'Ops lead',
      referenceLink: 'obsidian://people/morgan',
    });
  });

  it('creates a managed area from the areas section', async () => {
    asyncStorageMocks.getItem.mockResolvedValue(JSON.stringify({ areas: true }));

    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<ManageSettingsScreen />);
      await flushEffects();
    });

    await renderer.act(async () => {
      tree.root.findByProps({ testID: 'manage-area-add' }).props.onPress();
      await flushEffects();
    });

    await renderer.act(async () => {
      tree.root.findByProps({ testID: 'manage-area-name-input' }).props.onChangeText('Work');
      tree.root.findByProps({ accessibilityLabel: 'Change color: #10b981' }).props.onPress();
      await flushEffects();
    });

    await renderer.act(async () => {
      tree.root.findByProps({ testID: 'manage-editor-save' }).props.onPress();
      await flushEffects();
    });

    expect(storeState.addArea).toHaveBeenCalledWith('Work', { color: '#10b981' });
  });

  it('updates managed person metadata before propagating a rename', async () => {
    asyncStorageMocks.getItem.mockResolvedValue(JSON.stringify({ people: true }));

    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<ManageSettingsScreen />);
      await flushEffects();
    });

    await renderer.act(async () => {
      tree.root.findByProps({ testID: 'manage-person-edit-person-1' }).props.onPress();
      await flushEffects();
    });

    await renderer.act(async () => {
      tree.root.findByProps({ testID: 'manage-person-name-input' }).props.onChangeText('Alexandra');
      tree.root.findByProps({ testID: 'manage-person-note-input' }).props.onChangeText('QA owner');
      tree.root.findByProps({ testID: 'manage-person-reference-input' }).props.onChangeText('obsidian://people/alexandra');
      await flushEffects();
    });

    await renderer.act(async () => {
      tree.root.findByProps({ testID: 'manage-editor-save' }).props.onPress();
      await flushEffects();
    });

    expect(storeState.updatePerson).toHaveBeenCalledWith('person-1', {
      note: 'QA owner',
      referenceLink: 'obsidian://people/alexandra',
    });
    expect(storeState.renamePerson).toHaveBeenCalledWith('person-1', 'Alexandra', { updateTasks: true });
    expect(storeState.updatePerson.mock.invocationCallOrder[0]).toBeLessThan(
      storeState.renamePerson.mock.invocationCallOrder[0],
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

import React from 'react';
import { Alert } from 'react-native';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ManageSettingsScreen } from './manage-settings-screen';

const routerPushMock = vi.hoisted(() => vi.fn());

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
  ] as any[],
  _allTasks: [
    { id: 'task-1', title: 'Review build', assignedTo: 'Alex' },
  ] as any[],
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

vi.mock('@mindwtr/core', async (importOriginal) => ({
  // The Someday section manager's rows and edits, and the Manage screen's texts,
  // rows and editor writes, are core's own logic.
  ...(({
    buildSomedaySectionManagerRows, getSomedaySectionManagerText, moveSomedaySection, renameSomedaySection,
    DEFAULT_MANAGE_OPEN_SECTIONS, MANAGE_OPEN_SECTIONS_STORAGE_KEY, buildManagePersonRow, getManageDeleteConfirm,
    getManageEditorDraft, getManageEditorText, getManageSettingsText, isManageAreaNameTaken, isManageEditorSaveDisabled,
    normalizeManageOpenSections, planManageEditorSave, sortManageAreas, sortManagePeople,
    buildSomedaySectionsSettingsUpdate, removeSomedaySection, sortViewSectionDefinitions, runStoreCommand, updateSettingsFromLatest,
  }) => ({
    buildSomedaySectionManagerRows, getSomedaySectionManagerText, moveSomedaySection, renameSomedaySection,
    buildSomedaySectionsSettingsUpdate, removeSomedaySection, sortViewSectionDefinitions, runStoreCommand, updateSettingsFromLatest,
    DEFAULT_MANAGE_OPEN_SECTIONS, MANAGE_OPEN_SECTIONS_STORAGE_KEY, buildManagePersonRow, getManageDeleteConfirm,
    getManageEditorDraft, getManageEditorText, getManageSettingsText, isManageAreaNameTaken, isManageEditorSaveDisabled,
    normalizeManageOpenSections, planManageEditorSave, sortManageAreas, sortManagePeople,
  }))(await importOriginal<typeof import('@mindwtr/core')>()),
  AREA_PRESET_COLORS: ['#3b82f6', '#10b981'],
  DEFAULT_AREA_COLOR: '#3b82f6',
  formatI18nTemplate: (template: string, values: Record<string, string>) => (
    template.replace(/{{(\w+)}}/g, (_match, key: string) => values[key] ?? '')
  ),
  getPersonNameKey: (value?: string) => value?.trim().toLowerCase() ?? '',
  getPersonTaskCounts: (tasks: any[]) => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      if (task.deletedAt || task.purgedAt) continue;
      const keys = new Set<string>();
      const assigned = task.assignedTo?.trim().toLowerCase();
      if (assigned) keys.add(assigned);
      for (const context of task.contexts ?? []) {
        const trimmed = context.trim();
        if (trimmed.startsWith('@') && trimmed.slice(1).trim()) keys.add(trimmed.slice(1).trim().toLowerCase());
      }
      keys.forEach((key) => counts.set(key, (counts.get(key) ?? 0) + 1));
    }
    return counts;
  },
  buildPersonSearchQuery: (value?: string) => `person:${JSON.stringify(value?.trim().replace(/\s+/g, ' ') ?? '')}`,
  tFallback: (translate: (key: string) => string, key: string, fallback: string) => {
    const value = translate(key);
    return value && value !== key ? value : fallback;
  },
  useTaskStore: Object.assign(
    (selector?: (state: typeof storeState) => unknown) => (selector ? selector(storeState) : storeState),
    { getState: () => storeState },
  ),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPushMock }),
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
        'common.edit': 'Edit',
        'contexts.title': 'Contexts',
        'common.tasks': 'tasks',
        'search.title': 'Search',
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
    routerPushMock.mockClear();
    storeState.tasks = [{ id: 'task-1', title: 'Review build', assignedTo: 'Alex' }];
    storeState._allTasks = storeState.tasks;
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

  it('tells a screen reader each section header is a button and whether it is open', async () => {
    asyncStorageMocks.getItem.mockResolvedValue(null);

    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<ManageSettingsScreen />);
      await flushEffects();
    });
    const header = () => tree.root.find(
      (node) => node.props.testID === 'manage-section-toggle-areas' && typeof node.props.onPress === 'function',
    );
    expect(header().props.accessibilityRole).toBe('button');
    expect(header().props.accessibilityState).toEqual({ expanded: false });

    await renderer.act(async () => {
      header().props.onPress();
      await flushEffects();
    });
    expect(header().props.accessibilityState).toEqual({ expanded: true });
  });

  it('names the item on each row\'s edit and delete buttons', async () => {
    asyncStorageMocks.getItem.mockResolvedValue(JSON.stringify({ areas: true, contexts: true, tags: true }));
    const alertSpy = vi.spyOn(Alert, 'alert');

    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<ManageSettingsScreen />);
      await flushEffects();
    });

    for (const label of [
      'Edit: Unassigned', 'Edit: Design', 'Delete: Design',
      'Edit: @office', 'Delete: @office', 'Edit: #design', 'Delete: #design',
    ]) {
      expect(tree.root.findByProps({ accessibilityLabel: label }).props.accessibilityRole).toBe('button');
    }
    // A labelled button acts on its own item.
    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Delete: @office' }).props.onPress();
    });
    expect(alertSpy.mock.calls[0]?.[1]).toBe('Delete "@office"?');
    alertSpy.mockRestore();
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

  it('requires a fresh confirmation when a Someday section is renamed while its delete alert is open', async () => {
    asyncStorageMocks.getItem.mockResolvedValue(JSON.stringify({ somedaySections: true }));
    const alertSpy = vi.spyOn(Alert, 'alert');
    const settings = storeState.settings;
    try {
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => {
        tree = renderer.create(<ManageSettingsScreen />);
        await flushEffects();
      });
      renderer.act(() => {
        tree.root.findByProps({ accessibilityLabel: 'Delete: Books to read' }).props.onPress();
      });
      expect(alertSpy.mock.calls[0]?.[1]).toBe('Delete "Books to read"?');

      storeState.settings = {
        ...settings,
        gtd: { viewSections: { someday: [{ id: 'books', title: 'Renamed books', order: 0 }] } },
      };
      await renderer.act(async () => {
        alertSpy.mock.calls[0]?.[2]?.find((button) => button.style === 'destructive')?.onPress?.();
        await flushEffects();
      });
      expect(storeState.updateSettings).not.toHaveBeenCalled();
      expect(alertSpy.mock.calls[1]?.[1]).toBe('Delete "Renamed books"?');

      await renderer.act(async () => {
        alertSpy.mock.calls[1]?.[2]?.find((button) => button.style === 'destructive')?.onPress?.();
        await flushEffects();
      });
      expect(storeState.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
        gtd: expect.objectContaining({ viewSections: expect.objectContaining({ someday: [] }) }),
      }));
    } finally {
      storeState.settings = settings;
      alertSpy.mockRestore();
    }
  });

  it('requires reconfirmation for a changed same-ID Someday row even when its title is unchanged', async () => {
    asyncStorageMocks.getItem.mockResolvedValue(JSON.stringify({ somedaySections: true }));
    const alertSpy = vi.spyOn(Alert, 'alert');
    const settings = storeState.settings;
    try {
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => {
        tree = renderer.create(<ManageSettingsScreen />);
        await flushEffects();
      });
      renderer.act(() => {
        tree.root.findByProps({ accessibilityLabel: 'Delete: Books to read' }).props.onPress();
      });

      storeState.settings = {
        ...settings,
        gtd: { viewSections: { someday: [{ id: 'books', title: 'Books to read', order: 9 }] } },
      };
      await renderer.act(async () => {
        alertSpy.mock.calls[0]?.[2]?.find((button) => button.style === 'destructive')?.onPress?.();
        await flushEffects();
      });
      expect(storeState.updateSettings).not.toHaveBeenCalled();
      expect(alertSpy.mock.calls[1]?.[1]).toBe('Delete "Books to read"?');
    } finally {
      storeState.settings = settings;
      alertSpy.mockRestore();
    }
  });

  it('does not delete or reconfirm a Someday section already removed while its alert is open', async () => {
    asyncStorageMocks.getItem.mockResolvedValue(JSON.stringify({ somedaySections: true }));
    const alertSpy = vi.spyOn(Alert, 'alert');
    const settings = storeState.settings;
    try {
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => {
        tree = renderer.create(<ManageSettingsScreen />);
        await flushEffects();
      });
      renderer.act(() => {
        tree.root.findByProps({ accessibilityLabel: 'Delete: Books to read' }).props.onPress();
      });
      expect(alertSpy).toHaveBeenCalledTimes(1);

      storeState.settings = { ...settings, gtd: { viewSections: { someday: [] } } };
      await renderer.act(async () => {
        alertSpy.mock.calls[0]?.[2]?.find((button) => button.style === 'destructive')?.onPress?.();
        await flushEffects();
      });
      expect(storeState.updateSettings).not.toHaveBeenCalled();
      expect(alertSpy).toHaveBeenCalledTimes(1);
    } finally {
      storeState.settings = settings;
      alertSpy.mockRestore();
    }
  });

  it('edits one Someday section and keeps every other stored entry as it is, in stored order', async () => {
    asyncStorageMocks.getItem.mockResolvedValue(JSON.stringify({ somedaySections: true }));
    const alertSpy = vi.spyOn(Alert, 'alert');
    const settings = storeState.settings;
    // A newer app's entry this build cannot show.
    const folder = { kind: 'folder', children: ['books'] };
    const books = { id: 'books', title: 'Books to read', order: 0 };
    const films = { id: 'films', title: 'Films', order: 1 };
    storeState.settings = { ...settings, gtd: { viewSections: { someday: [films, folder, books] as any[] } } };

    let tree!: renderer.ReactTestRenderer;
    try {
      await renderer.act(async () => {
        tree = renderer.create(<ManageSettingsScreen />);
        await flushEffects();
      });
      await renderer.act(async () => {
        tree.root.findByProps({ accessibilityLabel: 'Move up: Films' }).props.onPress();
        await flushEffects();
      });
      expect(storeState.updateSettings).toHaveBeenLastCalledWith({
        gtd: { viewSections: { someday: [{ ...films, order: 0 }, folder, { ...books, order: 1 }] } },
      });

      renderer.act(() => {
        tree.root.findByProps({ accessibilityLabel: 'Delete: Books to read' }).props.onPress();
      });
      // Sync adds Trips while the confirmation is open: the delete keeps it.
      const trips = { id: 'trips', title: 'Trips', order: 2 };
      storeState.settings = { ...settings, gtd: { viewSections: { someday: [films, folder, { ...books }, trips] as any[] } } };
      await renderer.act(async () => {
        alertSpy.mock.calls[0]?.[2]?.find((button) => button.style === 'destructive')?.onPress?.();
        await flushEffects();
      });
      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(storeState.updateSettings).toHaveBeenLastCalledWith({
        gtd: { viewSections: { someday: [films, folder, trips] } },
      });
    } finally {
      storeState.settings = settings;
      alertSpy.mockRestore();
    }
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

  it('shows a review count beside person notes and opens completed-inclusive person search', async () => {
    asyncStorageMocks.getItem.mockResolvedValue(JSON.stringify({ people: true }));
    storeState.tasks = [
      { id: 'assigned', title: 'Assigned', assignedTo: 'Alex', contexts: [] },
      { id: 'context', title: 'Context', contexts: ['@alex'] },
      { id: 'both', title: 'Both', assignedTo: 'Alex', contexts: ['@Alex'] },
      { id: 'done', title: 'Done', contexts: ['@Alex'], status: 'done' },
      { id: 'other', title: 'Other', contexts: ['@Alex/Office'] },
    ];
    storeState._allTasks = storeState.tasks;

    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<ManageSettingsScreen />);
      await flushEffects();
    });

    const reviewButton = tree.root.findByProps({ testID: 'manage-person-review-person-1' });
    expect(reviewButton.props.accessibilityLabel).toBe('Alex: 4 tasks');
    expect(reviewButton.props.accessibilityHint).toBe('Search');
    expect(tree.root.findAll((node) => (node.type as unknown) === 'Text' && node.props.children === 'QA lead')).toHaveLength(1);

    renderer.act(() => {
      reviewButton.props.onPress();
    });
    expect(routerPushMock).toHaveBeenCalledWith({
      pathname: '/global-search',
      params: { q: 'person:"Alex"', includeCompleted: 'true' },
    });
  });

  it('counts an archived-only person task from the canonical task collection', async () => {
    asyncStorageMocks.getItem.mockResolvedValue(JSON.stringify({ people: true }));
    storeState.tasks = [];
    storeState._allTasks = [{ id: 'archived', title: 'Archived', assignedTo: 'Alex', status: 'archived' }];

    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<ManageSettingsScreen />);
      await flushEffects();
    });

    expect(tree.root.findByProps({ accessibilityLabel: 'Alex: 1 task' })).toBeTruthy();
  });

  it('shows a person\'s task count once when they have no note or link', async () => {
    asyncStorageMocks.getItem.mockResolvedValue(JSON.stringify({ people: true }));
    const people = storeState.people;
    storeState.people = [{ ...people[0], note: undefined, referenceLink: undefined }] as unknown as typeof people;

    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<ManageSettingsScreen />);
      await flushEffects();
    });
    storeState.people = people;

    const row = tree.root.findByProps({ testID: 'manage-person-row-person-1' });
    const texts = row.findAll((node) => (node.type as unknown) === 'Text').map((node) => [node.props.children].flat().join(''));
    expect(texts).toEqual(['A', 'Alex', '1 task']);
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

  it('refuses a new area named like an existing one: Save is off and the editor says why', async () => {
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
    const message = () => tree.root.findAll((node) => (node.type as unknown) === 'Text' && node.props.children === 'An area with this name already exists.');
    expect(message()).toHaveLength(0);

    await renderer.act(async () => {
      tree.root.findByProps({ testID: 'manage-area-name-input' }).props.onChangeText(' design ');
      await flushEffects();
    });

    expect(tree.root.findByProps({ testID: 'manage-editor-save' }).props.disabled).toBe(true);
    expect(message()).toHaveLength(1);
    expect(storeState.addArea).not.toHaveBeenCalled();
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

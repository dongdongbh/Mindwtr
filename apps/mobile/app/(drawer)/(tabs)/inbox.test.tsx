import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Project, Task } from '@mindwtr/core';
import { AppState } from 'react-native';

const taskStore = vi.hoisted(() => ({
  settings: { gtd: { defaultCaptureMethod: 'text' } },
  tasks: [{ id: 'inbox-task', status: 'inbox' }] as Task[],
  projects: [] as Project[],
}));

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
  TouchableOpacity: ({ children, ...props }: any) => React.createElement('TouchableOpacity', props, children),
  View: ({ children, ...props }: any) => React.createElement('View', props, children),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('lucide-react-native', () => ({
  Brain: () => null,
  ListChecks: () => null,
}));

vi.mock('@mindwtr/core', async (importOriginal) => ({
  buildInboxScreenModel: (await importOriginal<typeof import('@mindwtr/core')>()).buildInboxScreenModel,
  selectProcessInboxQueue: (await importOriginal<typeof import('@mindwtr/core')>()).selectProcessInboxQueue,
  useTaskStore: (selector: (state: typeof taskStore) => unknown) => selector(taskStore),
}));

vi.mock('../../../components/task-list', () => ({
  TaskList: (props: any) => React.createElement(
    'TaskList',
    props,
    props.primaryActionRow,
    props.listHeaderComponent,
  ),
}));

vi.mock('../../../components/inbox-processing-modal', () => ({
  InboxProcessingModal: () => null,
}));

vi.mock('../../../components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) => ({
      'inbox.processButton': 'Process Inbox',
      'projects.allAreas': 'All areas',
    }[key] ?? key),
  }),
}));

vi.mock('@/hooks/use-startup-screen-ready', () => ({
  useStartupScreenReady: () => vi.fn(),
}));
vi.mock('@/hooks/use-widget-launch', () => ({ WidgetLaunchDestination: () => null }));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#fff',
    border: '#ddd',
    filterBg: '#f5f5f5',
    onTint: '#fff',
    secondaryText: '#666',
    text: '#111',
    tint: '#06f',
  }),
}));

vi.mock('@/hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({ isMaterial: false }),
}));

vi.mock('@/hooks/use-filled-button-colors', () => ({
  useFilledButtonColors: () => ({ backgroundColor: '#06f', textColor: '#fff' }),
}));

vi.mock('@/components/compact-text', () => ({
  CompactText: ({ children, ...props }: any) => React.createElement('CompactText', props, children),
}));

vi.mock('@/hooks/use-visible-tasks', () => ({
  useVisibleTaskContext: () => ({ projectById: new Map() }),
}));

vi.mock('../../../contexts/quick-capture-context', () => ({
  useQuickCapture: () => ({ openQuickCapture: vi.fn() }),
}));

vi.mock('@/lib/onboarding-hints', () => ({
  dismissMobileHint: vi.fn(),
}));


// eslint-disable-next-line import/first
import { styles as taskListStyles } from '../../../components/task-list/task-list.styles';

let InboxScreen: typeof import('./inbox').default;


beforeAll(async () => {
  vi.stubGlobal('React', React);
  InboxScreen = (await import('./inbox')).default;
}, 30_000);

const flattenStyle = (style: unknown): Record<string, number> => (
  (Array.isArray(style) ? style : [style])
    .filter((entry): entry is Record<string, number> => Boolean(entry) && typeof entry === 'object')
    .reduce((merged, entry) => ({ ...merged, ...entry }), {})
);

const inset = (style: Record<string, number>, edge: 'Top' | 'Bottom') => (
  style[`padding${edge}`] ?? style.paddingVertical ?? style.padding ?? 0
);

describe('InboxScreen spacing', () => {
  it('keeps a compact 12dp gap before All areas and separate task-list spacing after it', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<InboxScreen />);
    });

    const taskList = tree.root.findByType('TaskList' as never);
    const actionRowStyle = flattenStyle(taskList.props.primaryActionRow.props.children.props.style);
    const scopeStyle = flattenStyle(taskList.props.listHeaderComponent.props.style);
    const listContentStyle = flattenStyle(taskListStyles.listContent);
    const sectionHeaderStyle = flattenStyle(taskListStyles.sectionHeader);

    const actionToScopeGap = inset(actionRowStyle, 'Bottom')
      + inset(listContentStyle, 'Top')
      + inset(scopeStyle, 'Top');
    const scopeToTaskGap = inset(scopeStyle, 'Bottom') + inset(sectionHeaderStyle, 'Top');

    expect(actionToScopeGap).toBe(12);
    expect(scopeToTaskGap).toBe(18);
  });
});


describe('Inbox processing launcher queue', () => {
  afterEach(() => {
    taskStore.tasks = [{ id: 'inbox-task', status: 'inbox' }] as Task[];
    taskStore.projects = [];
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const task = (id: string, extra: Partial<Task> = {}): Task => ({
    id, title: id, status: 'inbox', contexts: [], tags: [], createdAt: '2026-01-01', updatedAt: '2026-01-01', ...extra,
  });
  const process = (tree: ReturnType<typeof create>) => tree.root.findAll((node) => String(node.type) === 'TouchableOpacity' && /^Process Inbox \(/.test(node.props.accessibilityLabel ?? ''));

  it('includes due Someday without changing the Inbox list and excludes ineligible candidates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T15:00:00Z'));
    taskStore.projects = [
      { id: 'hidden', status: 'someday' }, { id: 'deleted', status: 'active', deletedAt: '2026-11-01' },
    ] as Project[];
    taskStore.tasks = [task('inbox'), task('due', { status: 'someday', reviewAt: '2026-11-15' }),
      task('future', { status: 'someday', reviewAt: '2026-11-16' }), task('waiting', { status: 'waiting', reviewAt: '2026-11-01' }),
      task('next', { status: 'next', reviewAt: '2026-11-01' }), task('hidden', { projectId: 'hidden' }),
      task('deleted-project', { projectId: 'deleted' }), task('deleted-task', { deletedAt: '2026-11-01' })];
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<InboxScreen />); });
    expect(process(tree)[0].props.accessibilityLabel).toBe('Process Inbox (2)');
    expect(tree.root.findByType('TaskList' as never).props.statusFilter).toBe('inbox');
    act(() => tree.unmount());
  });

  it('exposes a due-only queue and caps only the visible count', () => {
    taskStore.tasks = Array.from({ length: 101 }, (_, index) => task(String(index), { status: 'someday', reviewAt: '2020-01-01' }));
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<InboxScreen />); });
    expect(process(tree)[0].props.accessibilityLabel).toBe('Process Inbox (101)');
    expect(tree.root.findAll((node) => String(node.type) === 'CompactText').some((node) => node.props.children === 'Process Inbox (99+)')).toBe(true);
    act(() => tree.unmount());
  });

  it('refreshes when a review becomes due at midnight and on foreground return', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 15, 23, 59, 30));
    let onState!: (state: 'active' | 'background') => void;
    vi.mocked(AppState.addEventListener).mockImplementation((_, callback) => { onState = callback; return { remove: vi.fn() }; });
    taskStore.tasks = [task('tomorrow', { status: 'someday', reviewAt: '2026-11-16' })];
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<InboxScreen />); });
    expect(process(tree)).toHaveLength(0);
    act(() => { vi.advanceTimersByTime(30_001); });
    expect(process(tree)[0].props.accessibilityLabel).toBe('Process Inbox (1)');
    act(() => { onState('background'); vi.setSystemTime(new Date(2026, 10, 15, 12)); onState('active'); });
    expect(process(tree)).toHaveLength(0);
    act(() => tree.unmount());
  });
});

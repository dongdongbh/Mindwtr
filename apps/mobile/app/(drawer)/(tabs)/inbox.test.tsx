import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const taskStore = vi.hoisted(() => ({
  settings: { gtd: { defaultCaptureMethod: 'text' } },
  tasks: [{ id: 'inbox-task', status: 'inbox' }],
}));

vi.mock('react-native', () => ({
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
  isTaskVisibleInInbox: () => true,
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

// Mocks above must be registered before the real shared styles are evaluated.
// eslint-disable-next-line import/first
import { styles as taskListStyles } from '../../../components/task-list/task-list.styles';

let InboxScreen: typeof import('./inbox').default;

// The core mock imports all of core, which takes seconds on a loaded machine.
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

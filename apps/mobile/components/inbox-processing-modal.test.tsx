import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { InboxProcessingModal } from './inbox-processing-modal';

const updateTask = vi.fn();
const deleteTask = vi.fn();
const addProject = vi.fn();
const mockSettings = { gtd: { inboxProcessing: {} }, ai: {} } as any;

vi.mock('@mindwtr/core', async () => {
  const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  return {
    ...actual,
    useTaskStore: () => ({
      tasks: [
        {
          id: 'inbox-1',
          title: 'Inbox task',
          description: 'Original description',
          status: 'inbox',
          contexts: ['@home'],
          tags: ['#old'],
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      projects: [],
      areas: [],
      settings: mockSettings,
      updateTask,
      deleteTask,
      addProject,
    }),
    loadAIKey: vi.fn(),
  };
});

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}));

vi.mock('../contexts/theme-context', () => ({
  useTheme: () => ({ isDark: false }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#fff',
    cardBg: '#f8fafc',
    taskItemBg: '#fff',
    inputBg: '#fff',
    filterBg: '#f1f5f9',
    border: '#cbd5e1',
    text: '#0f172a',
    secondaryText: '#64748b',
    icon: '#64748b',
    tint: '#3b82f6',
    onTint: '#fff',
    tabIconDefault: '#94a3b8',
    tabIconSelected: '#3b82f6',
    danger: '#ef4444',
    success: '#10b981',
    warning: '#f59e0b',
  }),
}));

vi.mock('../lib/ai-config', () => ({
  loadAIKey: vi.fn().mockResolvedValue(''),
  isAIKeyRequired: vi.fn().mockReturnValue(false),
  buildAIConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../lib/app-log', () => ({
  logWarn: vi.fn(),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@react-native-community/datetimepicker', () => ({
  __esModule: true,
  default: (props: any) => React.createElement('DateTimePicker', props, props.children),
}));

describe('InboxProcessingModal', () => {
  it('replaces the header next action with skip and saves edits before advancing', () => {
    mockSettings.gtd.inboxProcessing = {};
    updateTask.mockClear();
    deleteTask.mockClear();
    addProject.mockClear();
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;
    const titleInput = root.findByProps({ placeholder: 'taskEdit.titleLabel' });
    const descriptionInput = root.findByProps({ placeholder: 'taskEdit.descriptionPlaceholder' });

    act(() => {
      titleInput.props.onChangeText('Renamed inbox task');
      descriptionInput.props.onChangeText('Updated description');
    });

    const skipLabel = root.findByProps({ children: 'Skip' });
    const skipButton = skipLabel.parent;

    if (!skipButton) {
      throw new Error('Skip button not found');
    }

    act(() => {
      skipButton.props.onPress();
    });

    expect(updateTask).toHaveBeenCalledWith(
      'inbox-1',
      expect.objectContaining({
        title: 'Renamed inbox task',
        description: 'Updated description',
        projectId: undefined,
        contexts: ['@home'],
        tags: ['#old'],
      })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('hides the two-minute section when that shortcut is disabled', () => {
    mockSettings.gtd.inboxProcessing = { twoMinuteEnabled: false };
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;

    expect(root.findAllByProps({ children: '✅ inbox.doneIt' })).toHaveLength(0);
  });

  it('hides the contexts and tags section when disabled', () => {
    mockSettings.gtd.inboxProcessing = { contextStepEnabled: false };
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;

    act(() => {
      tree = create(<InboxProcessingModal visible onClose={onClose} />);
    });

    const root = tree!.root;

    expect(root.findAllByProps({ placeholder: 'inbox.addContextPlaceholder' })).toHaveLength(0);
  });
});

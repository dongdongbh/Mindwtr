import React from 'react';
import renderer from 'react-test-renderer';
import { Modal, Switch, TextInput } from 'react-native';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AppData } from '@mindwtr/core';

import { GtdSettingsScreen } from './gtd-settings-screen';

const updateSettings = vi.fn().mockResolvedValue(undefined);
const showToast = vi.fn();

type MockStoreState = {
  settings: AppData['settings'];
  updateSettings: typeof updateSettings;
};

const storeState: MockStoreState = {
  settings: {
    gtd: {
      taskEditor: {},
    },
    features: {
      priorities: true,
      timeEstimates: true,
    },
  },
  updateSettings,
};

vi.mock('@mindwtr/core', () => ({
  normalizeClockTimeInput: (value?: string | null) => {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) return '';
    const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  },
  sanitizePomodoroDurations: (value?: { focusMinutes?: number; breakMinutes?: number }) => ({
    focusMinutes: Number.isFinite(value?.focusMinutes) ? Math.round(value!.focusMinutes!) : 25,
    breakMinutes: Number.isFinite(value?.breakMinutes) ? Math.round(value!.breakMinutes!) : 5,
  }),
  tFallback: (t: (key: string) => string, key: string, fallback: string) => {
    const translated = t(key);
    return translated && translated !== key ? translated : fallback;
  },
  translateText: (value: string) => value,
  useTaskStore: () => storeState,
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#0f172a',
    cardBg: '#111827',
    inputBg: '#111827',
    filterBg: '#1f2937',
    border: '#334155',
    text: '#f8fafc',
    secondaryText: '#94a3b8',
    tint: '#3b82f6',
  }),
}));

vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({
    dismissToast: vi.fn(),
    showToast,
  }),
}));

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('./settings.hooks', () => ({
  useSettingsLocalization: () => ({
    isChineseLanguage: false,
    language: 'en',
    localize: (en: string) => en,
    t: (key: string) =>
      ({
        'settings.taskEditorLayout': 'Task editor layout',
        'settings.taskEditorLayoutDesc': 'Customize task editor layout.',
        'settings.taskEditorDefaultOpen': 'Open sections by default',
        'settings.visible': 'Shown',
        'settings.hidden': 'Hidden',
        'settings.resetToDefault': 'Reset to default',
        'common.done': 'Done',
        'taskEdit.basic': 'Basic',
        'taskEdit.scheduling': 'Scheduling',
        'taskEdit.organization': 'Organization',
        'taskEdit.details': 'Details',
        'taskEdit.statusLabel': 'Status',
        'taskEdit.projectLabel': 'Project',
      }[key] ?? key),
  }),
  useSettingsScrollContent: () => ({}),
}));

vi.mock('./settings.shell', () => ({
  SettingsTopBar: () => React.createElement('SettingsTopBar'),
  SubHeader: ({ title }: { title: string }) => React.createElement('SubHeader', { title }),
  MenuItem: (props: any) => React.createElement('MenuItem', props, props.children),
}));

vi.mock('@/components/task-edit/task-edit-modal.utils', () => ({
  buildTaskEditorPresetConfig: () => ({ order: ['status', 'project'], hidden: [], sections: {}, sectionOpen: {} }),
  DEFAULT_TASK_EDITOR_ORDER: ['status', 'project'],
  DEFAULT_TASK_EDITOR_SECTION_BY_FIELD: { status: 'basic', project: 'basic' },
  DEFAULT_TASK_EDITOR_SECTION_OPEN: { basic: true, scheduling: false, organization: false, details: false },
  DEFAULT_TASK_EDITOR_VISIBLE: ['status', 'project'],
  TASK_EDITOR_FIXED_FIELDS: ['status', 'project'],
  TASK_EDITOR_SECTION_ORDER: ['basic', 'scheduling', 'organization', 'details'],
  getTaskEditorSectionAssignments: () => ({ status: 'basic', project: 'basic' }),
  getTaskEditorSectionOpenDefaults: () => ({ basic: true, scheduling: false, organization: false, details: false }),
  isTaskEditorSectionableField: () => false,
  resolveTaskEditorPresetId: () => 'custom',
}));

describe('GtdSettingsScreen task editor layout', () => {
  beforeEach(() => {
    updateSettings.mockClear();
    showToast.mockClear();
    storeState.settings = {
      gtd: {
        taskEditor: {},
      },
      features: {
        priorities: true,
        timeEstimates: true,
      },
    };
  });

  it('quick-toggles the eye icon without opening the field sheet', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<GtdSettingsScreen onNavigate={vi.fn()} screen="gtd-task-editor" />);
    });

    const visibilityButton = tree.root.find((node) => node.props.testID === 'task-editor-visibility-status');

    renderer.act(() => {
      visibilityButton.props.onPress();
    });

    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      gtd: expect.objectContaining({
        taskEditor: expect.objectContaining({
          order: ['status', 'project'],
          hidden: ['status'],
        }),
      }),
    }));
    expect(tree.root.findByType(Modal).props.visible).toBe(false);
  });

  it('still opens the field sheet when the row body is tapped', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<GtdSettingsScreen onNavigate={vi.fn()} screen="gtd-task-editor" />);
    });

    const rowButton = tree.root.find((node) => node.props.testID === 'task-editor-row-status');

    renderer.act(() => {
      rowButton.props.onPress();
    });

    expect(tree.root.findByType(Modal).props.visible).toBe(true);
  });

  it('shows one notice when enabling Pomodoro auto-start', async () => {
    storeState.settings = {
      features: {
        priorities: true,
        timeEstimates: true,
        pomodoro: true,
      },
      gtd: {
        pomodoro: {
          autoStartBreaks: false,
          autoStartFocus: false,
        },
        taskEditor: {},
      },
    };

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<GtdSettingsScreen onNavigate={vi.fn()} screen="gtd" />);
    });

    const autoStartSwitches = tree.root.findAllByType(Switch).filter((node) => node.props.value === false);
    expect(autoStartSwitches).toHaveLength(2);

    await renderer.act(async () => {
      autoStartSwitches[0].props.onValueChange(true);
      await Promise.resolve();
    });

    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      gtd: expect.objectContaining({
        pomodoro: expect.objectContaining({ autoStartBreaks: true }),
      }),
    }));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Pomodoro will now advance phases automatically.',
      tone: 'info',
    }));

    await renderer.act(async () => {
      autoStartSwitches[1].props.onValueChange(true);
      await Promise.resolve();
    });

    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('saves the default schedule time from GTD settings', async () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<GtdSettingsScreen onNavigate={vi.fn()} screen="gtd" />);
    });

    await renderer.act(async () => {
      const scheduleTimeInput = tree.root.findAllByType(TextInput)[0];
      scheduleTimeInput.props.onChangeText('9:30');
      await Promise.resolve();
    });

    await renderer.act(async () => {
      const scheduleTimeInput = tree.root.findAllByType(TextInput)[0];
      scheduleTimeInput.props.onBlur();
      await Promise.resolve();
    });

    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      gtd: expect.objectContaining({
        defaultScheduleTime: '09:30',
      }),
    }));
  });
});

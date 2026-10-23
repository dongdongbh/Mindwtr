import React from 'react';
import renderer from 'react-test-renderer';
import { Modal, Switch, Text, TextInput, TouchableOpacity } from 'react-native';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DEFAULT_TASK_EDITOR_ORDER, type AppData } from '@mindwtr/core';

import { GtdSettingsScreen } from './gtd-settings-screen';
import { ExactAlarmNoticeRow } from './exact-alarm-notice';

const alarmPermission = vi.hoisted(() => ({
  relevant: vi.fn(() => true),
  refresh: vi.fn(async () => true),
  open: vi.fn(async () => undefined),
}));
vi.mock('@/lib/exact-alarm-permission', () => ({
  isExactAlarmPermissionRelevant: alarmPermission.relevant,
  refreshExactAlarmPermission: alarmPermission.refresh,
  openExactAlarmSettings: alarmPermission.open,
}));

const updateSettings = vi.fn().mockResolvedValue(undefined);
const showToast = vi.fn();
const taskOpenModeState = vi.hoisted(() => ({
  mode: 'automatic' as 'automatic' | 'preview' | 'edit',
  setMode: vi.fn(),
}));

vi.mock('@/lib/view-state/task-open-mode', () => ({
  TASK_OPEN_MODES: ['automatic', 'preview', 'edit'],
  useTaskOpenMode: () => ({ hydrated: true, mode: taskOpenModeState.mode, setMode: taskOpenModeState.setMode }),
}));

const flattenStyle = (style: unknown): Record<string, unknown> => {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map(flattenStyle));
  }
  return style && typeof style === 'object' ? style as Record<string, unknown> : {};
};

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
  },
}));

type MockStoreState = {
  settings: AppData['settings'];
  areas: AppData['areas'];
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
  areas: [],
  updateSettings,
};

// Core's GTD model runs for real; only the store is the test's.
vi.mock('@mindwtr/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mindwtr/core')>()),
  shallow: Object.is,
  useTaskStore: Object.assign(() => storeState, { getState: () => storeState }),
}));

vi.mock('@/hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { large: 16 } }),
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
  ToastViewport: () => null,
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
    tr: (key: string) =>
      ({
        'settings.gtdMobile.pomodoroWillNowAdvancePhasesAutomatically': 'Pomodoro will now advance phases automatically.',
        'settings.gtdMobile.openTasksIn': 'Open tasks in',
        'settings.gtdMobile.openTasksInDesc': 'Choose the tab used for normal task taps on this device.',
        'settings.gtdMobile.taskOpenAutomatic': 'Automatic',
        'settings.gtdMobile.taskOpenPreview': 'Preview',
        'settings.gtdMobile.taskOpenEdit': 'Edit',
      }[key] ?? key),
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

vi.mock('./android-capture-intent-section', () => ({
  AndroidCaptureIntentSection: () => React.createElement('AndroidCaptureIntentSection'),
}));
vi.mock('./gmail-capture-section', () => ({
  GmailCaptureSection: () => React.createElement('GmailCaptureSection'),
}));

describe('GtdSettingsScreen task editor layout', () => {
  it('places the Gmail account card on the Capture subpage', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<GtdSettingsScreen onNavigate={vi.fn()} screen="gtd-capture" />); });
    expect(tree.root.findByType('GmailCaptureSection' as never)).toBeTruthy();
    renderer.act(() => tree.unmount());
  });
  beforeEach(() => {
    updateSettings.mockClear();
    taskOpenModeState.setMode.mockClear();
    taskOpenModeState.mode = 'automatic';
    showToast.mockClear();
    alarmPermission.relevant.mockReturnValue(true);
    alarmPermission.refresh.mockReset().mockResolvedValue(true);
    alarmPermission.open.mockClear();
    storeState.settings = {
      gtd: {
        taskEditor: {},
      },
      features: {
        priorities: true,
        timeEstimates: true,
      },
    };
    storeState.areas = [];
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
          order: DEFAULT_TASK_EDITOR_ORDER,
          hidden: ['section', 'priority', 'energyLevel', 'timeEstimate', 'assignedTo', 'location', 'status'],
        }),
      }),
    }));
    expect(tree.root.findByType(Modal).props.visible).toBe(false);
  });

  it('shows the device-local task opening choices and publishes the selected mode', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<GtdSettingsScreen onNavigate={vi.fn()} screen="gtd-task-editor" />);
    });

    const automatic = tree.root.findByProps({ testID: 'task-open-mode-automatic' });
    const preview = tree.root.findByProps({ testID: 'task-open-mode-preview' });
    const edit = tree.root.findByProps({ testID: 'task-open-mode-edit' });
    expect(automatic.props.accessibilityRole).toBe('radio');
    expect(automatic.props.accessibilityState).toEqual({ selected: true });
    expect(preview.props.accessibilityState).toEqual({ selected: false });
    expect(edit.props.accessibilityState).toEqual({ selected: false });

    renderer.act(() => { preview.props.onPress(); });
    expect(taskOpenModeState.setMode).toHaveBeenCalledExactlyOnceWith('preview');
    expect(updateSettings).not.toHaveBeenCalled();
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

  it.each([
    { enabled: true, alert: true, allowed: false, relevant: true, notice: true },
    { enabled: true, alert: false, allowed: false, relevant: true, notice: false },
    { enabled: false, alert: true, allowed: false, relevant: true, notice: false },
    { enabled: true, alert: true, allowed: true, relevant: true, notice: false },
    { enabled: true, alert: true, allowed: false, relevant: false, notice: false },
  ])('groups Android permission help with the enabled Pomodoro alert: %j', async ({ enabled, alert, allowed, relevant, notice }) => {
    storeState.settings = { features: { pomodoro: enabled }, gtd: { pomodoro: { completionAlert: alert } } };
    alarmPermission.relevant.mockReturnValue(relevant);
    alarmPermission.refresh.mockResolvedValue(allowed);
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<GtdSettingsScreen onNavigate={vi.fn()} screen="gtd-pomodoro" />);
    });
    const notices = tree.root.findAllByType(ExactAlarmNoticeRow);
    expect(notices).toHaveLength(notice ? 1 : 0);
    if (notice) {
      expect(notices[0].props).toMatchObject({
        inline: true,
        label: 'settings.pomodoroAlertPermissionTitle',
        description: 'settings.pomodoroAlertPermissionDesc',
        actionLabel: 'settings.pomodoroAlertPermissionAction',
      });
      expect(notices[0].props.divider).toBeUndefined();
      const control = tree.root.findAllByType(Switch).find((node) => node.props.testID === 'pomodoro-completion-alert');
      expect(control?.props.value).toBe(true);
      expect(control?.props.accessibilityLabel).toBe('Alert when timer ends');
      await renderer.act(async () => { control?.props.onValueChange(false); });
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
        gtd: expect.objectContaining({ pomodoro: expect.objectContaining({ completionAlert: false }) }),
      }));
    }
    if (!enabled || !alert || !relevant) expect(alarmPermission.refresh).not.toHaveBeenCalled();
    renderer.act(() => tree.unmount());
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
      tree = renderer.create(<GtdSettingsScreen onNavigate={vi.fn()} screen="gtd-pomodoro" />);
    });

    const disabledPomodoroSwitches = tree.root.findAllByType(Switch).filter((node) => node.props.value === false);
    expect(disabledPomodoroSwitches).toHaveLength(3);
    const autoStartSwitches = disabledPomodoroSwitches.slice(1);

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

  it('keeps focus limit options on a single equal-width row', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<GtdSettingsScreen onNavigate={vi.fn()} screen="gtd" />);
    });

    const focusLimitButtons = [1, 3, 5, 10].map((option) => {
      const button = tree.root.findAllByType(TouchableOpacity).find((candidate) => (
        candidate.findAllByType(Text).some((textNode) => textNode.props.children === option)
      ));
      expect(button).toBeTruthy();
      return button!;
    });

    focusLimitButtons.forEach((button) => {
      const flattenedStyle = flattenStyle(button.props.style);
      expect(flattenedStyle.flexBasis).toBe(0);
      expect(flattenedStyle.minWidth).toBe(0);
      expect(flattenedStyle.flexGrow).toBe(1);
    });
  });

  it('persists a focus limit of 1 when selected', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<GtdSettingsScreen onNavigate={vi.fn()} screen="gtd" />);
    });

    const oneButton = tree.root.findAllByType(TouchableOpacity).find((candidate) => (
      candidate.findAllByType(Text).some((textNode) => textNode.props.children === 1)
    ));
    expect(oneButton).toBeTruthy();

    renderer.act(() => {
      oneButton?.props.onPress();
    });

    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      gtd: expect.objectContaining({
        focusTaskLimit: 1,
      }),
    }));
  });

  // The page still shows the settings it rendered; the write rebuilds the group from the latest stored ones.
  it('keeps a GTD key another device changed after the page rendered', () => {
    storeState.settings = { gtd: { focusTaskLimit: 3, autoArchiveDays: 7 } };
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<GtdSettingsScreen onNavigate={vi.fn()} screen="gtd" />);
    });
    storeState.settings = { gtd: { focusTaskLimit: 3, autoArchiveDays: 30 } };
    const oneButton = tree.root.findAllByType(TouchableOpacity).find((candidate) => (
      candidate.findAllByType(Text).some((textNode) => textNode.props.children === 1)
    ));
    renderer.act(() => {
      oneButton?.props.onPress();
    });
    expect(updateSettings).toHaveBeenCalledWith({ gtd: { focusTaskLimit: 1, autoArchiveDays: 30 } });
  });

  it('writes nothing when a choice re-picks the stored value', async () => {
    storeState.settings = {
      features: { pomodoro: true },
      gtd: {
        focusTaskLimit: 5,
        defaultProjectFlowMode: 'sequential',
        autoArchiveDays: 14,
        pomodoro: { customDurations: { focusMinutes: 50, breakMinutes: 10 } },
      },
    };
    const pressText = (tree: renderer.ReactTestRenderer, text: string | number) => {
      const button = tree.root.findAllByType(TouchableOpacity).find((candidate) => (
        candidate.findAllByType(Text).some((node) => node.props.children === text)
      ));
      expect(button).toBeTruthy();
      renderer.act(() => { button!.props.onPress(); });
    };

    let hub!: renderer.ReactTestRenderer;
    renderer.act(() => { hub = renderer.create(<GtdSettingsScreen onNavigate={vi.fn()} screen="gtd" />); });
    pressText(hub, 5);
    pressText(hub, 'Sequential');

    let archive!: renderer.ReactTestRenderer;
    renderer.act(() => { archive = renderer.create(<GtdSettingsScreen onNavigate={vi.fn()} screen="gtd-archive" />); });
    pressText(archive, '14 days');

    let pomodoro!: renderer.ReactTestRenderer;
    await renderer.act(async () => { pomodoro = renderer.create(<GtdSettingsScreen onNavigate={vi.fn()} screen="gtd-pomodoro" />); });
    renderer.act(() => { pomodoro.root.findAllByType(TextInput)[0].props.onBlur(); });

    expect(updateSettings).not.toHaveBeenCalled();
    pressText(hub, 3);
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });

  it('tells a screen reader which Auto-archive choice and task editor preset is chosen', () => {
    storeState.settings = { ...storeState.settings, gtd: { autoArchiveDays: 14, taskEditor: {} } };
    const textOf = (node: renderer.ReactTestInstance) => node.findAllByType(Text).map((text) => [text.props.children].flat().join('')).join('');

    let archive!: renderer.ReactTestRenderer;
    renderer.act(() => { archive = renderer.create(<GtdSettingsScreen onNavigate={vi.fn()} screen="gtd-archive" />); });
    const days = archive.root.findAllByType(TouchableOpacity);
    expect(days.length).toBeGreaterThan(2);
    for (const option of days) {
      expect(option.props.accessibilityRole).toBe('radio');
      expect(option.props.accessibilityState).toEqual({ selected: textOf(option) === '14 days' });
    }

    let editor!: renderer.ReactTestRenderer;
    renderer.act(() => { editor = renderer.create(<GtdSettingsScreen onNavigate={vi.fn()} screen="gtd-task-editor" />); });
    const presets = editor.root.findAllByType(TouchableOpacity).filter((node) => ['Simple', 'Standard', 'Full'].includes(textOf(node)));
    expect(presets.map(textOf)).toEqual(['Simple', 'Standard', 'Full']);
    for (const option of presets) {
      expect(option.props.accessibilityRole).toBe('radio');
      // Chosen is what the eye sees: the tinted label.
      const tinted = flattenStyle(option.findAllByType(Text)[0].props.style).color === '#3b82f6';
      expect(option.props.accessibilityState).toEqual({ selected: tinted });
    }
    expect(presets.filter((option) => option.props.accessibilityState?.selected)).toHaveLength(1);
  });

  it('saves the default project flow mode from GTD settings', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<GtdSettingsScreen onNavigate={vi.fn()} screen="gtd" />);
    });

    const sequentialButton = tree.root.findAllByType(TouchableOpacity).find((button) => (
      button.findAllByType(Text).some((text) => text.props.children === 'Sequential')
    ));
    expect(sequentialButton).toBeTruthy();

    renderer.act(() => {
      sequentialButton?.props.onPress();
    });

    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      gtd: expect.objectContaining({
        defaultProjectFlowMode: 'sequential',
      }),
    }));
  });

  it('opens a picker before saving the default area from capture settings', () => {
    storeState.settings = {
      gtd: {
        defaultAreaId: null,
        taskEditor: {},
      },
      features: {
        priorities: true,
        timeEstimates: true,
      },
    };
    storeState.areas = [{
      id: 'area-work',
      name: 'Work',
      color: '#64748b',
      order: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }];

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<GtdSettingsScreen onNavigate={vi.fn()} screen="gtd-capture" />);
    });

    expect(tree.root.findByType(Modal).props.visible).toBe(false);

    renderer.act(() => {
      tree.root.findByProps({ testID: 'default-area-picker-button' }).props.onPress();
    });

    expect(tree.root.findByType(Modal).props.visible).toBe(true);

    renderer.act(() => {
      tree.root.findByProps({ testID: 'default-area-picker-option-area-work' }).props.onPress();
    });

    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      gtd: expect.objectContaining({
        defaultAreaMode: 'fixed',
        defaultAreaId: 'area-work',
      }),
    }));
    expect(tree.root.findByType(Modal).props.visible).toBe(false);
  });

  it('saves the active area mode from capture settings', () => {
    storeState.settings = {
      gtd: {
        defaultAreaId: null,
        taskEditor: {},
      },
      features: {
        priorities: true,
        timeEstimates: true,
      },
    };
    storeState.areas = [];

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<GtdSettingsScreen onNavigate={vi.fn()} screen="gtd-capture" />);
    });

    renderer.act(() => {
      tree.root.findByProps({ testID: 'default-area-picker-button' }).props.onPress();
    });

    renderer.act(() => {
      tree.root.findByProps({ testID: 'default-area-picker-option-__active-area__' }).props.onPress();
    });

    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      gtd: expect.objectContaining({
        defaultAreaMode: 'active',
        defaultAreaId: null,
      }),
    }));
    expect(tree.root.findByType(Modal).props.visible).toBe(false);
  });

  it('saves the natural-language dates toggle from capture settings (#742)', () => {
    storeState.settings = {
      gtd: {
        taskEditor: {},
      },
      features: {
        priorities: true,
        timeEstimates: true,
      },
    };
    storeState.areas = [];

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<GtdSettingsScreen onNavigate={vi.fn()} screen="gtd-capture" />);
    });

    const naturalLanguageDatesRow = tree.root.findAllByType(Text).find((text) => (
      text.props.children === 'settings.naturalLanguageDates'
    ));
    expect(naturalLanguageDatesRow).toBeTruthy();

    const naturalLanguageDatesSwitch = tree.root.findAllByType(Switch).find((node) => node.props.value === true);
    expect(naturalLanguageDatesSwitch).toBeTruthy();

    renderer.act(() => {
      naturalLanguageDatesSwitch?.props.onValueChange(false);
    });

    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      gtd: expect.objectContaining({
        naturalLanguageDates: false,
      }),
    }));
  });

  it('routes GTD feature areas to sub-screens from the hub', () => {
    storeState.settings = {
      features: {
        priorities: true,
        timeEstimates: true,
        pomodoro: true,
      },
      gtd: {
        taskEditor: {},
      },
    };
    const onNavigate = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<GtdSettingsScreen onNavigate={onNavigate} screen="gtd" />);
    });

    renderer.act(() => {
      const pomodoroRow = tree.root.findByProps({ testID: 'gtd-nav-pomodoro' });
      expect(pomodoroRow.props.accessibilityRole).toBe('button');
      pomodoroRow.props.onPress();
      tree.root.findByProps({ testID: 'gtd-nav-capture' }).props.onPress();
      tree.root.findByProps({ testID: 'gtd-nav-inbox' }).props.onPress();
    });

    expect(onNavigate).toHaveBeenCalledWith('gtd-pomodoro');
    expect(onNavigate).toHaveBeenCalledWith('gtd-capture');
    expect(onNavigate).toHaveBeenCalledWith('gtd-inbox');
  });

  it('keeps the temporary manual onboarding trigger hidden by default', () => {
    let tree!: renderer.ReactTestRenderer;

    renderer.act(() => {
      tree = renderer.create(<GtdSettingsScreen onNavigate={vi.fn()} screen="gtd" />);
    });

    expect(tree.root.findAllByProps({ testID: 'mobile-onboarding-test-trigger' })).toHaveLength(0);
  });
});

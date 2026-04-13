import React from 'react';
import { TouchableOpacity } from 'react-native';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CaptureScreen from '@/app/capture-modal';

const { routerMocks, storeState } = vi.hoisted(() => ({
  routerMocks: {
    back: vi.fn(),
    canGoBack: vi.fn(),
    replace: vi.fn(),
  },
  storeState: {
    addTask: vi.fn(),
    projects: [] as any[],
    tasks: [] as any[],
    settings: { ai: { enabled: false }, features: {} },
    areas: [] as any[],
  },
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ text: encodeURIComponent('Shared text') }),
  useRouter: () => routerMocks,
}));

vi.mock('@mindwtr/core', () => ({
  createAIProvider: vi.fn(),
  getUsedTaskTokens: vi.fn(() => []),
  parseQuickAdd: vi.fn((value: string) => ({ title: value, props: {}, invalidDateCommands: [] })),
  useTaskStore: () => storeState,
}));

vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      ({
        'nav.addTask': 'Add Task',
        'quickAdd.example': 'Quick add',
        'common.cancel': 'Cancel',
        'common.save': 'Save',
        'common.notice': 'Notice',
        'quickAdd.invalidDateCommand': 'Invalid date command',
        'copilot.suggested': 'Suggested',
        'copilot.applyHint': 'Tap to apply',
        'copilot.applied': 'Applied',
        'quickAdd.help': 'Help text',
      }[key] ?? key),
  }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#0f172a',
    cardBg: '#111827',
    inputBg: '#1f2937',
    border: '#334155',
    text: '#f8fafc',
    secondaryText: '#94a3b8',
  }),
}));

vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({
    showToast: vi.fn(),
    dismissToast: vi.fn(),
  }),
}));

vi.mock('@/lib/ai-config', () => ({
  buildCopilotConfig: vi.fn(),
  isAIKeyRequired: vi.fn(() => false),
  loadAIKey: vi.fn().mockResolvedValue(''),
}));

vi.mock('@/lib/app-log', () => ({
  logError: vi.fn(),
}));

describe('CaptureScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routerMocks.canGoBack.mockReturnValue(false);
  });

  it('returns to inbox when cancelling without a back stack', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const cancelButton = tree.root.findAllByType(TouchableOpacity)[1];

    act(() => {
      cancelButton.props.onPress();
    });

    expect(routerMocks.back).not.toHaveBeenCalled();
    expect(routerMocks.replace).toHaveBeenCalledWith('/inbox');
  });

  it('goes back when cancelling from a stacked navigation flow', () => {
    routerMocks.canGoBack.mockReturnValue(true);

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<CaptureScreen />);
    });

    const cancelButton = tree.root.findAllByType(TouchableOpacity)[1];

    act(() => {
      cancelButton.props.onPress();
    });

    expect(routerMocks.back).toHaveBeenCalledTimes(1);
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });
});

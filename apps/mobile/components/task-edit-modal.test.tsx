import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import renderer from 'react-test-renderer';

import { TaskEditModal } from './task-edit-modal';

vi.mock('@mindwtr/core', async () => {
  const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  return {
    ...actual,
    useTaskStore: () => ({
      tasks: [],
      projects: [],
      settings: { features: {}, ai: {}, gtd: { taskEditor: { order: [], hidden: [] } } },
      duplicateTask: vi.fn(),
      resetTaskChecklist: vi.fn(),
    }),
  };
});

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#000',
    cardBg: '#111',
    inputBg: '#111',
    filterBg: '#222',
    border: '#333',
    text: '#fff',
    secondaryText: '#aaa',
    tint: '#3b82f6',
    onTint: '#fff',
  }),
}));

vi.mock('../lib/ai-config', () => ({
  loadAIKey: vi.fn().mockResolvedValue(''),
  buildAIConfig: vi.fn().mockReturnValue({}),
  buildCopilotConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('./task-edit/TaskEditViewTab', () => ({
  TaskEditViewTab: () => React.createElement('TaskEditViewTab'),
}));

vi.mock('./task-edit/TaskEditFormTab', () => ({
  TaskEditFormTab: () => React.createElement('TaskEditFormTab'),
}));

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
}));

vi.mock('@react-native-community/datetimepicker', () => ({
  __esModule: true,
  default: (props: any) => React.createElement('DateTimePicker', props, props.children),
}));

vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn().mockResolvedValue({ canceled: true, assets: [] }),
}));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn().mockResolvedValue(false),
  shareAsync: vi.fn(),
}));

vi.mock('expo-linking', () => ({
  openURL: vi.fn(),
}));

describe('TaskEditModal', () => {
  it('renders without crashing', () => {
    expect(() =>
      renderer.create(
        <TaskEditModal
          visible
          task={{
            id: 't1',
            title: 'Test task',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />
      )
    ).not.toThrow();
  });
});

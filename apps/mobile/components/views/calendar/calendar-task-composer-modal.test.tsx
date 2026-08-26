import React from 'react';
import { Modal, TextInput } from 'react-native';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@mindwtr/core';

import {
  CalendarTaskComposerModal,
  type MobileCalendarComposerState,
} from './calendar-task-composer-modal';

vi.mock('react-native-gesture-handler', async () => {
  const reactNative = await import('react-native');
  return { ScrollView: reactNative.ScrollView };
});

const translations: Record<string, string> = {
  'calendar.addTask': 'Aufgabe hinzufügen',
  'calendar.mobile.end': 'Ende',
  'calendar.mobile.existingTask': 'Vorhanden',
  'calendar.mobile.newTask': 'Neu',
  'calendar.mobile.noMatchingTasks': 'Keine passenden Aufgaben',
  'calendar.mobile.scheduleTask': 'Aufgabe planen',
  'calendar.schedulePlaceholder': 'Aufgabe suchen',
  'common.cancel': 'Abbrechen',
  'common.close': 'Schließen',
  'common.save': 'Speichern',
  'quickAdd.help': 'Schnelleingabe-Hilfe',
  'taskEdit.start': 'Beginn',
};

const t = (key: string) => translations[key] ?? key;
const tc = {
  border: '#334155',
  cardBg: '#17212b',
  danger: '#ef4444',
  inputBg: '#1e293b',
  onTint: '#f8fafc',
  secondaryText: '#94a3b8',
  text: '#f8fafc',
  tint: '#60a5fa',
} as any;

const task = (id: string, title: string): Task => ({
  id,
  title,
  status: 'next',
  tags: [],
  contexts: [],
  createdAt: '2026-08-26T12:00:00.000Z',
  updatedAt: '2026-08-26T12:00:00.000Z',
});

const composer = (overrides: Partial<MobileCalendarComposerState> = {}): MobileCalendarComposerState => ({
  date: new Date('2026-08-26T12:00:00.000Z'),
  durationMinutes: 30,
  endTimeValue: '09:30',
  error: null,
  mode: 'new',
  query: '',
  selectedTaskId: null,
  startAt: new Date('2026-08-26T09:00:00.000Z'),
  startTimeValue: '09:00',
  title: '',
  ...overrides,
});

const baseProps = {
  bottomInset: 0,
  candidates: [task('task-1', 'Prepare agenda'), task('task-2', 'Send notes')],
  closeComposer: vi.fn(),
  composer: composer(),
  endTimePlaceholder: '09:30',
  error: 'The selected time overlaps another item.',
  formatDurationLabel: (minutes: number) => `${minutes} min`,
  isDark: true,
  keyboardInset: 0,
  locale: 'de-DE',
  saveComposer: vi.fn(),
  selectTask: vi.fn(),
  selectedTask: null,
  setDuration: vi.fn(),
  setEndTime: vi.fn(),
  setMode: vi.fn(),
  setQuery: vi.fn(),
  setStartTime: vi.fn(),
  setTitle: vi.fn(),
  startTimePlaceholder: '09:00',
  t,
  tc,
  toRgba: (color: string, alpha: number) => `${color}:${alpha}`,
  tr: t,
};

describe('CalendarTaskComposerModal', () => {
  it('isolates the modal and labels its close control, title, and time inputs', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CalendarTaskComposerModal {...baseProps} />);
    });

    expect(tree.root.findByType(Modal).props.accessibilityViewIsModal).toBe(true);
    expect(tree.root.findAll((node) => node.props.accessibilityViewIsModal === true).length).toBeGreaterThanOrEqual(2);
    expect(tree.root.findByProps({ children: 'Aufgabe planen' }).props.accessibilityRole).toBe('header');
    expect(tree.root.findByProps({ accessibilityLabel: 'Schließen' }).props.accessibilityRole).toBe('button');

    const inputs = tree.root.findAllByType(TextInput);
    expect(inputs.map((input) => input.props.accessibilityLabel)).toEqual([
      'Aufgabe hinzufügen',
      'Beginn',
      'Ende',
    ]);
  });

  it('exposes selected state, validation alerts, and explicit disabled save state', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CalendarTaskComposerModal {...baseProps} />);
    });

    const newMode = tree.root.findByProps({ accessibilityLabel: 'Neu' });
    const existingMode = tree.root.findByProps({ accessibilityLabel: 'Vorhanden' });
    const selectedDuration = tree.root.findByProps({ accessibilityLabel: '30 min' });
    const save = tree.root.findByProps({ accessibilityLabel: 'Speichern' });

    expect(newMode.props.accessibilityState).toEqual({ selected: true });
    expect(existingMode.props.accessibilityState).toEqual({ selected: false });
    expect(selectedDuration.props.accessibilityState).toEqual({ selected: true });
    expect(tree.root.findByProps({ children: baseProps.error }).props.accessibilityRole).toBe('alert');
    expect(save.props.disabled).toBe(true);
    expect(save.props.accessibilityState).toEqual({ disabled: true });
  });

  it('labels selectable existing tasks and forwards the existing actions', () => {
    const props = {
      ...baseProps,
      composer: composer({ mode: 'existing', query: 'agenda', selectedTaskId: 'task-1' }),
      selectedTask: baseProps.candidates[0],
    };
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CalendarTaskComposerModal {...props} />);
    });

    const selectedTask = tree.root.findByProps({ accessibilityLabel: 'Prepare agenda' });
    const otherTask = tree.root.findByProps({ accessibilityLabel: 'Send notes' });
    expect(selectedTask.props.accessibilityRole).toBe('button');
    expect(selectedTask.props.accessibilityState).toEqual({ selected: true });
    expect(otherTask.props.accessibilityState).toEqual({ selected: false });
    expect(tree.root.findAllByType(TextInput)[0].props.accessibilityLabel).toBe('Aufgabe suchen');
    expect(tree.root.findByProps({ accessibilityLabel: 'Speichern' }).props.accessibilityState).toEqual({ disabled: false });

    act(() => {
      otherTask.props.onPress();
      tree.root.findByProps({ accessibilityLabel: '60 min' }).props.onPress();
      tree.root.findByProps({ accessibilityLabel: 'Schließen' }).props.onPress();
    });

    expect(baseProps.selectTask).toHaveBeenCalledWith(baseProps.candidates[1]);
    expect(baseProps.setDuration).toHaveBeenCalledWith(60);
    expect(baseProps.closeComposer).toHaveBeenCalled();
  });
});

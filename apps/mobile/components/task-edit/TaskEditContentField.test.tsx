import React from 'react';
import { Platform, Switch, Text, TextInput, View } from 'react-native';
import { act, create as createRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTaskStore } from '@mindwtr/core';

import { TaskEditContentField } from './TaskEditContentField';
import { ChecklistDragScrollContext } from './use-checklist-handle-drag';

const renderedTrees: ReturnType<typeof createRenderer>[] = [];
const create = (...args: Parameters<typeof createRenderer>) => {
  const tree = createRenderer(...args);
  renderedTrees.push(tree);
  return tree;
};

const mockFindNodeHandle = vi.hoisted(() => vi.fn(() => 314));
const logInfoMock = vi.hoisted(() => vi.fn(() => Promise.resolve(null)));

vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>();
  return {
    ...actual,
    findNodeHandle: mockFindNodeHandle,
  };
});

vi.mock('../markdown-reference-autocomplete', () => ({
  MarkdownReferenceAutocomplete: (props: any) => React.createElement('MarkdownReferenceAutocomplete', props),
}));

vi.mock('../markdown-text', () => ({
  MarkdownText: (props: any) => React.createElement('MarkdownText', props),
}));

vi.mock('../../lib/app-log', () => ({ logInfo: logInfoMock }));

const installAnimationFrameHarness = () => {
  let nextFrame = 1;
  const callbacks = new Map<number, (timestamp: number) => void>();
  const request = vi.fn((callback: (timestamp: number) => void) => {
    const frame = nextFrame++;
    callbacks.set(frame, callback);
    return frame;
  });
  const cancel = vi.fn((frame: number) => {
    callbacks.delete(frame);
  });
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', cancel);
  return {
    cancel,
    request,
    runNext: () => {
      const next = callbacks.entries().next().value as [number, (timestamp: number) => void] | undefined;
      if (!next) return;
      callbacks.delete(next[0]);
      next[1](0);
    },
    runAll: () => {
      for (const [frame, callback] of [...callbacks]) {
        callbacks.delete(frame);
        callback(0);
      }
    },
  };
};

const createChecklistInputNodes = () => {
  const nodes: { focus: ReturnType<typeof vi.fn> }[] = [];
  return {
    nodes,
    createNodeMock: (element: any) => {
      if (!String(element.props?.accessibilityLabel ?? '').startsWith('taskEdit.checklist')) return {};
      const node = { focus: vi.fn() };
      nodes.push(node);
      return node;
    },
  };
};

const withPlatform = (os: typeof Platform.OS, run: () => void) => {
  const originalPlatformOs = Platform.OS;
  Object.defineProperty(Platform, 'OS', {
    configurable: true,
    value: os,
  });
  try {
    run();
  } finally {
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: originalPlatformOs,
    });
  }
};

const flattenStyle = (style: unknown): Record<string, unknown> => {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (result, item) => Object.assign(result, flattenStyle(item)),
      {},
    );
  }
  return style && typeof style === 'object' ? style as Record<string, unknown> : {};
};

const baseProps: any = {
  addFileAttachment: vi.fn(),
  addImageAttachment: vi.fn(),
  applyAssignedToSuggestion: vi.fn(),
  applyContextSuggestion: vi.fn(),
  applyTagSuggestion: vi.fn(),
  areas: [],
  assignedToSuggestions: [],
  availableStatusOptions: ['inbox', 'next', 'waiting', 'scheduled', 'someday', 'completed'],
  applyQuickDate: vi.fn(),
  commitContextDraft: vi.fn(),
  commitTagDraft: vi.fn(),
  checklist: undefined,
  contextInputDraft: '',
  contextTokenSuggestions: [],
  customWeekdays: [],
  dailyInterval: 1,
  descriptionDraft: '# Heading\n\nLong description',
  descriptionInputRef: React.createRef<TextInput>(),
  descriptionSelection: { start: 0, end: 0 },
  descriptionSelectionRestorePending: false,
  setDescriptionSelection: vi.fn(),
  descriptionToolbarInteractionUntilRef: { current: 0 },
  isDescriptionInputFocused: false,
  setIsDescriptionInputFocused: vi.fn(),
  handleDescriptionChange: vi.fn(),
  handleDescriptionKeyPress: vi.fn(),
  applyChecklistUpdate: vi.fn(),
  applyDescriptionResult: vi.fn(),
  openDescriptionExpandedEditor: vi.fn(),
  downloadAttachment: vi.fn(),
  draft: null,
  editLinkAttachment: vi.fn(),
  formatDate: vi.fn((value) => value ?? ''),
  formatDueDate: vi.fn((value) => value ?? ''),
  frequentContextSuggestions: [],
  frequentTagSuggestions: [],
  getSafePickerDateValue: vi.fn(() => new Date('2025-01-01T00:00:00.000Z')),
  handleInputFocus: vi.fn(),
  handleResetChecklist: vi.fn(),
  language: 'en',
  monthlyPattern: 'date',
  onDateChange: vi.fn(),
  openAddLinkAttachment: vi.fn(),
  openAttachment: vi.fn(),
  openCustomRecurrence: vi.fn(),
  pendingDueDate: null,
  pendingStartDate: null,
  prioritiesEnabled: true,
  energyLevelOptions: [],
  priorityOptions: [],
  projects: [],
  projectSections: [],
  recurrenceOptions: [],
  recurrenceRRuleValue: '',
  recurrenceRuleValue: '',
  recurrenceStrategyValue: 'due',
  recurrenceWeekdayButtons: [],
  removeAttachment: vi.fn(),
  selectedContextTokens: new Set<string>(),
  selectedTagTokens: new Set<string>(),
  setCustomWeekdays: vi.fn(),
  setDraftField: vi.fn(),
  setIsContextInputFocused: vi.fn(),
  setIsTagInputFocused: vi.fn(),
  setLinkInputTouched: vi.fn(),
  setLinkModalVisible: vi.fn(),
  setShowAreaPicker: vi.fn(),
  setShowDatePicker: vi.fn(),
  setShowDescriptionPreview: vi.fn(),
  setShowProjectPicker: vi.fn(),
  setShowSectionPicker: vi.fn(),
  showDatePicker: null,
  showDescriptionPreview: false,
  styles: {
    formGroup: {},
    inlineHeader: {},
    label: {},
    inlineActions: {},
    inlineAction: {},
    input: {},
    textArea: {},
    markdownPreview: {},
    checklistContainer: {},
    checklistHeader: {},
    checklistHeaderLabel: {},
    checklistHeaderButton: {},
    checklistHeaderButtonText: {},
    checklistItem: {},
    checklistOrderPanel: {},
    checklistOrderItem: {},
    checklistOrderTitle: {},
    checklistOrderControls: {},
    checklistOrderButton: {},
    checklistOrderButtonDisabled: {},
    checkboxTouch: {},
    checkbox: {},
    checkboxChecked: {},
    checkmark: {},
    checklistInput: {},
    completedText: {},
    deleteBtn: {},
    deleteBtnText: {},
    addChecklistBtn: {},
    addChecklistText: {},
    checklistActions: {},
    checklistActionButton: {},
    checklistActionText: {},
  },
  tagInputDraft: '',
  tagTokenSuggestions: [],
  task: null,
  t: (key: string) => key,
  tc: {
    bg: '#000',
    cardBg: '#111',
    taskItemBg: '#111',
    inputBg: '#111',
    filterBg: '#222',
    border: '#333',
    text: '#fff',
    secondaryText: '#aaa',
    icon: '#aaa',
    tint: '#3b82f6',
    onTint: '#fff',
    tabIconDefault: '#aaa',
    tabIconSelected: '#3b82f6',
    danger: '#ef4444',
    success: '#10b981',
    warning: '#f59e0b',
  },
  timeEstimateOptions: [],
  timeEstimatesEnabled: true,
  titleDraft: 'Task',
  toggleQuickContextToken: vi.fn(),
  toggleQuickTagToken: vi.fn(),
  updateContextInput: vi.fn(),
  updateTagInput: vi.fn(),
  visibleAttachments: [],
};

const createChecklistState = (checklist = [{ id: 'check-1', title: 'Item 1', isCompleted: false }]) => {
  let state: any = {
    id: 'task-1',
    title: 'Task',
    checklist,
  };
  const applyChecklistUpdate = vi.fn((nextChecklist: any) => {
    state = { ...state, checklist: nextChecklist };
  });
  return {
    getState: () => state,
    applyChecklistUpdate,
  };
};

describe('TaskEditContentField', () => {
  it('lets the user remove a missing file the sync location could not find', () => {

    const removeAttachment = vi.fn();
    const missing = { id: 'gone', kind: 'file' as const, title: 'scan.pdf', uri: '', cloudKey: 'attachments/gone.pdf',
      localStatus: 'missing' as const, createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' };
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<TaskEditContentField {...baseProps} fieldId="attachments" visibleAttachments={[missing]} removeAttachment={removeAttachment} />);
    });
    const remove = tree.root.findAll((node) => node.props.accessibilityLabel === 'attachments.remove' && typeof node.props.onPress === 'function')[0]!;
    act(() => remove.props.onPress());
    expect(removeAttachment).toHaveBeenCalledWith('gone');
  });

  it('edits the recurring checklist policy without changing current items', () => {
    const setDraftField = vi.fn();
    const checklist = [{ id: 'a', title: 'First', isCompleted: true }];
    const props = { ...baseProps, fieldId: 'checklist' as const, checklist, setDraftField,
      draft: { recurrence: 'weekly', preserveChecklistOnRepeat: false, status: 'next' }, task: { taskMode: 'task' } };
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<TaskEditContentField {...props} />); });
    const toggle = tree.root.findByType(Switch);
    expect(toggle.props.value).toBe(true);
    act(() => toggle.props.onValueChange(false));
    expect(setDraftField).toHaveBeenCalledWith('preserveChecklistOnRepeat', true);
    expect(checklist[0].isCompleted).toBe(true);
    act(() => tree.update(<TaskEditContentField {...props} task={{ taskMode: 'list' } as any} />));
    expect(tree.root.findAllByType(Switch)).toHaveLength(0);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    logInfoMock.mockReset();
    logInfoMock.mockResolvedValue(null);
  });

  afterEach(() => {
    try {

      act(() => {
        vi.runOnlyPendingTimers();
        for (const tree of renderedTrees.splice(0)) tree.unmount();
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      useTaskStore.setState({ settings: {} });
    }
  });

  it('exposes checklist state and uses semantic colors for a completed item', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditContentField
          {...baseProps}
          checklist={[{ id: 'check-1', title: 'Item 1', isCompleted: true }]}
          fieldId="checklist"
        />
      );
    });

    const checkbox = tree.root.findByProps({
      accessibilityLabel: 'Item 1',
      accessibilityRole: 'checkbox',
    });
    const checkboxVisual = checkbox.findByType(View);

    const checkmark = checkbox.findByType('Icon' as never);

    expect(checkbox.props.accessibilityState).toEqual({ checked: true });
    expect(flattenStyle(checkboxVisual.props.style).backgroundColor).toBe(baseProps.tc.tint);
    expect(checkmark.props.color).toBe(baseProps.tc.onTint);
  });

  it('adds the first item to an empty Reference checklist (#1416)', () => {
    const applyChecklistUpdate = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<TaskEditContentField {...baseProps} draft={{ status: 'reference' }}
        checklist={[]} fieldId="checklist" applyChecklistUpdate={applyChecklistUpdate} />);
    });
    act(() => {
      tree.root.findByProps({ testID: 'mobile-checklist-add-item' }).props.onPress();
    });
    expect(applyChecklistUpdate).toHaveBeenCalledWith([{ id: expect.any(String), title: '', isCompleted: false }]);
  });

  it('gives a draft Reference list checkboxes that tick an entry, struck when checked, with Reset (#1416)', () => {
    const checklist = [
      { id: 'check-1', title: 'Completed **source**', isCompleted: true },
      { id: 'check-2', title: '[Pending link](https://example.com)', isCompleted: false },
    ];
    const applyChecklistUpdate = vi.fn();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditContentField
          {...baseProps}
          task={{ id: 'task-1', status: 'next' } as any}
          draft={{ status: 'reference' } as any}
          checklist={checklist}
          fieldId="checklist"
          applyChecklistUpdate={applyChecklistUpdate}
        />
      );
    });

    expect(tree.root.findAllByProps({ children: 'taskEdit.tab.list' })).not.toHaveLength(0);
    const boxes = tree.root.findAll((node) => node.props.accessibilityRole === 'checkbox' && typeof node.type !== 'string');
    expect(boxes.map((node) => [node.props.accessibilityLabel, node.props.accessibilityState])).toEqual([
      ['Completed **source**', { checked: true }],
      ['[Pending link](https://example.com)', { checked: false }],
    ]);
    expect(tree.root.findAllByType(Text).filter((node) => node.props.children === '•')).toHaveLength(0);
    expect(tree.root.findAllByProps({ children: 'taskEdit.resetChecklist' })).not.toHaveLength(0);

    const completedInput = tree.root.findByProps({ accessibilityLabel: 'taskEdit.tab.list 1' });
    expect(flattenStyle(completedInput.props.style).color).toBe(baseProps.tc.secondaryText);

    act(() => {
      boxes[1].props.onPress();
    });

    expect(applyChecklistUpdate).toHaveBeenCalledWith([
      checklist[0],
      { ...checklist[1], isCompleted: true },
    ]);
  });

  it('keeps pasted checked markers checked in Reference, as in a checklist (#1416)', () => {
    let checklist = [
      { id: 'check-1', title: 'Replace me', isCompleted: false },
      { id: 'check-2', title: 'Existing completed item', isCompleted: true },
    ];
    const applyChecklistUpdate = vi.fn((nextChecklist: typeof checklist) => {
      checklist = nextChecklist;
    });
    const renderField = (status: 'reference' | 'next') => (
      <TaskEditContentField
        {...baseProps}
        task={{ id: 'task-1', status: 'next' } as any}
        draft={{ status } as any}
        checklist={checklist}
        fieldId="checklist"
        applyChecklistUpdate={applyChecklistUpdate}
      />
    );
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(renderField('reference'));
    });
    act(() => {
      tree.root.findByProps({ accessibilityLabel: 'taskEdit.tab.list 1' }).props.onChangeText(
        '- [x] Imported checked marker\n- [ ] Imported open marker',
      );
    });

    expect(checklist.map((item) => item.title)).toEqual([
      'Imported checked marker',
      'Imported open marker',
      'Existing completed item',
    ]);
    expect(checklist.map((item) => item.isCompleted)).toEqual([true, false, true]);
    expect(checklist[0].id).toBe('check-1');
    expect(checklist[2].id).toBe('check-2');

    act(() => {
      tree.update(renderField('next'));
    });

    expect(tree.root.findByProps({
      accessibilityLabel: 'Imported checked marker',
      accessibilityRole: 'checkbox',
    }).props.accessibilityState).toEqual({ checked: true });
    expect(tree.root.findByProps({
      accessibilityLabel: 'Imported open marker',
      accessibilityRole: 'checkbox',
    }).props.accessibilityState).toEqual({ checked: false });
    expect(tree.root.findByProps({
      accessibilityLabel: 'Existing completed item',
      accessibilityRole: 'checkbox',
    }).props.accessibilityState).toEqual({ checked: true });
  });

  it('registers the iOS description input as a keyboard auto-scroll target', () => {
    const handleInputFocus = vi.fn();
    const setIsDescriptionInputFocused = vi.fn();
    let tree!: ReturnType<typeof create>;

    withPlatform('ios', () => {
      act(() => {
        tree = create(
          <TaskEditContentField
            {...baseProps}
            fieldId="description"
            handleInputFocus={handleInputFocus}
            setIsDescriptionInputFocused={setIsDescriptionInputFocused}
          />
        );
      });

      const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.descriptionLabel' });

      act(() => {
        input.props.onFocus({ nativeEvent: { target: 42 } });
      });

      expect(setIsDescriptionInputFocused).toHaveBeenCalledWith(true);
      expect(handleInputFocus).toHaveBeenCalledWith(42);
    });
  });

  it('registers the Android description header as the focus scroll target', () => {
    const handleInputFocus = vi.fn();
    const setIsDescriptionInputFocused = vi.fn();
    let tree!: ReturnType<typeof create>;

    withPlatform('android', () => {
      act(() => {
        tree = create(
          <TaskEditContentField
            {...baseProps}
            fieldId="description"
            handleInputFocus={handleInputFocus}
            setIsDescriptionInputFocused={setIsDescriptionInputFocused}
          />
        );
      });

      const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.descriptionLabel' });

      act(() => {
        input.props.onFocus({ nativeEvent: { target: 42 } });
      });

      expect(setIsDescriptionInputFocused).toHaveBeenCalledWith(true);
      expect(mockFindNodeHandle).toHaveBeenCalled();
      expect(handleInputFocus).toHaveBeenCalledWith(314);
      expect(handleInputFocus).not.toHaveBeenCalledWith(42);
    });
  });

  it('does not nudge Android keyboard scrolling when the inline description caret reaches the end', () => {
    const descriptionDraft = 'First line\nLast line';
    const handleInputFocus = vi.fn();
    const setDescriptionSelection = vi.fn();
    let tree!: ReturnType<typeof create>;

    withPlatform('android', () => {
      act(() => {
        tree = create(
          <TaskEditContentField
            {...baseProps}
            fieldId="description"
            descriptionDraft={descriptionDraft}
            isDescriptionInputFocused
            handleInputFocus={handleInputFocus}
            setDescriptionSelection={setDescriptionSelection}
          />
        );
      });

      const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.descriptionLabel' });
      const endSelection = { start: descriptionDraft.length, end: descriptionDraft.length };

      act(() => {
        input.props.onSelectionChange({ nativeEvent: { selection: endSelection } });
      });

      expect(setDescriptionSelection).toHaveBeenCalledWith(endSelection);
      expect(handleInputFocus).toHaveBeenCalledWith(undefined);
      expect(handleInputFocus).not.toHaveBeenCalledWith('description-end-keyboard-scroll');
    });
  });

  it('does not nudge Android keyboard scrolling for middle description taps', () => {
    const descriptionDraft = [
      'Intro line',
      '[First link](https://example.com/first)',
      '[Second link](https://example.com/second)',
      '[Third link](https://example.com/third)',
      'Last line',
    ].join('\n');
    const handleInputFocus = vi.fn();
    const setDescriptionSelection = vi.fn();
    let tree!: ReturnType<typeof create>;

    withPlatform('android', () => {
      act(() => {
        tree = create(
          <TaskEditContentField
            {...baseProps}
            fieldId="description"
            descriptionDraft={descriptionDraft}
            isDescriptionInputFocused
            handleInputFocus={handleInputFocus}
            setDescriptionSelection={setDescriptionSelection}
          />
        );
      });

      const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.descriptionLabel' });
      const middleSelection = { start: descriptionDraft.indexOf('Second'), end: descriptionDraft.indexOf('Second') };

      act(() => {
        input.props.onSelectionChange({ nativeEvent: { selection: middleSelection } });
      });

      expect(setDescriptionSelection).toHaveBeenCalledWith(middleSelection);
      expect(handleInputFocus).toHaveBeenCalledWith(undefined);
      expect(handleInputFocus).not.toHaveBeenCalledWith('description-end-keyboard-scroll');
    });
  });

  it('keeps the Android description editor in plain-text spellcheck mode', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditContentField
          {...baseProps}
          fieldId="description"
        />
      );
    });

    const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.descriptionLabel' });

    expect(input.props.spellCheck).toBe(true);
    expect(input.props.autoCorrect).toBe(true);
    expect(input.props.autoCapitalize).toBe('sentences');
    expect(input.props.autoComplete).toBe('off');
    expect(input.props.importantForAutofill).toBe('no');
    expect(input.props.inputMode).toBe('text');
    expect(input.props.textContentType).toBe('none');
    expect(input.props.keyboardType).toBe('default');
  });

  it('temporarily controls Android description selection during caret restoration', () => {
    let tree!: ReturnType<typeof create>;

    withPlatform('android', () => {
      act(() => {
        tree = create(
          <TaskEditContentField
            {...baseProps}
            fieldId="description"
            descriptionSelection={{ start: 9, end: 9 }}
            descriptionSelectionRestorePending
          />
        );
      });

      const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.descriptionLabel' });

      expect(input.props.selection).toEqual({ start: 9, end: 9 });
    });
  });

  it('leaves iOS checklist caret native except while restoring a Markdown selection', () => {
    withPlatform('ios', () => {
      const { getState, applyChecklistUpdate } = createChecklistState();
      let tree!: ReturnType<typeof create>;
      const render = () => <TaskEditContentField {...baseProps} fieldId="checklist"
        checklist={getState().checklist} applyChecklistUpdate={applyChecklistUpdate} />;
      act(() => { tree = create(render()); });
      const input = () => tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });
      expect(input().props.selection).toBeUndefined();
      act(() => { input().props.onSelectionChange({ nativeEvent: { selection: { start: 2, end: 2 } } }); });
      act(() => { tree.update(render()); });
      expect(input().props.selection).toBeUndefined();
      act(() => { input().props.onChangeText('ItXem 1'); });
      act(() => { tree.update(render()); });
      expect(getState().checklist[0].title).toBe('ItXem 1');
      expect(input().props.selection).toBeUndefined();
      act(() => { input().props.onSelectionChange({ nativeEvent: { selection: { start: 0, end: 7 } } }); });
      act(() => { input().props.onChangeText('['); });
      expect(input().props.selection).toBeDefined();
      const restored = input().props.selection;
      act(() => { input().props.onSelectionChange({ nativeEvent: { selection: restored } }); });
      expect(input().props.selection).toBeUndefined();
      act(() => { tree.unmount(); });
    });
  });

  it('wraps selected checklist item text when the native change replaces the range', () => {
    const { getState, applyChecklistUpdate } = createChecklistState();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditContentField
          {...baseProps}
          fieldId="checklist"
          checklist={getState().checklist}
          applyChecklistUpdate={applyChecklistUpdate}
        />
      );
    });

    const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });

    act(() => {
      input.props.onSelectionChange({ nativeEvent: { selection: { start: 0, end: 6 } } });
    });

    act(() => {
      input.props.onChangeText('[');
    });

    expect(getState().checklist[0].title).toBe('[Item 1]');

    const callsAfterWrap = applyChecklistUpdate.mock.calls.length;
    act(() => {
      input.props.onChangeText('[');
    });

    expect(getState().checklist[0].title).toBe('[Item 1]');
    expect(applyChecklistUpdate).toHaveBeenCalledTimes(callsAfterWrap);
  });

  it('splits multi-line pasted text into separate checklist items', () => {
    const { getState, applyChecklistUpdate } = createChecklistState([
      { id: 'check-1', title: 'Item 1', isCompleted: false },
      { id: 'check-2', title: 'Item 2', isCompleted: false },
    ]);
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditContentField
          {...baseProps}
          fieldId="checklist"
          checklist={getState().checklist}
          applyChecklistUpdate={applyChecklistUpdate}
        />
      );
    });

    const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });

    act(() => {
      input.props.onChangeText('buy milk\nbuy bread\n- [x] call mom');
    });

    const checklist = getState().checklist;
    expect(checklist.map((item: any) => item.title)).toEqual([
      'buy milk',
      'buy bread',
      'call mom',
      'Item 2',
    ]);
    expect(checklist[0].id).toBe('check-1');
    expect(checklist[2].isCompleted).toBe(true);
  });

  it('inserts a new checklist item after the current one when submitting a filled item', () => {
    const { getState, applyChecklistUpdate } = createChecklistState([
      { id: 'check-1', title: 'Item 1', isCompleted: false },
      { id: 'check-2', title: 'Item 2', isCompleted: false },
    ]);
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditContentField
          {...baseProps}
          fieldId="checklist"
          checklist={getState().checklist}
          applyChecklistUpdate={applyChecklistUpdate}
        />
      );
    });

    const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });
    expect(input.props.blurOnSubmit).toBe(false);

    act(() => {
      input.props.onSubmitEditing();
    });

    const checklist = getState().checklist;
    expect(checklist.map((item: any) => item.title)).toEqual(['Item 1', '', 'Item 2']);
    expect(checklist[1].id).toBeTruthy();
    expect(checklist[1].id).not.toBe('check-1');
    expect(checklist[1].id).not.toBe('check-2');
  });

  it('does not add a checklist item when submitting an empty item', () => {
    const { getState, applyChecklistUpdate } = createChecklistState([
      { id: 'check-1', title: '', isCompleted: false },
    ]);
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditContentField
          {...baseProps}
          fieldId="checklist"
          checklist={getState().checklist}
          applyChecklistUpdate={applyChecklistUpdate}
        />
      );
    });

    const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });

    act(() => {
      input.props.onSubmitEditing();
    });

    expect(applyChecklistUpdate).not.toHaveBeenCalled();
    expect(getState().checklist.map((item: any) => item.title)).toEqual(['']);
  });

  it('leaves checklist typing to native text input when editor assist is disabled', () => {
    useTaskStore.setState({ settings: { markdownEditorAssist: false } });
    const { getState, applyChecklistUpdate } = createChecklistState();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditContentField
          {...baseProps}
          fieldId="checklist"
          checklist={getState().checklist}
          applyChecklistUpdate={applyChecklistUpdate}
        />
      );
    });

    const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });

    act(() => {
      input.props.onSelectionChange({ nativeEvent: { selection: { start: 0, end: 6 } } });
    });

    act(() => {
      input.props.onChangeText('[');
    });

    expect(getState().checklist[0].title).toBe('[');
  });

  it('types a literal "(" with no auto-close when typing help is disabled (#742)', () => {
    useTaskStore.setState({ settings: { markdownEditorAssist: false } });
    const { getState, applyChecklistUpdate } = createChecklistState([
      { id: 'check-1', title: '', isCompleted: false },
    ]);
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditContentField
          {...baseProps}
          fieldId="checklist"
          checklist={getState().checklist}
          applyChecklistUpdate={applyChecklistUpdate}
        />
      );
    });

    const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });

    act(() => {
      input.props.onChangeText('(');
    });

    expect(getState().checklist[0].title).toBe('(');
  });

  it.each(['()', '[]', '``'])('deletes an empty checklist %s pair after stale native echoes', (pair) => {
    withPlatform('android', () => {
      for (const prefix of ['', 'note ']) {
        const { getState, applyChecklistUpdate } = createChecklistState([
          { id: 'check-1', title: prefix, isCompleted: false },
        ]);
        let tree!: ReturnType<typeof create>;
        const render = () => (
          <TaskEditContentField {...baseProps} fieldId="checklist"
            checklist={getState().checklist} applyChecklistUpdate={applyChecklistUpdate} />
        );
        act(() => { tree = create(render()); });
        const input = () => tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });
        const rawInsertion = prefix + pair[0];
        act(() => { input().props.onChangeText(rawInsertion); });
        act(() => { tree.update(render()); });
        expect(input().props.value).toBe(prefix + pair);
        act(() => { input().props.onChangeText(rawInsertion); });
        act(() => { input().props.onChangeText(rawInsertion); });
        expect(getState().checklist[0].title).toBe(prefix + pair);

        const preventDefault = vi.fn();
        act(() => {
          input().props.onKeyPress?.({ nativeEvent: { key: 'Backspace' }, preventDefault });
          input().props.onChangeText(rawInsertion);
        });
        act(() => { tree.update(render()); });
        expect(input().props.value).toBe(rawInsertion);
        act(() => {
          input().props.onKeyPress?.({ nativeEvent: { key: 'Backspace' }, preventDefault });
          input().props.onChangeText(prefix);
        });
        act(() => { tree.update(render()); });
        expect(input().props.value).toBe(prefix);
        expect(preventDefault).not.toHaveBeenCalled();
        act(() => { tree.unmount(); });
      }
    });
  });

  it('keeps Android checklist cursor inside a collapsed pair and ignores duplicate native insertion', () => {
    const { getState, applyChecklistUpdate } = createChecklistState([
      { id: 'check-1', title: '', isCompleted: false },
    ]);
    let tree!: ReturnType<typeof create>;

    withPlatform('android', () => {
      act(() => {
        tree = create(
          <TaskEditContentField
            {...baseProps}
            fieldId="checklist"
            checklist={getState().checklist}
            applyChecklistUpdate={applyChecklistUpdate}
          />
        );
      });

      let input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });

      act(() => {
        input.props.onChangeText('(');
      });

      expect(getState().checklist[0].title).toBe('()');

      input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });
      expect(input.props.selection).toEqual({ start: 1, end: 1 });

      const callsAfterPair = applyChecklistUpdate.mock.calls.length;
      act(() => {
        input.props.onChangeText('(');
      });

      expect(getState().checklist[0].title).toBe('()');
      expect(applyChecklistUpdate).toHaveBeenCalledTimes(callsAfterPair);

      input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });
      act(() => {
        input.props.onChangeText('(())');
      });

      expect(getState().checklist[0].title).toBe('()');
      expect(applyChecklistUpdate).toHaveBeenCalledTimes(callsAfterPair);
    });
  });

  it('tracks the focused Android checklist row handle for measured scrolling', () => {
    const { getState, applyChecklistUpdate } = createChecklistState();
    const handleInputFocus = vi.fn();
    let tree!: ReturnType<typeof create>;

    withPlatform('android', () => {
      act(() => {
        tree = create(
          <TaskEditContentField
            {...baseProps}
            fieldId="checklist"
            checklist={getState().checklist}
            applyChecklistUpdate={applyChecklistUpdate}
            handleInputFocus={handleInputFocus}
          />
        );
      });

      const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });

      act(() => {
        input.props.onFocus({ nativeEvent: { target: 42 } });
      });

      expect(handleInputFocus).toHaveBeenCalledWith(42);
    });
  });

  it('defers Android Add Item focus by one frame after layout and requests it exactly once', () => {
    const { getState, applyChecklistUpdate } = createChecklistState();
    const frames = installAnimationFrameHarness();
    const inputNodes = createChecklistInputNodes();
    let tree!: ReturnType<typeof create>;

    const renderField = () => (
      <TaskEditContentField
        {...baseProps}
        fieldId="checklist"
        checklist={getState().checklist}
        applyChecklistUpdate={applyChecklistUpdate}
      />
    );

    withPlatform('android', () => {
      act(() => {
        tree = create(renderField(), { createNodeMock: inputNodes.createNodeMock });
      });
      act(() => {
        tree.root.findByProps({ testID: 'mobile-checklist-add-item' }).props.onPress();
        tree.update(renderField());
      });

      const insertedNode = inputNodes.nodes[1];
      expect(insertedNode.focus).not.toHaveBeenCalled();
      const newInput = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 2' });
      act(() => {
        newInput.props.onLayout();
        newInput.props.onLayout();
      });
      expect(frames.request).toHaveBeenCalledTimes(1);
      expect(insertedNode.focus).not.toHaveBeenCalled();

      act(() => frames.runNext());
      expect(insertedNode.focus).toHaveBeenCalledTimes(1);
      expect(logInfoMock).toHaveBeenCalledWith('Checklist insertion focus requested after layout', {
        scope: 'task-edit',
        extra: {
          releaseCheck: 'v1.3.0/checklist-insert-focus',
          stage: 'layout-ready',
        },
      });

      act(() => newInput.props.onLayout());
      expect(frames.request).toHaveBeenCalledTimes(1);
      expect(insertedNode.focus).toHaveBeenCalledTimes(1);
    });
  });

  it('uses the same one-frame Android focus path for Enter insertion', () => {
    const { getState, applyChecklistUpdate } = createChecklistState();
    const frames = installAnimationFrameHarness();
    const inputNodes = createChecklistInputNodes();
    const renderField = () => (
      <TaskEditContentField
        {...baseProps}
        fieldId="checklist"
        checklist={getState().checklist}
        applyChecklistUpdate={applyChecklistUpdate}
      />
    );
    let tree!: ReturnType<typeof create>;

    withPlatform('android', () => {
      act(() => {
        tree = create(renderField(), { createNodeMock: inputNodes.createNodeMock });
      });
      act(() => {
        tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' }).props.onSubmitEditing();
        tree.update(renderField());
      });

      const insertedNode = inputNodes.nodes[1];
      act(() => tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 2' }).props.onLayout());
      expect(insertedNode.focus).not.toHaveBeenCalled();
      act(() => frames.runNext());
      expect(insertedNode.focus).toHaveBeenCalledTimes(1);
      expect(logInfoMock).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps iOS insertion focus immediate on first layout', () => {
    const { getState, applyChecklistUpdate } = createChecklistState();
    const frames = installAnimationFrameHarness();
    const inputNodes = createChecklistInputNodes();
    const renderField = () => (
      <TaskEditContentField
        {...baseProps}
        fieldId="checklist"
        checklist={getState().checklist}
        applyChecklistUpdate={applyChecklistUpdate}
      />
    );
    let tree!: ReturnType<typeof create>;

    withPlatform('ios', () => {
      act(() => {
        tree = create(renderField(), { createNodeMock: inputNodes.createNodeMock });
      });
      act(() => {
        tree.root.findByProps({ testID: 'mobile-checklist-add-item' }).props.onPress();
        tree.update(renderField());
      });
      const insertedNode = inputNodes.nodes[1];
      const newInput = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 2' });
      act(() => newInput.props.onLayout());
      expect(insertedNode.focus).toHaveBeenCalledTimes(1);
      expect(frames.request).not.toHaveBeenCalled();
      expect(logInfoMock).not.toHaveBeenCalled();
      act(() => newInput.props.onLayout());
      expect(insertedNode.focus).toHaveBeenCalledTimes(1);
    });
  });

  it('cancels queued Android insertion focus on unmount', () => {
    const { getState, applyChecklistUpdate } = createChecklistState();
    const frames = installAnimationFrameHarness();
    const inputNodes = createChecklistInputNodes();
    const renderField = () => (
      <TaskEditContentField
        {...baseProps}
        fieldId="checklist"
        checklist={getState().checklist}
        applyChecklistUpdate={applyChecklistUpdate}
      />
    );
    let tree!: ReturnType<typeof create>;

    withPlatform('android', () => {
      act(() => {
        tree = create(renderField(), { createNodeMock: inputNodes.createNodeMock });
      });
      act(() => {
        tree.root.findByProps({ testID: 'mobile-checklist-add-item' }).props.onPress();
        tree.update(renderField());
      });
      const insertedNode = inputNodes.nodes[1];
      act(() => tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 2' }).props.onLayout());
      expect(frames.request).toHaveBeenCalledTimes(1);

      act(() => tree.unmount());
      expect(frames.cancel).toHaveBeenCalledTimes(1);
      act(() => frames.runAll());
      expect(insertedNode.focus).not.toHaveBeenCalled();
      expect(logInfoMock).not.toHaveBeenCalled();
    });
  });

  it('cancels queued Android insertion focus when the task changes', () => {
    const { getState, applyChecklistUpdate } = createChecklistState();
    const frames = installAnimationFrameHarness();
    const inputNodes = createChecklistInputNodes();
    const renderField = (taskId: string) => (
      <TaskEditContentField
        {...baseProps}
        task={{ id: taskId, status: 'next' } as any}
        fieldId="checklist"
        checklist={getState().checklist}
        applyChecklistUpdate={applyChecklistUpdate}
      />
    );
    let tree!: ReturnType<typeof create>;

    withPlatform('android', () => {
      act(() => {
        tree = create(renderField('task-1'), { createNodeMock: inputNodes.createNodeMock });
      });
      act(() => {
        tree.root.findByProps({ testID: 'mobile-checklist-add-item' }).props.onPress();
        tree.update(renderField('task-1'));
      });
      const insertedNode = inputNodes.nodes[1];
      act(() => tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 2' }).props.onLayout());
      act(() => tree.update(renderField('task-2')));

      expect(frames.cancel).toHaveBeenCalledTimes(1);
      act(() => frames.runAll());
      expect(insertedNode.focus).not.toHaveBeenCalled();
      expect(logInfoMock).not.toHaveBeenCalled();
    });
  });

  it('cancels queued Android insertion focus when the pending row is removed', () => {
    const { getState, applyChecklistUpdate } = createChecklistState();
    const frames = installAnimationFrameHarness();
    const inputNodes = createChecklistInputNodes();
    const renderField = () => (
      <TaskEditContentField
        {...baseProps}
        fieldId="checklist"
        checklist={getState().checklist}
        applyChecklistUpdate={applyChecklistUpdate}
      />
    );
    let tree!: ReturnType<typeof create>;

    withPlatform('android', () => {
      act(() => {
        tree = create(renderField(), { createNodeMock: inputNodes.createNodeMock });
      });
      act(() => {
        tree.root.findByProps({ testID: 'mobile-checklist-add-item' }).props.onPress();
        tree.update(renderField());
      });
      const insertedNode = inputNodes.nodes[1];
      act(() => tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 2' }).props.onLayout());
      act(() => {
        applyChecklistUpdate(getState().checklist.slice(0, 1));
        tree.update(renderField());
      });

      expect(frames.cancel).toHaveBeenCalledTimes(1);
      act(() => frames.runAll());
      expect(insertedNode.focus).not.toHaveBeenCalled();
      expect(logInfoMock).not.toHaveBeenCalled();
    });
  });

  it('cancels a superseded Android insertion and focuses only the latest row', () => {
    const { getState, applyChecklistUpdate } = createChecklistState([
      { id: 'check-1', title: 'Item 1', isCompleted: false },
      { id: 'check-2', title: 'Item 2', isCompleted: false },
    ]);
    const frames = installAnimationFrameHarness();
    const inputNodes = createChecklistInputNodes();
    const renderField = () => (
      <TaskEditContentField
        {...baseProps}
        fieldId="checklist"
        checklist={getState().checklist}
        applyChecklistUpdate={applyChecklistUpdate}
      />
    );
    let tree!: ReturnType<typeof create>;

    withPlatform('android', () => {
      act(() => {
        tree = create(renderField(), { createNodeMock: inputNodes.createNodeMock });
      });
      act(() => {
        tree.root.findByProps({ testID: 'mobile-checklist-add-item' }).props.onPress();
        tree.update(renderField());
      });
      const firstInsertedNode = inputNodes.nodes[2];
      act(() => tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 3' }).props.onLayout());

      act(() => {
        tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' }).props.onSubmitEditing();
        tree.update(renderField());
      });
      const latestInsertedNode = inputNodes.nodes[3];
      expect(frames.cancel).toHaveBeenCalledTimes(1);
      act(() => tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 2' }).props.onLayout());
      expect(frames.request).toHaveBeenCalledTimes(2);

      act(() => frames.runAll());
      expect(firstInsertedNode.focus).not.toHaveBeenCalled();
      expect(latestInsertedNode.focus).toHaveBeenCalledTimes(1);
      expect(logInfoMock).toHaveBeenCalledTimes(1);
    });
  });

  it('does not add another blank checklist item while one is already empty', () => {
    const { getState, applyChecklistUpdate } = createChecklistState([
      { id: 'check-1', title: '', isCompleted: false },
    ]);
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditContentField
          {...baseProps}
          fieldId="checklist"
          checklist={getState().checklist}
          applyChecklistUpdate={applyChecklistUpdate}
        />
      );
    });

    const addItem = tree.root.findByProps({ testID: 'mobile-checklist-add-item' });

    act(() => {
      addItem.props.onPress();
      addItem.props.onPress();
    });

    expect(applyChecklistUpdate).not.toHaveBeenCalled();
  });

  it('wraps selected checklist item text from native mobile text changes', () => {
    const { getState, applyChecklistUpdate } = createChecklistState();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditContentField
          {...baseProps}
          fieldId="checklist"
          checklist={getState().checklist}
          applyChecklistUpdate={applyChecklistUpdate}
        />
      );
    });

    const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });

    act(() => {
      input.props.onSelectionChange({ nativeEvent: { selection: { start: 0, end: 6 } } });
      input.props.onChangeText('~');
    });

    expect(getState().checklist[0].title).toBe('~~Item 1~~');
  });

  it('keeps native checklist text changes plain when editor assist is disabled', () => {
    useTaskStore.setState({ settings: { markdownEditorAssist: false } });
    const { getState, applyChecklistUpdate } = createChecklistState();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditContentField
          {...baseProps}
          fieldId="checklist"
          checklist={getState().checklist}
          applyChecklistUpdate={applyChecklistUpdate}
        />
      );
    });

    const input = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 1' });

    act(() => {
      input.props.onSelectionChange({ nativeEvent: { selection: { start: 0, end: 6 } } });
      input.props.onChangeText('~');
    });

    expect(getState().checklist[0].title).toBe('~');
  });

  it('orders checklist items from compact mobile order controls', () => {
    const checklist = [
      { id: 'check-1', title: 'Item 1', isCompleted: false },
      { id: 'check-2', title: 'Item 2', isCompleted: false },
      { id: 'check-3', title: 'Item 3', isCompleted: true },
    ];
    const { getState, applyChecklistUpdate } = createChecklistState(checklist);
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <TaskEditContentField
          {...baseProps}
          fieldId="checklist"
          checklist={getState().checklist}
          applyChecklistUpdate={applyChecklistUpdate}
        />
      );
    });

    const orderToggle = tree.root.findByProps({ testID: 'mobile-checklist-order-toggle' });

    act(() => {
      orderToggle.props.onPress();
    });

    expect(tree.root.findByProps({ testID: 'mobile-checklist-order-panel' })).toBeTruthy();

    const moveFirstDown = tree.root.findByProps({ testID: 'mobile-checklist-move-down-check-1' });

    act(() => {
      moveFirstDown.props.onPress();
    });

    expect(getState().checklist.map((item: any) => item.id)).toEqual([
      'check-2',
      'check-1',
      'check-3',
    ]);
  });

  it('keeps the description Preview/Edit toggle labelled while it becomes an icon button', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<TaskEditContentField {...baseProps} fieldId="description" />);
    });

    const previewToggle = tree.root.findByProps({ accessibilityLabel: 'markdown.preview' });
    expect(previewToggle.props.accessibilityRole).toBe('button');
    expect(previewToggle.findAllByType(Text)).toHaveLength(0);
    expect(previewToggle.findAll((node) => node.props?.size === 18).length).toBeGreaterThan(0);

    act(() => {
      previewToggle.props.onPress();
    });
    expect(baseProps.setShowDescriptionPreview).toHaveBeenCalledTimes(1);


    let previewTree!: ReturnType<typeof create>;
    act(() => {
      previewTree = create(
        <TaskEditContentField {...baseProps} fieldId="description" showDescriptionPreview />
      );
    });
    const editToggle = previewTree.root.findByProps({ accessibilityLabel: 'markdown.edit' });
    expect(editToggle.findAll((node) => node.props?.size === 18).length).toBeGreaterThan(0);
  });

  it('converts attachment Edit/Remove row actions to icon-only labelled buttons', () => {
    const editLinkAttachment = vi.fn();
    const removeAttachment = vi.fn();
    const stylesWithAttachments = {
      ...baseProps.styles,
      attachmentHeader: {},
      attachmentActions: {},
      attachmentButton: {},
      attachmentButtonText: {},
      attachmentsList: {},
      attachmentRow: {},
      attachmentTitleWrap: {},
      attachmentTitle: {},
      attachmentDownload: {},
      attachmentStatus: {},
      attachmentRemove: {},
      helperText: {},
    };
    const attachments = [{
      id: 'a-1',
      kind: 'link',
      title: 'Example doc',
      uri: 'https://example.com/doc',
      localStatus: 'available',
    }];
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <TaskEditContentField
          {...baseProps}
          styles={stylesWithAttachments}
          fieldId="attachments"
          visibleAttachments={attachments}
          editLinkAttachment={editLinkAttachment}
          removeAttachment={removeAttachment}
        />
      );
    });

    const editButton = tree.root.findByProps({ accessibilityLabel: 'common.edit' });
    expect(editButton.props.accessibilityRole).toBe('button');
    expect(editButton.findAllByType(Text)).toHaveLength(0);
    expect(editButton.findAll((node) => node.props?.size === 14).length).toBeGreaterThan(0);

    act(() => {
      editButton.props.onPress();
    });
    expect(editLinkAttachment).toHaveBeenCalledWith(expect.objectContaining({ id: 'a-1' }));

    const removeButton = tree.root.findByProps({ accessibilityLabel: 'attachments.remove' });
    expect(removeButton.findAll((node) => node.props?.size === 14).length).toBeGreaterThan(0);

    act(() => {
      removeButton.props.onPress();
    });
    expect(removeAttachment).toHaveBeenCalledWith('a-1');
  });
});


describe('checklist handle reordering', () => {
  afterEach(() => {
    act(() => { for (const tree of renderedTrees.splice(0)) tree.unmount(); });
    vi.unstubAllGlobals();
  });
  it('switches action menus on release without collapsing the old menu on touch down', () => {
    installAnimationFrameHarness();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<TaskEditContentField {...baseProps} fieldId="checklist"
      checklist={[{ id: 'a', title: 'A', isCompleted: false }, { id: 'b', title: 'B', isCompleted: true }]} />); });
    const first = tree.root.findByProps({ testID: 'mobile-checklist-drag-checklist-row-1' });
    const second = tree.root.findByProps({ testID: 'mobile-checklist-drag-checklist-row-2' });
    act(() => first.props.onAccessibilityTap());
    const action = () => tree.root.findAll((node) => node.props.onPress && node.findAllByType(Text).some((text) => text.props.children === 'taskEdit.moveChecklistTop'))[0];
    expect(action().props.disabled).toBe(true);
    act(() => second.props.onResponderGrant({ nativeEvent: { pageY: 75 } }));
    expect(action().props.disabled).toBe(true);
    act(() => second.props.onResponderRelease());
    expect(action().props.disabled).toBe(false);
    act(() => second.props.onResponderGrant({ nativeEvent: { pageY: 75 } }));
    act(() => second.props.onResponderRelease());
    expect(action()).toBeUndefined();
  });

  it('keeps the dragged row under the finger when a menu above it collapses', () => {
    const frames = installAnimationFrameHarness();
    const changed = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<TaskEditContentField {...baseProps} fieldId="checklist" applyChecklistUpdate={changed}
      checklist={['A', 'B', 'C'].map((title) => ({ id: title, title, isCompleted: false }))} />,
      { createNodeMock: () => ({ measureInWindow: (callback: (x: number, y: number) => void) => callback(0, 100), blur: vi.fn() }) }); });
    const rows = tree.root.findAll((node) => node.type === View && String(node.props.testID ?? '').startsWith('mobile-checklist-row-'));
    const first = tree.root.findByProps({ testID: 'mobile-checklist-drag-checklist-row-1' });
    const second = tree.root.findByProps({ testID: 'mobile-checklist-drag-checklist-row-2' });
    act(() => first.props.onAccessibilityTap());
    act(() => rows.forEach((row, index) => row.props.onLayout({ nativeEvent: { layout: { y: index === 0 ? 0 : 100 + (index - 1) * 70, height: index === 0 ? 100 : 70 } } })));
    act(() => second.props.onResponderGrant({ nativeEvent: { pageX: 20, pageY: 225 } }));
    act(() => second.props.onResponderMove({ nativeEvent: { pageX: 350, pageY: 240 } }));
    act(() => rows.forEach((row, index) => row.props.onLayout({ nativeEvent: { layout: { y: index === 0 ? 0 : 50 + (index - 1) * 70, height: index === 0 ? 50 : 70 } } })));
    act(() => frames.runNext());
    expect(rows[1].props.style.transform).toEqual([{ translateY: 65 }]);
    expect(tree.root.findByProps({ testID: 'mobile-checklist-drag-checklist-row-2' })).toBe(second);
    act(() => second.props.onTouchCancel());
    expect(rows[1].props.style).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
  });

  it('moves the selected duplicate row and preserves the mounted input and unsaved text', () => {
    let saved: { id: string; title: string; isCompleted: boolean }[] = [];
    function Harness() {
      const [items, setItems] = React.useState([
        { id: 'duplicate', title: 'First', isCompleted: false },
        { id: 'duplicate', title: 'Second', isCompleted: true },
        { id: 'last', title: 'Last', isCompleted: false },
      ]);
      saved = items;
      return <TaskEditContentField {...baseProps} fieldId="checklist" checklist={items} applyChecklistUpdate={setItems} />;
    }
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Harness />); });
    const second = tree.root.findAllByType(TextInput)[1];
    act(() => second.props.onChangeText('Unsaved text'));
    const handle = tree.root.findByProps({ testID: 'mobile-checklist-drag-checklist-row-2' });
    act(() => handle.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } }));
    const toTop = tree.root.findAll((node) => node.props.onPress && node.findAllByType(Text).some((text) => text.props.children === 'taskEdit.moveChecklistTop'))[0];
    act(() => toTop.props.onPress());
    expect(saved.map((row) => [row.id, row.title, row.isCompleted])).toEqual([
      ['duplicate', 'Unsaved text', true], ['duplicate', 'First', false], ['last', 'Last', false],
    ]);
    expect(tree.root.findAllByType(TextInput)[0]).toBe(second);
  });

  it('commits a handle drag once on drop and leaves the draft unchanged on cancellation', () => {
    const frames = installAnimationFrameHarness();
    let saved: { id: string; title: string; isCompleted: boolean }[] = [];
    const changed = vi.fn();
    let scrollOffset = 0;
    const scroll = {
      begin: vi.fn(), end: vi.fn(), offset: () => scrollOffset,
      viewport: () => ({ top: 100, bottom: 400 }),
      scrollBy: vi.fn((delta: number) => { scrollOffset += delta; }),
    };
    function Harness() {
      const [items, setItems] = React.useState(Array.from({ length: 30 }, (_, index) => ({ id: String(index), title: `Row ${index}`, isCompleted: index === 0 })));
      saved = items;
      return <ChecklistDragScrollContext.Provider value={scroll}>
        <TaskEditContentField {...baseProps} fieldId="checklist" checklist={items}
          applyChecklistUpdate={(next: typeof items) => { changed(next); setItems(next); }} />
      </ChecklistDragScrollContext.Provider>;
    }
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Harness />, { createNodeMock: () => ({ measureInWindow: (callback: (x: number, y: number) => void) => callback(0, 100), blur: vi.fn() }) }); });
    const layoutRows = () => tree.root.findAll((node) => node.type === View && String(node.props.testID ?? '').startsWith('mobile-checklist-row-'))
      .forEach((row, index) => row.props.onLayout({ nativeEvent: { layout: { y: index * 50, height: 50 } } }));
    act(layoutRows);
    const handle = tree.root.findByProps({ testID: 'mobile-checklist-drag-checklist-row-1' });
    act(() => expect(handle.props.onResponderGrant({ nativeEvent: { pageX: 20, pageY: 125 } })).toBe(true));
    act(() => { handle.props.onResponderMove({ nativeEvent: { pageX: 320, pageY: 1525 } }); frames.runNext(); });
    expect(changed).not.toHaveBeenCalled();
    const draggedRow = tree.root.findByProps({ testID: 'mobile-checklist-row-checklist-row-1' });
    expect(draggedRow.props.style.transform[0].translateY).toBe(1400 + scrollOffset);
    expect(tree.root.findByProps({ testID: 'mobile-checklist-row-checklist-row-2' }).props.style.transform).toEqual([{ translateY: -50 }]);
    expect(tree.root.findByProps({ testID: 'mobile-checklist-drag-checklist-row-1' })).toBe(handle);
    expect(scroll.begin).toHaveBeenCalled();
    expect(scroll.scrollBy).toHaveBeenCalledWith(expect.any(Number));
    expect(scrollOffset).toBeGreaterThan(0);
    act(() => handle.props.onResponderTerminate());
    expect(scroll.end).toHaveBeenCalled();
    const scrollCalls = scroll.scrollBy.mock.calls.length;
    act(() => frames.runAll());
    expect(scroll.scrollBy).toHaveBeenCalledTimes(scrollCalls);
    expect(saved[0].title).toBe('Row 0');
    expect(draggedRow.props.style).toBeUndefined();
    act(() => handle.props.onResponderGrant({ nativeEvent: { pageY: 125 } }));
    act(() => { handle.props.onResponderMove({ nativeEvent: { pageY: 1525 } }); frames.runNext(); });
    act(() => handle.props.onResponderRelease());
    expect(changed).toHaveBeenCalledTimes(1);
    expect(saved[28]).toEqual({ id: '0', title: 'Row 0', isCompleted: true });
  });
  it('cancels the active drag when a different task reuses the editor', () => {
    installAnimationFrameHarness();
    const changed = vi.fn();
    const checklist = [{ id: 'a', title: 'A', isCompleted: false }, { id: 'b', title: 'B', isCompleted: false }];
    let tree!: ReturnType<typeof create>;
    const content = (id: string) => <TaskEditContentField {...baseProps} fieldId="checklist" task={{ ...baseProps.task, id }} checklist={checklist} applyChecklistUpdate={changed} />;
    act(() => { tree = create(content('first'), { createNodeMock: () => ({ measureInWindow: (callback: (x: number, y: number) => void) => callback(0, 0), blur: vi.fn() }) }); });
    const rows = tree.root.findAll((node) => node.type === View && String(node.props.testID ?? '').startsWith('mobile-checklist-row-'));
    act(() => rows.forEach((row, index) => row.props.onLayout({ nativeEvent: { layout: { y: index * 50, height: 50 } } })));
    const first = tree.root.findByProps({ testID: 'mobile-checklist-drag-first-row-1' });
    act(() => first.props.onResponderGrant({ nativeEvent: { pageY: 25 } }));
    act(() => first.props.onResponderMove({ nativeEvent: { pageY: 75 } }));
    act(() => tree.update(content('second')));
    const second = tree.root.findByProps({ testID: 'mobile-checklist-drag-second-row-1' });
    act(() => second.props.onResponderRelease());
    expect(changed).not.toHaveBeenCalled();
  });

});

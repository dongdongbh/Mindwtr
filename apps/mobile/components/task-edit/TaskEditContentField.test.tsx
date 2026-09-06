import React from 'react';
import { Platform, Text, TextInput, View } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTaskStore } from '@mindwtr/core';

import { TaskEditContentField } from './TaskEditContentField';

const mockFindNodeHandle = vi.hoisted(() => vi.fn(() => 314));

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
  afterEach(() => {
    useTaskStore.setState({ settings: {} });
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
    const checkmark = checkbox.findByType(Text);

    expect(checkbox.props.accessibilityState).toEqual({ checked: true });
    expect(flattenStyle(checkboxVisual.props.style).backgroundColor).toBe(baseProps.tc.tint);
    expect(flattenStyle(checkmark.props.style).color).toBe(baseProps.tc.onTint);
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

  it('focuses a newly added checklist row from its first layout, not the mount commit', () => {
    const { getState, applyChecklistUpdate } = createChecklistState();
    const focus = vi.fn();
    let tree!: ReturnType<typeof create>;

    const renderField = () => (
      <TaskEditContentField
        {...baseProps}
        fieldId="checklist"
        checklist={getState().checklist}
        applyChecklistUpdate={applyChecklistUpdate}
      />
    );

    act(() => {
      tree = create(renderField(), { createNodeMock: () => ({ focus }) });
    });

    const addItem = tree.root.findByProps({ testID: 'mobile-checklist-add-item' });
    act(() => {
      addItem.props.onPress();
    });
    act(() => {
      tree.update(renderField());
    });

    // Focusing before the row has a native layout makes Android's ScrollView
    // jump to the top of the checklist, so the mount commit must not focus.
    expect(focus).not.toHaveBeenCalled();

    const newInput = tree.root.findByProps({ accessibilityLabel: 'taskEdit.checklist 2' });
    act(() => {
      newInput.props.onLayout();
    });
    expect(focus).toHaveBeenCalledTimes(1);

    // Later relayouts of the same row must not steal focus again.
    act(() => {
      newInput.props.onLayout();
    });
    expect(focus).toHaveBeenCalledTimes(1);
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

    // In preview mode the same control reads as Edit and shows a pencil.
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

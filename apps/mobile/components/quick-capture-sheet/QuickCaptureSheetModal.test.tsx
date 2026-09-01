import React from 'react';
import { FlatList, KeyboardAvoidingView, Modal, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ToastViewport } from '@/contexts/toast-context';
import { QuickCaptureSheetBody } from './QuickCaptureSheetBody';
import { QuickCaptureSheetPickers } from './QuickCaptureSheetPickers';

vi.mock('@react-native-community/datetimepicker', () => ({
  default: (props: Record<string, unknown>) => React.createElement('DateTimePicker', props),
}));

// Stubbed only to keep react-native-safe-area-context out of this render test; the
// assertions below still match on the real component identity.
vi.mock('@/contexts/toast-context', () => ({
  ToastViewport: () => null,
  useToast: () => ({ showToast: () => {}, dismissToast: () => {} }),
}));

const tc: any = {
  cardBg: '#111827',
  border: '#334155',
  danger: '#ef4444',
  filterBg: '#1f2937',
  inputBg: '#0f172a',
  onTint: '#ffffff',
  secondaryText: '#94a3b8',
  text: '#f8fafc',
  tint: '#3b82f6',
};

const flattenStyle = (style: unknown): Record<string, any> => {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, any>>((acc, item) => Object.assign(acc, flattenStyle(item)), {});
  }
  return style && typeof style === 'object' ? (style as Record<string, any>) : {};
};

describe('Quick capture modal composition', () => {
  it('announces saving and disables save and dismissal controls while a submission is active', () => {
    const handleClose = vi.fn();
    let tree!: ReturnType<typeof create>;
    const t = (key: string) => ({
      'common.close': 'Close',
      'common.loading': 'Loading...',
      'common.more': 'More',
      'common.save': 'Save',
      'nav.addTask': 'Add Task',
      'quickAdd.addAnother': 'Add another',
      'quickAdd.audioProcessing': 'Processing audio capture...',
      'quickAdd.audioRecord': 'Record',
      'quickAdd.inputHint': 'Capture task title',
      'quickAdd.inputLabel': 'Task title',
      'taskEdit.contextsLabel': 'Contexts',
      'taskEdit.projectLabel': 'Project',
    }[key] ?? key);

    act(() => {
      tree = create(
        <QuickCaptureSheetBody
          addAnother={false}
          areaLabel="No Area"
          contextLabel="Contexts"
          dueDate={null}
          dueLabel="Due Date"
          dueTimeLabel="Change time"
          handleClose={handleClose}
          handleSave={vi.fn()}
          insetsBottom={0}
          inputRef={{ current: null }}
          noteValue=""
          onNoteChange={vi.fn()}
          onOpenAreaPicker={vi.fn()}
          onOpenContextPicker={vi.fn()}
          onOpenDueDatePicker={vi.fn()}
          onOpenDueTimePicker={vi.fn()}
          onOpenPriorityPicker={vi.fn()}
          onOpenProjectPicker={vi.fn()}
          onQuickDueDateSelect={vi.fn()}
          onResetArea={vi.fn()}
          onResetContexts={vi.fn()}
          onResetDueDate={vi.fn()}
          onResetDueTime={vi.fn()}
          onResetPriority={vi.fn()}
          onResetProject={vi.fn()}
          onToggleOptions={vi.fn()}
          onToggleAddAnother={vi.fn()}
          onToggleRecording={vi.fn()}
          onValueChange={vi.fn()}
          optionsExpanded={false}
          prioritiesEnabled
          priorityLabel="Priority"
          projectLabel="Project"
          recording={false}
          recordingBusy
          recordingReady={false}
          saving
          sheetMaxHeight={500}
          showDueTime={false}
          t={t}
          tc={tc}
          value="Capture me"
          visible
        />
      );
    });

    const controls = tree.root.findAllByType(TouchableOpacity);
    const closeControls = controls.filter((node) => node.props.accessibilityLabel === 'Close');
    const save = controls.find((node) => node.props.accessibilityLabel === 'Save');
    expect(closeControls.length).toBeGreaterThan(0);
    expect(closeControls.every((node) => node.props.disabled === true)).toBe(true);
    expect(save?.props.disabled).toBe(true);
    expect(save?.props.accessibilityState).toEqual({ busy: true, disabled: true });
    expect(tree.root.findByType(Modal).props.onRequestClose).not.toBe(handleClose);
    expect(tree.root.findAllByType(Text).some((node) => node.props.children === 'Processing audio capture...')).toBe(true);
  });

  it('does not mount picker modals while every picker is closed', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <QuickCaptureSheetPickers
          filteredAreas={[]}
          contextInputRef={{ current: null }}
          contextOptionsLoading={false}
          contextQuery=""
          contextTags={[]}
          dueDate={null}
          filteredContexts={[]}
          filteredProjects={[]}
          hasAddableContextTokens={false}
          hasExactProjectMatch={false}
          onAddContextFromQuery={vi.fn()}
          onClearContexts={vi.fn()}
          onCloseAreaPicker={vi.fn()}
          onCloseContextPicker={vi.fn()}
          onClosePriorityPicker={vi.fn()}
          onCloseProjectPicker={vi.fn()}
          onContextQueryChange={vi.fn()}
          onDueDateChange={vi.fn()}
          onDueTimeChange={vi.fn()}
          onProjectQueryChange={vi.fn()}
          onRemoveContext={vi.fn()}
          onSelectArea={vi.fn()}
          onSelectContext={vi.fn()}
          onSelectPriority={vi.fn()}
          onSelectProject={vi.fn()}
          onStartTimeChange={vi.fn()}
          onSubmitContextQuery={vi.fn()}
          onSubmitProjectQuery={vi.fn()}
          pendingStartDate={null}
          prioritiesEnabled
          priorityOptions={['low', 'medium', 'high', 'urgent']}
          projectQuery=""
          selectedAreaId={null}
          selectedPriority={null}
          showAreaPicker={false}
          showContextPicker={false}
          showDatePicker={false}
          showDueTimePicker={false}
          showPriorityPicker={false}
          showProjectPicker={false}
          startPickerMode={null}
          startTime={null}
          t={(key) => key}
          tc={tc}
        />
      );
    });

    expect(tree.root.findAllByType(Modal)).toHaveLength(0);
  });

  it('renders the requested picker overlay without a nested native modal', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <QuickCaptureSheetPickers
          filteredAreas={[]}
          contextInputRef={{ current: null }}
          contextOptionsLoading={false}
          contextQuery=""
          contextTags={[]}
          dueDate={null}
          filteredContexts={['@home']}
          filteredProjects={[]}
          hasAddableContextTokens={false}
          hasExactProjectMatch={false}
          onAddContextFromQuery={vi.fn()}
          onClearContexts={vi.fn()}
          onCloseAreaPicker={vi.fn()}
          onCloseContextPicker={vi.fn()}
          onClosePriorityPicker={vi.fn()}
          onCloseProjectPicker={vi.fn()}
          onContextQueryChange={vi.fn()}
          onDueDateChange={vi.fn()}
          onDueTimeChange={vi.fn()}
          onProjectQueryChange={vi.fn()}
          onRemoveContext={vi.fn()}
          onSelectArea={vi.fn()}
          onSelectContext={vi.fn()}
          onSelectPriority={vi.fn()}
          onSelectProject={vi.fn()}
          onStartTimeChange={vi.fn()}
          onSubmitContextQuery={vi.fn()}
          onSubmitProjectQuery={vi.fn()}
          pendingStartDate={null}
          prioritiesEnabled
          priorityOptions={['low', 'medium', 'high', 'urgent']}
          projectQuery=""
          selectedAreaId={null}
          selectedPriority={null}
          showAreaPicker={false}
          showContextPicker
          showDatePicker={false}
          showDueTimePicker={false}
          showPriorityPicker={false}
          showProjectPicker={false}
          startPickerMode={null}
          startTime={null}
          t={(key) => key}
          tc={tc}
        />
      );
    });

    expect(tree.root.findAllByType(Modal)).toHaveLength(0);
    const overlays = tree.root.findAll((node) => node.props.accessibilityViewIsModal === true);
    expect(overlays.length).toBeGreaterThan(0);
    expect(tree.root.findByType(FlatList).props.accessibilityRole).toBe('list');
    expect(tree.root.findByProps({ accessibilityRole: 'header' }).props.children).toBe('taskEdit.contextsLabel');
  });

  it('disables Android modal animation to avoid ghosted sheet trails', () => {
    let tree!: ReturnType<typeof create>;
    const originalPlatformOs = Platform.OS;
    const handleClose = vi.fn();
    const handleRequestClose = vi.fn();

    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: 'android',
    });

    try {
      act(() => {
        tree = create(
          <QuickCaptureSheetBody
            addAnother={false}
            areaLabel="No Area"
            contextLabel="Contexts"
            dueDate={null}
            dueLabel="Due Date"
            dueTimeLabel="Change time"
            contentAccessibilityHidden
            handleClose={handleClose}
            handleRequestClose={handleRequestClose}
            handleSave={vi.fn()}
            insetsBottom={0}
            inputRef={{ current: null }}
            noteValue=""
            onNoteChange={vi.fn()}
            onOpenAreaPicker={vi.fn()}
            onOpenContextPicker={vi.fn()}
            onOpenDueDatePicker={vi.fn()}
            onOpenDueTimePicker={vi.fn()}
            onOpenPriorityPicker={vi.fn()}
            onOpenProjectPicker={vi.fn()}
            onQuickDueDateSelect={vi.fn()}
            onResetArea={vi.fn()}
            onResetContexts={vi.fn()}
            onResetDueDate={vi.fn()}
            onResetDueTime={vi.fn()}
            onResetPriority={vi.fn()}
            onResetProject={vi.fn()}
            onToggleOptions={vi.fn()}
            onToggleAddAnother={vi.fn()}
            onToggleRecording={vi.fn()}
            onValueChange={vi.fn()}
            optionsExpanded={false}
            prioritiesEnabled
            priorityLabel="Priority"
            projectLabel="Project"
            recording={false}
            recordingBusy={false}
            recordingReady={false}
            sheetMaxHeight={500}
            showDueTime={false}
            t={(key) => key}
            tc={tc}
            value=""
            visible
          />
        );
      });
    } finally {
      Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: originalPlatformOs,
      });
    }

    const modal = tree.root.findByType(Modal);
    expect(modal.props.transparent).toBe(true);
    expect(modal.props.animationType).toBe('none');
    expect(modal.props.hardwareAccelerated).toBe(true);
    expect(modal.props.onRequestClose).toBe(handleRequestClose);
    const keyboardAvoiding = tree.root.findByType(KeyboardAvoidingView);
    expect(keyboardAvoiding.props.behavior).toBeUndefined();
    expect(keyboardAvoiding.props.accessibilityElementsHidden).toBe(true);
    expect(keyboardAvoiding.props.importantForAccessibility).toBe('no-hide-descendants');
    const backdrop = tree.root.find(
      (node) => node.props.accessibilityRole === 'button'
        && node.props.accessibilityLabel === 'common.close'
    );
    expect(backdrop.props.accessibilityElementsHidden).toBe(true);
    expect(backdrop.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(modal.props.statusBarTranslucent).toBe(true);
    expect(modal.props.accessibilityViewIsModal).toBe(true);
  });

  it('lifts the Android sheet by the measured keyboard inset instead of resizing', () => {
    let tree!: ReturnType<typeof create>;
    const originalPlatformOs = Platform.OS;

    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });

    try {
      act(() => {
        tree = create(
          <QuickCaptureSheetBody
            addAnother={false}
            areaLabel="No Area"
            contextLabel="Contexts"
            dueDate={null}
            dueLabel="Due Date"
            dueTimeLabel="Change time"
            handleClose={vi.fn()}
            handleSave={vi.fn()}
            insetsBottom={0}
            inputRef={{ current: null }}
            androidKeyboardInset={280}
            noteValue=""
            onNoteChange={vi.fn()}
            onOpenAreaPicker={vi.fn()}
            onOpenContextPicker={vi.fn()}
            onOpenDueDatePicker={vi.fn()}
            onOpenDueTimePicker={vi.fn()}
            onOpenPriorityPicker={vi.fn()}
            onOpenProjectPicker={vi.fn()}
            onQuickDueDateSelect={vi.fn()}
            onResetArea={vi.fn()}
            onResetContexts={vi.fn()}
            onResetDueDate={vi.fn()}
            onResetDueTime={vi.fn()}
            onResetPriority={vi.fn()}
            onResetProject={vi.fn()}
            onToggleOptions={vi.fn()}
            onToggleAddAnother={vi.fn()}
            onToggleRecording={vi.fn()}
            onValueChange={vi.fn()}
            optionsExpanded={false}
            prioritiesEnabled
            priorityLabel="Priority"
            projectLabel="Project"
            recording={false}
            recordingBusy={false}
            recordingReady={false}
            sheetMaxHeight={500}
            showDueTime={false}
            t={(key) => key}
            tc={tc}
            value=""
            visible
          />
        );
      });
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOs });
    }

    const kav = tree.root.findByType(KeyboardAvoidingView);
    expect(kav.props.behavior).toBeUndefined();
    expect(flattenStyle(kav.props.style).paddingBottom).toBe(280);
  });

  it('lifts the picker overlay above the keyboard by the measured inset', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <QuickCaptureSheetPickers
          filteredAreas={[]}
          contextInputRef={{ current: null }}
          contextOptionsLoading={false}
          contextQuery=""
          contextTags={[]}
          dueDate={null}
          filteredContexts={['@home']}
          filteredProjects={[]}
          hasAddableContextTokens={false}
          hasExactProjectMatch={false}
          onAddContextFromQuery={vi.fn()}
          onClearContexts={vi.fn()}
          onCloseAreaPicker={vi.fn()}
          onCloseContextPicker={vi.fn()}
          onClosePriorityPicker={vi.fn()}
          onCloseProjectPicker={vi.fn()}
          onContextQueryChange={vi.fn()}
          onDueDateChange={vi.fn()}
          onDueTimeChange={vi.fn()}
          onProjectQueryChange={vi.fn()}
          onRemoveContext={vi.fn()}
          onSelectArea={vi.fn()}
          onSelectContext={vi.fn()}
          onSelectPriority={vi.fn()}
          onSelectProject={vi.fn()}
          onStartTimeChange={vi.fn()}
          onSubmitContextQuery={vi.fn()}
          onSubmitProjectQuery={vi.fn()}
          overlayKeyboardInset={280}
          pendingStartDate={null}
          prioritiesEnabled
          priorityOptions={['low', 'medium', 'high', 'urgent']}
          projectQuery=""
          selectedAreaId={null}
          selectedPriority={null}
          showAreaPicker={false}
          showContextPicker
          showDatePicker={false}
          showDueTimePicker={false}
          showPriorityPicker={false}
          showProjectPicker={false}
          startPickerMode={null}
          startTime={null}
          t={(key) => key}
          tc={tc}
        />
      );
    });

    const overlay = tree.root.find((node) => node.props.accessibilityViewIsModal === true);
    expect(flattenStyle(overlay.props.style).paddingBottom).toBe(280);
  });

  it('creates an area from the quick capture area picker query', () => {
    const onAreaQueryChange = vi.fn();
    const onSubmitAreaQuery = vi.fn();
    let tree!: ReturnType<typeof create>;
    const t = (key: string) => ({
      'areas.create': 'Create',
      'common.close': 'Close',
      'common.search': 'Search',
      'taskEdit.areaLabel': 'Area',
      'taskEdit.noAreaOption': 'No Area',
    }[key] ?? key);

    act(() => {
      tree = create(
        <QuickCaptureSheetPickers
          filteredAreas={[]}
          areaQuery="Work"
          contextInputRef={{ current: null }}
          contextOptionsLoading={false}
          contextQuery=""
          contextTags={[]}
          dueDate={null}
          filteredContexts={[]}
          filteredProjects={[]}
          hasAddableContextTokens={false}
          hasExactAreaMatch={false}
          hasExactProjectMatch={false}
          onAddContextFromQuery={vi.fn()}
          onAreaQueryChange={onAreaQueryChange}
          onClearContexts={vi.fn()}
          onCloseAreaPicker={vi.fn()}
          onCloseContextPicker={vi.fn()}
          onClosePriorityPicker={vi.fn()}
          onCloseProjectPicker={vi.fn()}
          onContextQueryChange={vi.fn()}
          onDueDateChange={vi.fn()}
          onDueTimeChange={vi.fn()}
          onProjectQueryChange={vi.fn()}
          onRemoveContext={vi.fn()}
          onSelectArea={vi.fn()}
          onSelectContext={vi.fn()}
          onSelectPriority={vi.fn()}
          onSelectProject={vi.fn()}
          onStartTimeChange={vi.fn()}
          onSubmitAreaQuery={onSubmitAreaQuery}
          onSubmitContextQuery={vi.fn()}
          onSubmitProjectQuery={vi.fn()}
          pendingStartDate={null}
          prioritiesEnabled
          priorityOptions={['low', 'medium', 'high', 'urgent']}
          projectQuery=""
          selectedAreaId={null}
          selectedPriority={null}
          showAreaPicker
          showContextPicker={false}
          showDatePicker={false}
          showDueTimePicker={false}
          showPriorityPicker={false}
          showProjectPicker={false}
          startPickerMode={null}
          startTime={null}
          t={t}
          tc={tc}
        />
      );
    });

    const input = tree.root.findAllByType(TextInput).find((node) => node.props.accessibilityLabel === 'Area');
    expect(input).toBeTruthy();
    act(() => {
      input?.props.onChangeText('Home');
    });
    expect(onAreaQueryChange).toHaveBeenCalledWith('Home');

    const createRow = tree.root.findByProps({ accessibilityLabel: 'Create: Work' });
    act(() => {
      createRow.props.onPress();
    });

    expect(onSubmitAreaQuery).toHaveBeenCalledTimes(1);
  });

  it('keeps collapsed capture focused on context and hides organizing fields behind More', () => {
    let tree!: ReturnType<typeof create>;
    const t = (key: string) => ({
      'common.close': 'Close',
      'common.more': 'More',
      'common.save': 'Save',
      'nav.addTask': 'Add Task',
      'quickAdd.addAnother': 'Add another',
      'quickAdd.audioRecord': 'Record',
      'quickAdd.inputHint': 'Capture task title',
      'quickAdd.inputLabel': 'Task title',
      'taskEdit.areaLabel': 'Area',
      'taskEdit.contextsLabel': 'Contexts',
      'taskEdit.dueDate': 'Due Date',
      'taskEdit.project': 'Project',
      'taskEdit.projectLabel': 'Project',
      'taskEdit.priorityLabel': 'Priority',
    })[key] ?? key;

    act(() => {
      tree = create(
        <QuickCaptureSheetBody
          addAnother={false}
          areaLabel="Work"
          contextLabel="@computer"
          dueDate={new Date('2026-06-04T12:00:00.000Z')}
          dueLabel="Tomorrow"
          dueTimeLabel="Change time"
          handleClose={vi.fn()}
          handleSave={vi.fn()}
          insetsBottom={0}
          inputRef={{ current: null }}
          noteValue=""
          onNoteChange={vi.fn()}
          onOpenAreaPicker={vi.fn()}
          onOpenContextPicker={vi.fn()}
          onOpenDueDatePicker={vi.fn()}
          onOpenDueTimePicker={vi.fn()}
          onOpenPriorityPicker={vi.fn()}
          onOpenProjectPicker={vi.fn()}
          onQuickDueDateSelect={vi.fn()}
          onResetArea={vi.fn()}
          onResetContexts={vi.fn()}
          onResetDueDate={vi.fn()}
          onResetDueTime={vi.fn()}
          onResetPriority={vi.fn()}
          onResetProject={vi.fn()}
          onToggleOptions={vi.fn()}
          onToggleAddAnother={vi.fn()}
          onToggleRecording={vi.fn()}
          onValueChange={vi.fn()}
          optionsExpanded={false}
          prioritiesEnabled
          priorityLabel="High"
          projectLabel="Project"
          recording={false}
          recordingBusy={false}
          recordingReady={false}
          sheetMaxHeight={500}
          showDueTime={false}
          t={t}
          tc={tc}
          value=""
          visible
        />
      );
    });

    expect(tree.root.findAllByProps({ accessibilityLabel: 'Contexts: @computer' }).length).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'More' }).length).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Due Date: Tomorrow' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Area: Work' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Project: Project' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Priority: High' })).toHaveLength(0);
    expect(tree.root.findAllByType(Text).some((node) => node.props.children === 'More')).toBe(true);
  });

  it('folds the quick-add syntax reference behind a toggle in the expanded panel (#1120)', () => {
    let tree!: ReturnType<typeof create>;
    const t = (key: string) => ({
      'common.close': 'Close',
      'common.more': 'More',
      'common.save': 'Save',
      'nav.addTask': 'Add Task',
      'quickAdd.help': 'Quick add supports /due:<when> and friends.',
      'quickAdd.syntaxHelp': 'Quick Add syntax help',
      'taskEdit.hideOptions': 'Hide options',
    })[key] ?? key;

    act(() => {
      tree = create(
        <QuickCaptureSheetBody
          addAnother={false}
          areaLabel="Work"
          contextLabel="@computer"
          dueDate={null}
          dueLabel="Due"
          dueTimeLabel="Change time"
          handleClose={vi.fn()}
          handleSave={vi.fn()}
          insetsBottom={0}
          inputRef={{ current: null }}
          noteValue=""
          onNoteChange={vi.fn()}
          onOpenAreaPicker={vi.fn()}
          onOpenContextPicker={vi.fn()}
          onOpenDueDatePicker={vi.fn()}
          onOpenDueTimePicker={vi.fn()}
          onOpenPriorityPicker={vi.fn()}
          onOpenProjectPicker={vi.fn()}
          onQuickDueDateSelect={vi.fn()}
          onResetArea={vi.fn()}
          onResetContexts={vi.fn()}
          onResetDueDate={vi.fn()}
          onResetDueTime={vi.fn()}
          onResetPriority={vi.fn()}
          onResetProject={vi.fn()}
          onToggleOptions={vi.fn()}
          onToggleAddAnother={vi.fn()}
          onToggleRecording={vi.fn()}
          onValueChange={vi.fn()}
          optionsExpanded
          prioritiesEnabled
          priorityLabel="High"
          projectLabel="Project"
          recording={false}
          recordingBusy={false}
          recordingReady={false}
          sheetMaxHeight={500}
          showDueTime={false}
          t={t}
          tc={tc}
          value=""
          visible
        />
      );
    });

    const helpText = 'Quick add supports /due:<when> and friends.';
    const hasHelpText = () => tree.root.findAllByType(Text)
      .some((node) => node.props.children === helpText);
    expect(hasHelpText()).toBe(false);
    const toggle = tree.root.findByProps({ testID: 'quick-capture-syntax-help-toggle' });
    expect(toggle.props.accessibilityState).toEqual({ expanded: false });
    act(() => {
      toggle.props.onPress();
    });
    expect(hasHelpText()).toBe(true);
  });

  it('shows a compact selected-project cue in collapsed capture', () => {
    let tree!: ReturnType<typeof create>;
    const longProjectName = 'Extremely Long Project Name That Should Not Crowd Quick Capture Controls';
    const t = (key: string) => ({
      'common.close': 'Close',
      'common.more': 'More',
      'common.save': 'Save',
      'nav.addTask': 'Add Task',
      'quickAdd.addAnother': 'Add another',
      'quickAdd.audioRecord': 'Record',
      'quickAdd.inputHint': 'Capture task title',
      'quickAdd.inputLabel': 'Task title',
      'taskEdit.contextsLabel': 'Contexts',
      'taskEdit.projectLabel': 'Project',
    })[key] ?? key;

    act(() => {
      tree = create(
        <QuickCaptureSheetBody
          addAnother={false}
          areaLabel="No Area"
          contextLabel="@computer"
          dueDate={null}
          dueLabel="Due Date"
          dueTimeLabel="Change time"
          handleClose={vi.fn()}
          handleSave={vi.fn()}
          insetsBottom={0}
          inputRef={{ current: null }}
          noteValue=""
          onNoteChange={vi.fn()}
          onOpenAreaPicker={vi.fn()}
          onOpenContextPicker={vi.fn()}
          onOpenDueDatePicker={vi.fn()}
          onOpenDueTimePicker={vi.fn()}
          onOpenPriorityPicker={vi.fn()}
          onOpenProjectPicker={vi.fn()}
          onQuickDueDateSelect={vi.fn()}
          onResetArea={vi.fn()}
          onResetContexts={vi.fn()}
          onResetDueDate={vi.fn()}
          onResetDueTime={vi.fn()}
          onResetPriority={vi.fn()}
          onResetProject={vi.fn()}
          onToggleOptions={vi.fn()}
          onToggleAddAnother={vi.fn()}
          onToggleRecording={vi.fn()}
          onValueChange={vi.fn()}
          optionsExpanded={false}
          prioritiesEnabled
          priorityLabel="Priority"
          projectLabel={longProjectName}
          projectSelected
          recording={false}
          recordingBusy={false}
          recordingReady={false}
          sheetMaxHeight={500}
          showDueTime={false}
          t={t}
          tc={tc}
          value=""
          visible
        />
      );
    });

    const projectChip = tree.root.findByProps({ accessibilityLabel: `Project: ${longProjectName}` });
    const projectText = tree.root.findAllByType(Text).find((node) => node.props.children === longProjectName);
    expect(projectChip).toBeTruthy();
    expect(projectText?.props.numberOfLines).toBe(1);
    expect(projectText?.props.ellipsizeMode).toBe('tail');
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Contexts: @computer' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'More' }).length).toBeGreaterThan(0);
  });

  it('bounds compact sheet text scaling so tablet controls cannot overlap', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <QuickCaptureSheetBody
          addAnother={false}
          areaLabel="No Area"
          contextLabel="Very Long Context Label"
          dueDate={null}
          dueLabel="Due Date"
          dueTimeLabel="Change time"
          handleClose={vi.fn()}
          handleSave={vi.fn()}
          insetsBottom={0}
          inputRef={{ current: null }}
          noteValue=""
          onNoteChange={vi.fn()}
          onOpenAreaPicker={vi.fn()}
          onOpenContextPicker={vi.fn()}
          onOpenDueDatePicker={vi.fn()}
          onOpenDueTimePicker={vi.fn()}
          onOpenPriorityPicker={vi.fn()}
          onOpenProjectPicker={vi.fn()}
          onQuickDueDateSelect={vi.fn()}
          onResetArea={vi.fn()}
          onResetContexts={vi.fn()}
          onResetDueDate={vi.fn()}
          onResetDueTime={vi.fn()}
          onResetPriority={vi.fn()}
          onResetProject={vi.fn()}
          onToggleOptions={vi.fn()}
          onToggleAddAnother={vi.fn()}
          onToggleRecording={vi.fn()}
          onValueChange={vi.fn()}
          optionsExpanded={false}
          prioritiesEnabled
          priorityLabel="Priority"
          projectLabel="Very Long Project Label"
          recording={false}
          recordingBusy={false}
          recordingReady={false}
          sheetMaxHeight={500}
          showDueTime={false}
          t={(key) => key}
          tc={tc}
          value=""
          visible
        />
      );
    });

    expect(tree.root.findByType(TextInput).props.maxFontSizeMultiplier).toBe(1.2);
    expect(tree.root.findByType(TextInput).props.textAlignVertical).toBe('center');
    const compactTexts = tree.root
      .findAllByType(Text)
      .filter((node) => typeof node.props.children === 'string');
    expect(compactTexts.length).toBeGreaterThan(0);
    expect(compactTexts.every((node) => node.props.maxFontSizeMultiplier === 1.2)).toBe(true);
    const moreText = compactTexts.find((node) => node.props.children === 'More');
    const saveText = compactTexts.find((node) => node.props.children === 'common.save');
    expect(moreText?.props.numberOfLines).toBe(1);
    expect(moreText?.props.adjustsFontSizeToFit).toBe(true);
    expect(saveText?.props.numberOfLines).toBe(1);
    expect(saveText?.props.adjustsFontSizeToFit).toBe(true);
  });

  it('submits the quick capture input from the keyboard Done action on iOS', () => {
    const handleSave = vi.fn();
    let tree!: ReturnType<typeof create>;
    const originalPlatformOs = Platform.OS;

    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: 'ios',
    });

    try {
      act(() => {
        tree = create(
          <QuickCaptureSheetBody
            addAnother={false}
            areaLabel="No Area"
            contextLabel="Contexts"
            dueDate={null}
            dueLabel="Due Date"
            dueTimeLabel="Change time"
            handleClose={vi.fn()}
            handleSave={handleSave}
            insetsBottom={0}
            inputRef={{ current: null }}
            noteValue=""
            onNoteChange={vi.fn()}
            onOpenAreaPicker={vi.fn()}
            onOpenContextPicker={vi.fn()}
            onOpenDueDatePicker={vi.fn()}
            onOpenDueTimePicker={vi.fn()}
            onOpenPriorityPicker={vi.fn()}
            onOpenProjectPicker={vi.fn()}
            onQuickDueDateSelect={vi.fn()}
            onResetArea={vi.fn()}
            onResetContexts={vi.fn()}
            onResetDueDate={vi.fn()}
            onResetDueTime={vi.fn()}
            onResetPriority={vi.fn()}
            onResetProject={vi.fn()}
            onToggleOptions={vi.fn()}
            onToggleAddAnother={vi.fn()}
            onToggleRecording={vi.fn()}
            onValueChange={vi.fn()}
            optionsExpanded={false}
            prioritiesEnabled
            priorityLabel="Priority"
            projectLabel="Project"
            recording={false}
            recordingBusy={false}
            recordingReady={false}
            sheetMaxHeight={500}
            showDueTime={false}
            t={(key) => key}
            tc={tc}
            value="Capture me"
            visible
          />
        );
      });

      const input = tree.root.findByType(TextInput);
      // Return blurs and submits (no newline inserted) when not adding another.
      expect(input.props.multiline).toBe(true);
      expect(input.props.submitBehavior).toBe('blurAndSubmit');

      act(() => {
        input.props.onSubmitEditing();
      });
    } finally {
      Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: originalPlatformOs,
      });
    }

    expect(handleSave).toHaveBeenCalledOnce();
  });

  it('keeps the input focused when keyboard submit saves and adds another', () => {
    const handleSave = vi.fn();
    const blur = vi.fn();
    const inputRef = { current: { blur } } as unknown as React.RefObject<TextInput | null>;
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <QuickCaptureSheetBody
          addAnother
          areaLabel="No Area"
          contextLabel="Contexts"
          dueDate={null}
          dueLabel="Due Date"
          dueTimeLabel="Change time"
          handleClose={vi.fn()}
          handleSave={handleSave}
          insetsBottom={0}
          inputRef={inputRef}
          noteValue=""
          onNoteChange={vi.fn()}
          onOpenAreaPicker={vi.fn()}
          onOpenContextPicker={vi.fn()}
          onOpenDueDatePicker={vi.fn()}
          onOpenDueTimePicker={vi.fn()}
          onOpenPriorityPicker={vi.fn()}
          onOpenProjectPicker={vi.fn()}
          onQuickDueDateSelect={vi.fn()}
          onResetArea={vi.fn()}
          onResetContexts={vi.fn()}
          onResetDueDate={vi.fn()}
          onResetDueTime={vi.fn()}
          onResetPriority={vi.fn()}
          onResetProject={vi.fn()}
          onToggleOptions={vi.fn()}
          onToggleAddAnother={vi.fn()}
          onToggleRecording={vi.fn()}
          onValueChange={vi.fn()}
          optionsExpanded={false}
          prioritiesEnabled
          priorityLabel="Priority"
          projectLabel="Project"
          recording={false}
          recordingBusy={false}
          recordingReady={false}
          sheetMaxHeight={500}
          showDueTime={false}
          t={(key) => key}
          tc={tc}
          value="Capture me"
          visible
        />
      );
    });

    const input = tree.root.findByType(TextInput);
    // Multiline title accepts pasted newlines, but return still submits and,
    // in add-another mode, keeps focus instead of inserting a newline.
    expect(input.props.multiline).toBe(true);
    expect(input.props.submitBehavior).toBe('submit');

    act(() => {
      input.props.onSubmitEditing();
    });

    expect(handleSave).toHaveBeenCalledOnce();
    expect(blur).not.toHaveBeenCalled();
  });

  it('uses translated field labels for project and due date accessibility', () => {
    const t = (key: string) => ({
      'taskEdit.projectLabel': 'Project',
      'taskEdit.dueDateLabel': 'Due date',
    }[key] ?? key);
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <QuickCaptureSheetBody
          addAnother={false}
          areaLabel="No Area"
          contextLabel="Contexts"
          dueDate={null}
          dueLabel="Tomorrow"
          dueTimeLabel="Change time"
          handleClose={vi.fn()}
          handleSave={vi.fn()}
          insetsBottom={0}
          inputRef={{ current: null }}
          noteValue=""
          onNoteChange={vi.fn()}
          onOpenAreaPicker={vi.fn()}
          onOpenContextPicker={vi.fn()}
          onOpenDueDatePicker={vi.fn()}
          onOpenDueTimePicker={vi.fn()}
          onOpenPriorityPicker={vi.fn()}
          onOpenProjectPicker={vi.fn()}
          onQuickDueDateSelect={vi.fn()}
          onResetArea={vi.fn()}
          onResetContexts={vi.fn()}
          onResetDueDate={vi.fn()}
          onResetDueTime={vi.fn()}
          onResetPriority={vi.fn()}
          onResetProject={vi.fn()}
          onToggleOptions={vi.fn()}
          onToggleAddAnother={vi.fn()}
          onToggleRecording={vi.fn()}
          onValueChange={vi.fn()}
          optionsExpanded
          prioritiesEnabled
          priorityLabel="Priority"
          projectLabel="Inbox"
          recording={false}
          recordingBusy={false}
          recordingReady={false}
          sheetMaxHeight={500}
          showDueTime={false}
          t={t}
          tc={tc}
          value=""
          visible
        />
      );
    });

    const labels = tree.root
      .findAll((node) => typeof node.props.accessibilityLabel === 'string')
      .map((node) => node.props.accessibilityLabel);

    expect(labels).toContain('Project: Inbox');
    expect(labels).toContain('Due date: Tomorrow');
    expect(labels).not.toContain('taskEdit.project: Inbox');
    expect(labels).not.toContain('taskEdit.dueDate: Tomorrow');
  });

  it('scrolls the expanded iOS sheet body so the title input stays reachable', () => {
    let tree!: ReturnType<typeof create>;
    const originalPlatformOs = Platform.OS;

    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });

    try {
      act(() => {
        tree = create(
          <QuickCaptureSheetBody
            addAnother={false}
            areaLabel="No Area"
            contextLabel="Contexts"
            dueDate={null}
            dueLabel="Due Date"
            dueTimeLabel="Change time"
            handleClose={vi.fn()}
            handleSave={vi.fn()}
            insetsBottom={0}
            inputRef={{ current: null }}
            noteValue=""
            onNoteChange={vi.fn()}
            onOpenAreaPicker={vi.fn()}
            onOpenContextPicker={vi.fn()}
            onOpenDueDatePicker={vi.fn()}
            onOpenDueTimePicker={vi.fn()}
            onOpenPriorityPicker={vi.fn()}
            onOpenProjectPicker={vi.fn()}
            onQuickDueDateSelect={vi.fn()}
            onResetArea={vi.fn()}
            onResetContexts={vi.fn()}
            onResetDueDate={vi.fn()}
            onResetDueTime={vi.fn()}
            onResetPriority={vi.fn()}
            onResetProject={vi.fn()}
            onToggleOptions={vi.fn()}
            onToggleAddAnother={vi.fn()}
            onToggleRecording={vi.fn()}
            onValueChange={vi.fn()}
            optionsExpanded
            prioritiesEnabled
            priorityLabel="Priority"
            projectLabel="Project"
            recording={false}
            recordingBusy={false}
            recordingReady={false}
            sheetMaxHeight={500}
            showDueTime={false}
            t={(key) => key}
            tc={tc}
            value="Capture me"
            visible
          />
        );
      });

      const scroll = tree.root.findByType(ScrollView);
      expect(scroll.props.testID).toBe('quick-capture-scroll');
      expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
      // The More panel scrolls, but the title input must stay OUTSIDE it: a focused
      // TextInput inside an iOS ScrollView gets auto-scrolled above the keyboard and
      // flies off the top of the sheet on every refocus (#887).
      expect(scroll.findAllByType(TextInput).map((node) => node.props.accessibilityLabel))
        .toEqual(['taskEdit.descriptionLabel']);
      expect(tree.root.findAllByType(TextInput)[0].props.accessibilityLabel).toBe('quickAdd.inputLabel');
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOs });
    }
  });

  it('scrolls the expanded Android sheet body and lets the sheet shrink for the keyboard', () => {
    let tree!: ReturnType<typeof create>;
    const originalPlatformOs = Platform.OS;

    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });

    try {
      act(() => {
        tree = create(
          <QuickCaptureSheetBody
            addAnother={false}
            areaLabel="No Area"
            contextLabel="Contexts"
            dueDate={null}
            dueLabel="Due Date"
            dueTimeLabel="Change time"
            handleClose={vi.fn()}
            handleSave={vi.fn()}
            insetsBottom={0}
            inputRef={{ current: null }}
            noteValue=""
            onNoteChange={vi.fn()}
            onOpenAreaPicker={vi.fn()}
            onOpenContextPicker={vi.fn()}
            onOpenDueDatePicker={vi.fn()}
            onOpenDueTimePicker={vi.fn()}
            onOpenPriorityPicker={vi.fn()}
            onOpenProjectPicker={vi.fn()}
            onQuickDueDateSelect={vi.fn()}
            onResetArea={vi.fn()}
            onResetContexts={vi.fn()}
            onResetDueDate={vi.fn()}
            onResetDueTime={vi.fn()}
            onResetPriority={vi.fn()}
            onResetProject={vi.fn()}
            onToggleOptions={vi.fn()}
            onToggleAddAnother={vi.fn()}
            onToggleRecording={vi.fn()}
            onValueChange={vi.fn()}
            optionsExpanded
            prioritiesEnabled
            priorityLabel="Priority"
            projectLabel="Project"
            recording={false}
            recordingBusy={false}
            recordingReady={false}
            sheetMaxHeight={500}
            showDueTime={false}
            t={(key) => key}
            tc={tc}
            value="Capture me"
            visible
          />
        );
      });

      // Tapping More hides the Android keyboard, but it comes back the moment the user
      // taps the title to keep typing. The measured lift then shrinks the space left for
      // a sheet whose expanded content is taller than the screen, so the More panel has
      // to scroll inside the sheet instead of pushing the title off the top (#1120).
      const scroll = tree.root.findByType(ScrollView);
      expect(scroll.props.testID).toBe('quick-capture-scroll');
      expect(scroll.findAllByType(TextInput).map((node) => node.props.accessibilityLabel))
        .toEqual(['taskEdit.descriptionLabel']);
      const sheet = tree.root
        .findAllByType(View)
        .find((node) => flattenStyle(node.props.style).maxHeight === 500);
      // Without this the bottom-anchored sheet keeps its full height and overflows the
      // top of the keyboard-padded container.
      expect(flattenStyle(sheet?.props.style).flexShrink).toBe(1);
      // The title input stays outside the scroll area, in the pinned part of the sheet.
      expect(tree.root.findAllByType(TextInput)[0].props.accessibilityLabel).toBe('quickAdd.inputLabel');
      // Without a viewport inside the native modal, toasts fired from the sheet (the
      // speech-not-configured notice) only appear after the sheet closes (#886). It has
      // to live inside the keyboard-avoiding view or the keyboard covers it.
      expect(tree.root.findByType(KeyboardAvoidingView).findAllByType(ToastViewport)).toHaveLength(1);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOs });
    }
  });
  it('keeps the note field behind More instead of crowding collapsed capture', () => {
    const renderBody = (optionsExpanded: boolean) => {
      let tree!: ReturnType<typeof create>;
      act(() => {
        tree = create(
          <QuickCaptureSheetBody
            addAnother={false}
            areaLabel="No Area"
            contextLabel="Contexts"
            dueDate={null}
            dueLabel="Due Date"
            dueTimeLabel="Change time"
            handleClose={vi.fn()}
            handleSave={vi.fn()}
            insetsBottom={0}
            inputRef={{ current: null }}
            noteValue="Bring the signed form"
            onNoteChange={vi.fn()}
            onOpenAreaPicker={vi.fn()}
            onOpenContextPicker={vi.fn()}
            onOpenDueDatePicker={vi.fn()}
            onOpenDueTimePicker={vi.fn()}
            onOpenPriorityPicker={vi.fn()}
            onOpenProjectPicker={vi.fn()}
            onQuickDueDateSelect={vi.fn()}
            onResetArea={vi.fn()}
            onResetContexts={vi.fn()}
            onResetDueDate={vi.fn()}
            onResetDueTime={vi.fn()}
            onResetPriority={vi.fn()}
            onResetProject={vi.fn()}
            onToggleOptions={vi.fn()}
            onToggleAddAnother={vi.fn()}
            onToggleRecording={vi.fn()}
            onValueChange={vi.fn()}
            optionsExpanded={optionsExpanded}
            prioritiesEnabled
            priorityLabel="Priority"
            projectLabel="Project"
            recording={false}
            recordingBusy={false}
            recordingReady={false}
            sheetMaxHeight={500}
            showDueTime={false}
            t={(key) => key}
            tc={tc}
            value="Capture me"
            visible
          />
        );
      });
      return tree;
    };

    const findNote = (tree: ReturnType<typeof create>) => tree.root
      .findAllByType(TextInput)
      .filter((node) => node.props.accessibilityLabel === 'taskEdit.descriptionLabel');

    // Collapsed capture stays a one-field sheet: the note is progressive
    // disclosure behind More (#1118).
    expect(findNote(renderBody(false))).toHaveLength(0);

    const expanded = findNote(renderBody(true));
    expect(expanded).toHaveLength(1);
    expect(expanded[0].props.value).toBe('Bring the signed form');
    expect(expanded[0].props.multiline).toBe(true);
  });
});

import React from 'react';
import { FlatList, Modal, Platform, Text, TextInput } from 'react-native';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { QuickCaptureSheetBody } from './QuickCaptureSheetBody';
import { QuickCaptureSheetPickers } from './QuickCaptureSheetPickers';

vi.mock('@react-native-community/datetimepicker', () => ({
  default: (props: Record<string, unknown>) => React.createElement('DateTimePicker', props),
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

describe('Quick capture modal composition', () => {
  it('does not mount picker modals while every picker is closed', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <QuickCaptureSheetPickers
          areas={[]}
          contextInputRef={{ current: null }}
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

  it('only mounts the requested picker modal', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <QuickCaptureSheetPickers
          areas={[]}
          contextInputRef={{ current: null }}
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
          showPriorityPicker={false}
          showProjectPicker={false}
          startPickerMode={null}
          startTime={null}
          t={(key) => key}
          tc={tc}
        />
      );
    });

    const modals = tree.root.findAllByType(Modal);
    expect(modals).toHaveLength(1);
    expect(modals[0]?.props.visible).toBe(true);
    expect(modals[0]?.props.accessibilityViewIsModal).toBe(true);
    expect(tree.root.findByType(FlatList).props.accessibilityRole).toBe('list');
    expect(tree.root.findByProps({ accessibilityRole: 'header' }).props.children).toBe('taskEdit.contextsLabel');
  });

  it('disables Android modal animation to avoid ghosted sheet trails', () => {
    let tree!: ReturnType<typeof create>;
    const originalPlatformOs = Platform.OS;

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
            dueLabel="Due Date"
            handleClose={vi.fn()}
            handleSave={vi.fn()}
            insetsBottom={0}
            inputRef={{ current: null }}
            onOpenAreaPicker={vi.fn()}
            onOpenContextPicker={vi.fn()}
            onOpenDueDatePicker={vi.fn()}
            onOpenPriorityPicker={vi.fn()}
            onOpenProjectPicker={vi.fn()}
            onResetArea={vi.fn()}
            onResetContexts={vi.fn()}
            onResetDueDate={vi.fn()}
            onResetPriority={vi.fn()}
            onResetProject={vi.fn()}
            onToggleAddAnother={vi.fn()}
            onToggleRecording={vi.fn()}
            onValueChange={vi.fn()}
            prioritiesEnabled
            priorityLabel="Priority"
            projectLabel="Project"
            recording={false}
            recordingBusy={false}
            recordingReady={false}
            sheetMaxHeight={500}
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
    expect(modal.props.statusBarTranslucent).toBe(true);
  });

  it('bounds compact sheet text scaling so tablet controls cannot overlap', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <QuickCaptureSheetBody
          addAnother={false}
          areaLabel="No Area"
          contextLabel="Very Long Context Label"
          dueLabel="Due Date"
          handleClose={vi.fn()}
          handleSave={vi.fn()}
          insetsBottom={0}
          inputRef={{ current: null }}
          onOpenAreaPicker={vi.fn()}
          onOpenContextPicker={vi.fn()}
          onOpenDueDatePicker={vi.fn()}
          onOpenPriorityPicker={vi.fn()}
          onOpenProjectPicker={vi.fn()}
          onResetArea={vi.fn()}
          onResetContexts={vi.fn()}
          onResetDueDate={vi.fn()}
          onResetPriority={vi.fn()}
          onResetProject={vi.fn()}
          onToggleAddAnother={vi.fn()}
          onToggleRecording={vi.fn()}
          onValueChange={vi.fn()}
          prioritiesEnabled
          priorityLabel="Priority"
          projectLabel="Very Long Project Label"
          recording={false}
          recordingBusy={false}
          recordingReady={false}
          sheetMaxHeight={500}
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
            dueLabel="Due Date"
            handleClose={vi.fn()}
            handleSave={handleSave}
            insetsBottom={0}
            inputRef={{ current: null }}
            onOpenAreaPicker={vi.fn()}
            onOpenContextPicker={vi.fn()}
            onOpenDueDatePicker={vi.fn()}
            onOpenPriorityPicker={vi.fn()}
            onOpenProjectPicker={vi.fn()}
            onResetArea={vi.fn()}
            onResetContexts={vi.fn()}
            onResetDueDate={vi.fn()}
            onResetPriority={vi.fn()}
            onResetProject={vi.fn()}
            onToggleAddAnother={vi.fn()}
            onToggleRecording={vi.fn()}
            onValueChange={vi.fn()}
            prioritiesEnabled
            priorityLabel="Priority"
            projectLabel="Project"
            recording={false}
            recordingBusy={false}
            recordingReady={false}
            sheetMaxHeight={500}
            t={(key) => key}
            tc={tc}
            value="Capture me"
            visible
          />
        );
      });

      act(() => {
        tree.root.findByType(TextInput).props.onSubmitEditing();
      });
    } finally {
      Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: originalPlatformOs,
      });
    }

    expect(handleSave).toHaveBeenCalledOnce();
  });
});

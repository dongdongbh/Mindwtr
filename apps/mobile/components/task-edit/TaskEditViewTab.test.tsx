import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskEditViewTab } from './TaskEditViewTab';
import { styles as taskEditStyles } from './task-edit-modal.styles';

function MockTaskStatusBadge(props: any) {
  return React.createElement('TaskStatusBadge', props);
}

vi.mock('../task-status-badge', () => ({
  TaskStatusBadge: MockTaskStatusBadge,
}));

vi.mock('../markdown-text', () => ({
  MarkdownInlineText: (props: any) => React.createElement('MarkdownInlineText', props),
  MarkdownText: (props: any) => React.createElement('MarkdownText', props),
}));

vi.mock('../AttachmentProgressIndicator', () => ({
  AttachmentProgressIndicator: (props: any) => React.createElement('AttachmentProgressIndicator', props),
}));

const flattenStyle = (value: any): Record<string, unknown> => (
  Array.isArray(value)
    ? Object.assign({}, ...value.map(flattenStyle))
    : value
);

describe('TaskEditViewTab', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets preview metadata values wrap across the full row width', () => {
    expect(flattenStyle(taskEditStyles.viewRow)).toMatchObject({
      alignItems: 'flex-start',
    });
    expect(flattenStyle(taskEditStyles.viewLabel)).not.toHaveProperty('flex');
    expect(flattenStyle(taskEditStyles.viewValue)).toMatchObject({
      textAlign: 'left',
      width: '100%',
    });
  });

  it('shows the full task title as a wrapping field at the top of the read-only preview', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <TaskEditViewTab
          t={(key) => ({ 'taskEdit.titleLabel': 'Title' }[key] ?? key)}
          tc={{
            text: '#fff',
            secondaryText: '#aaa',
            inputBg: '#111',
            border: '#222',
            cardBg: '#000',
            tint: '#3b82f6',
          } as any}
          styles={taskEditStyles as any}
          mergedTask={{
            id: 'task-1',
            title: 'A very long task title that would otherwise be truncated in the header',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: '2026-04-01T00:00:00.000Z',
            updatedAt: '2026-04-01T00:00:00.000Z',
          }}
          projects={[]}
          sections={[]}
          areas={[]}
          prioritiesEnabled={false}
          timeEstimatesEnabled={false}
          formatTimeEstimateLabel={(value) => String(value)}
          formatDate={(value) => value}
          formatDueDate={(value) => value}
          getRecurrenceRuleValue={() => ''}
          getRecurrenceStrategyValue={() => 'strict'}
          applyChecklistUpdate={vi.fn()}
          visibleAttachments={[]}
          openAttachment={vi.fn()}
          isImageAttachment={() => false}
          textDirectionStyle={{}}
          resolvedDirection="ltr"
          showStatusField={false}
        />
      );
    });

    const titleNode = tree.root.findByProps({
      children: 'A very long task title that would otherwise be truncated in the header',
    });
    expect(titleNode.props.numberOfLines).toBeUndefined();
  });

  it('renders an interactive status badge and forwards updates', () => {
    const onBackdatedComplete = vi.fn();
    const onStatusUpdate = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <TaskEditViewTab
          t={(key) =>
            ({
              'taskEdit.statusLabel': 'Status',
              'status.next': 'Next',
              'status.done': 'Done',
            }[key] ?? key)
          }
          tc={{
            text: '#fff',
            secondaryText: '#aaa',
            inputBg: '#111',
            border: '#222',
            cardBg: '#000',
            tint: '#3b82f6',
          } as any}
          styles={{
            content: {},
            contentContainer: {},
            viewRow: {},
            viewLabel: {},
            viewValue: {},
            viewSection: {},
            viewPillRow: {},
            viewPill: {},
            viewPillText: {},
            viewCard: {},
            viewChecklist: {},
            viewChecklistItem: {},
            viewChecklistText: {},
            viewAttachmentGrid: {},
            viewAttachmentCard: {},
            viewAttachmentText: {},
            viewAttachmentSubtext: {},
            viewAttachmentImage: {},
          }}
          mergedTask={{
            id: 'task-1',
            title: 'Preview task',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: '2026-04-01T00:00:00.000Z',
            updatedAt: '2026-04-01T00:00:00.000Z',
          }}
          projects={[]}
          sections={[]}
          areas={[]}
          prioritiesEnabled={false}
          timeEstimatesEnabled={false}
          formatTimeEstimateLabel={(value) => String(value)}
          formatDate={(value) => value}
          formatDueDate={(value) => value}
          getRecurrenceRuleValue={() => ''}
          getRecurrenceStrategyValue={() => 'strict'}
          applyChecklistUpdate={vi.fn()}
          visibleAttachments={[]}
          openAttachment={vi.fn()}
          isImageAttachment={() => false}
          textDirectionStyle={{}}
          resolvedDirection="ltr"
          onBackdatedComplete={onBackdatedComplete}
          onStatusUpdate={onStatusUpdate}
        />
      );
    });

    const badge = tree.root.findByType(MockTaskStatusBadge);
    expect(badge.props.status).toBe('next');

    renderer.act(() => {
      badge.props.onUpdate('done');
    });

    expect(onStatusUpdate).toHaveBeenCalledWith('done');

    renderer.act(() => {
      badge.props.onBackdatedComplete();
    });

    expect(onBackdatedComplete).toHaveBeenCalledTimes(1);
  });

  it('shows the projected recurrence date in the read-only preview', () => {
    // The projected date is computed from "now"; freeze it so the
    // hardcoded 2026-07-09 expectation stays valid after that date passes.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 3, 12, 0, 0));
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <TaskEditViewTab
          t={(key) =>
            ({
              'taskEdit.recurrenceLabel': 'Recurrence',
              'status.next': 'Next',
              'recurrence.monthly': 'Monthly',
              'recurrence.nextCalendarPreview': 'Next calendar preview',
            }[key] ?? key)
          }
          tc={{
            text: '#fff',
            secondaryText: '#aaa',
            inputBg: '#111',
            border: '#222',
            cardBg: '#000',
            tint: '#3b82f6',
          } as any}
          styles={{
            content: {},
            contentContainer: {},
            viewRow: {},
            viewLabel: {},
            viewValue: {},
            viewSection: {},
            viewPillRow: {},
            viewPill: {},
            viewPillText: {},
            viewCard: {},
            viewChecklist: {},
            viewChecklistItem: {},
            viewChecklistText: {},
            viewAttachmentGrid: {},
            viewAttachmentCard: {},
            viewAttachmentText: {},
            viewAttachmentSubtext: {},
            viewAttachmentImage: {},
          }}
          mergedTask={{
            id: 'task-1',
            title: 'Preview task',
            status: 'next',
            tags: [],
            contexts: [],
            dueDate: '2026-06-09',
            recurrence: {
              rule: 'monthly',
              strategy: 'strict',
              byMonthDay: [9],
              rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
            },
            showFutureRecurrence: true,
            createdAt: '2026-04-01T00:00:00.000Z',
            updatedAt: '2026-04-01T00:00:00.000Z',
          }}
          projects={[]}
          sections={[]}
          areas={[]}
          prioritiesEnabled={false}
          timeEstimatesEnabled={false}
          formatTimeEstimateLabel={(value) => String(value)}
          formatDate={(value) => `formatted ${value}`}
          formatDueDate={(value) => value}
          getRecurrenceRuleValue={() => 'monthly'}
          getRecurrenceStrategyValue={() => 'strict'}
          applyChecklistUpdate={vi.fn()}
          visibleAttachments={[]}
          openAttachment={vi.fn()}
          isImageAttachment={() => false}
          textDirectionStyle={{}}
          resolvedDirection="ltr"
        />
      );
    });

    expect(tree.root.findByProps({ children: 'Monthly · Next calendar preview: formatted 2026-07-09' })).toBeTruthy();
  });

  it('shows the upcoming occurrence for an unscheduled recurring task without the calendar toggle', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 3, 12, 0, 0));
    let tree!: renderer.ReactTestRenderer;
    try {
      renderer.act(() => {
        tree = renderer.create(
          <TaskEditViewTab
            t={(key) =>
              ({
                'taskEdit.recurrenceLabel': 'Recurrence',
                'status.next': 'Next',
                'recurrence.monthly': 'Monthly',
                'recurrence.nextCalendarPreview': 'Next calendar preview',
              }[key] ?? key)
            }
            tc={{
              text: '#fff',
              secondaryText: '#aaa',
              inputBg: '#111',
              border: '#222',
              cardBg: '#000',
              tint: '#3b82f6',
            } as any}
            styles={{
              content: {},
              contentContainer: {},
              viewRow: {},
              viewLabel: {},
              viewValue: {},
              viewSection: {},
              viewPillRow: {},
              viewPill: {},
              viewPillText: {},
              viewCard: {},
              viewChecklist: {},
              viewChecklistItem: {},
              viewChecklistText: {},
              viewAttachmentGrid: {},
              viewAttachmentCard: {},
              viewAttachmentText: {},
              viewAttachmentSubtext: {},
              viewAttachmentImage: {},
            }}
            mergedTask={{
              id: 'task-1',
              title: 'Preview task',
              status: 'next',
              tags: [],
              contexts: [],
              recurrence: {
                rule: 'monthly',
                strategy: 'strict',
                byMonthDay: [9],
                rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
              },
              createdAt: '2026-04-01T00:00:00.000Z',
              updatedAt: '2026-04-01T00:00:00.000Z',
            }}
            projects={[]}
            sections={[]}
            areas={[]}
            prioritiesEnabled={false}
            timeEstimatesEnabled={false}
            formatTimeEstimateLabel={(value) => String(value)}
            formatDate={(value) => `formatted ${value}`}
            formatDueDate={(value) => value}
            getRecurrenceRuleValue={() => 'monthly'}
            getRecurrenceStrategyValue={() => 'strict'}
            applyChecklistUpdate={vi.fn()}
            visibleAttachments={[]}
            openAttachment={vi.fn()}
            isImageAttachment={() => false}
            textDirectionStyle={{}}
            resolvedDirection="ltr"
          />
        );
      });

      expect(tree.root.findByProps({ children: 'Monthly · Next calendar preview: formatted 2026-07-09' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  // #1055: the read-only preview can grow the checklist it already renders.
  it('adds checklist items from the preview without opening the form tab', () => {
    const applyChecklistUpdate = vi.fn();
    const renderPreview = (checklist: any[], onApply = applyChecklistUpdate, readOnly = false) => {
      let tree!: renderer.ReactTestRenderer;
      renderer.act(() => {
        tree = renderer.create(
          <TaskEditViewTab
            t={(key) => ({ 'taskEdit.addItem': 'Add Item', 'taskEdit.checklist': 'Checklist' }[key] ?? key)}
            tc={{
              text: '#fff',
              secondaryText: '#aaa',
              inputBg: '#111',
              border: '#222',
              cardBg: '#000',
              tint: '#3b82f6',
            } as any}
            styles={taskEditStyles as any}
            mergedTask={{
              id: 'task-1',
              title: 'Groceries',
              status: 'next',
              tags: [],
              contexts: [],
              checklist,
              createdAt: '2026-04-01T00:00:00.000Z',
              updatedAt: '2026-04-01T00:00:00.000Z',
            }}
            projects={[]}
            sections={[]}
            areas={[]}
            prioritiesEnabled={false}
            timeEstimatesEnabled={false}
            formatTimeEstimateLabel={(value) => String(value)}
            formatDate={(value) => value}
            formatDueDate={(value) => value}
            getRecurrenceRuleValue={() => ''}
            getRecurrenceStrategyValue={() => 'strict'}
            applyChecklistUpdate={onApply}
            readOnly={readOnly}
            visibleAttachments={[]}
            openAttachment={vi.fn()}
            isImageAttachment={() => false}
            textDirectionStyle={{}}
            resolvedDirection="ltr"
            showStatusField={false}
          />
        );
      });
      return tree;
    };
    const findAddInputs = (tree: renderer.ReactTestRenderer) => tree.root.findAll((node) => (
      typeof node.type === 'string'
      && node.props.accessibilityLabel === 'Add Item'
      && typeof node.props.onSubmitEditing === 'function'
    ));

    // A task with no checklist must not grow a new field.
    expect(findAddInputs(renderPreview([]))).toHaveLength(0);

    const tree = renderPreview([{ id: 'item-1', title: 'Bread', isCompleted: false }]);
    expect(findAddInputs(tree)).toHaveLength(1);

    renderer.act(() => {
      findAddInputs(tree)[0].props.onChangeText('  Milk  ');
    });
    renderer.act(() => {
      findAddInputs(tree)[0].props.onSubmitEditing();
    });

    expect(applyChecklistUpdate).toHaveBeenCalledTimes(1);
    expect(applyChecklistUpdate).toHaveBeenCalledWith([
      { id: 'item-1', title: 'Bread', isCompleted: false },
      expect.objectContaining({ title: 'Milk', isCompleted: false }),
    ]);
    expect(findAddInputs(tree)[0].props.value).toBe('');
    expect(findAddInputs(tree)[0].props.blurOnSubmit).toBe(false);

    // Empty submit is a no-op, not an empty item.
    renderer.act(() => {
      findAddInputs(tree)[0].props.onSubmitEditing();
    });
    expect(applyChecklistUpdate).toHaveBeenCalledTimes(1);

    const readOnlyApply = vi.fn();
    const readOnlyTree = renderPreview(
      [{ id: 'item-1', title: 'Bread', isCompleted: false }],
      readOnlyApply,
      true,
    );
    expect(findAddInputs(readOnlyTree)).toHaveLength(0);
    expect(readOnlyTree.root.findAll((node) => node.props.accessibilityRole === 'checkbox')).toHaveLength(0);
    expect(readOnlyApply).not.toHaveBeenCalled();
  });

  it('hides the status row when the task editor layout hides status', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <TaskEditViewTab
          t={(key) =>
            ({
              'taskEdit.statusLabel': 'Status',
              'status.next': 'Next',
            }[key] ?? key)
          }
          tc={{
            text: '#fff',
            secondaryText: '#aaa',
            inputBg: '#111',
            border: '#222',
            cardBg: '#000',
            tint: '#3b82f6',
          } as any}
          styles={{
            content: {},
            contentContainer: {},
            viewRow: {},
            viewLabel: {},
            viewValue: {},
            viewSection: {},
            viewPillRow: {},
            viewPill: {},
            viewPillText: {},
            viewCard: {},
            viewChecklist: {},
            viewChecklistItem: {},
            viewChecklistText: {},
            viewAttachmentGrid: {},
            viewAttachmentCard: {},
            viewAttachmentText: {},
            viewAttachmentSubtext: {},
            viewAttachmentImage: {},
          }}
          mergedTask={{
            id: 'task-1',
            title: 'Preview task',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: '2026-04-01T00:00:00.000Z',
            updatedAt: '2026-04-01T00:00:00.000Z',
          }}
          projects={[]}
          sections={[]}
          areas={[]}
          prioritiesEnabled={false}
          timeEstimatesEnabled={false}
          formatTimeEstimateLabel={(value) => String(value)}
          formatDate={(value) => value}
          formatDueDate={(value) => value}
          getRecurrenceRuleValue={() => ''}
          getRecurrenceStrategyValue={() => 'strict'}
          applyChecklistUpdate={vi.fn()}
          visibleAttachments={[]}
          openAttachment={vi.fn()}
          isImageAttachment={() => false}
          textDirectionStyle={{}}
          resolvedDirection="ltr"
          onStatusUpdate={vi.fn()}
          showStatusField={false}
        />
      );
    });

    expect(tree.root.findAllByType(MockTaskStatusBadge)).toHaveLength(0);
  });
});

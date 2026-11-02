import React from 'react';
import renderer from 'react-test-renderer';
import { Alert, Modal, Platform, Text } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectRow } from './ProjectRow';
import { projectsScreenStyles } from './projects-screen.styles';

const hapticsMocks = vi.hoisted(() => ({
  selectionAsync: vi.fn().mockResolvedValue(undefined),
  notificationAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('expo-haptics', () => ({
  NotificationFeedbackType: {
    Warning: 'warning',
  },
  selectionAsync: hapticsMocks.selectionAsync,
  notificationAsync: hapticsMocks.notificationAsync,
}));

vi.mock('lucide-react-native', () => ({
  AlertTriangle: (props: any) => React.createElement('AlertTriangle', props),
  Copy: (props: any) => React.createElement('Copy', props),
  MoreHorizontal: (props: any) => React.createElement('MoreHorizontal', props),
  Star: (props: any) => React.createElement('Star', props),
  Trash2: (props: any) => React.createElement('Trash2', props),
}));

vi.mock('react-native-gesture-handler', () => ({
  Swipeable: React.forwardRef(function SwipeableMock({ children, renderLeftActions, renderRightActions, ...props }: any, ref: any) {
    React.useImperativeHandle(ref, () => ({ close: () => undefined }));
    return React.createElement(
      'Swipeable',
      props,
      renderLeftActions ? renderLeftActions() : null,
      children,
      renderRightActions ? renderRightActions() : null,
    );
  }),
}));

const project = {
  id: 'project-1',
  title: 'Redesign Client Website',
  status: 'active',
  isFocused: false,
  createdAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-01T00:00:00.000Z',
} as any;

const tc = {
  cardBg: '#111827',
  secondaryText: '#94a3b8',
  text: '#f8fafc',
  tint: '#3b82f6',
};

const statusPalette = {
  active: { text: '#ffffff', bg: '#111111', border: '#222222' },
  waiting: { text: '#ffffff', bg: '#111111', border: '#222222' },
  someday: { text: '#ffffff', bg: '#111111', border: '#222222' },
  archived: { text: '#ffffff', bg: '#111111', border: '#222222' },
};

const flattenStyle = (value: unknown): Record<string, unknown> => Object.assign(
  {},
  ...(Array.isArray(value) ? value : [value]).filter(Boolean),
);

describe('ProjectRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { summary: undefined, warning: true },
    { summary: { activeTaskCount: 1, hasWaitingAction: true }, warning: false },
  ])('uses tracked waiting work for its focused warning (#1307): $warning', ({ summary, warning }) => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <ProjectRow project={{ ...project, isFocused: true }} taskSummary={summary} tc={tc} focusedCount={1}
          statusPalette={statusPalette as any} t={(key) => key}
          onDeleteProject={vi.fn()} onDuplicateProject={vi.fn()}
          onOpenProject={vi.fn()} onToggleProjectFocus={vi.fn()} />,
      );
    });
    expect(tree.root.findAllByType(Text).some((node) => node.props.children === 'projects.noNextAction')).toBe(warning);
    renderer.act(() => tree.unmount());
  });

  it('offers only the available moves on long-press and as accessibility actions (#1263)', () => {
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const onMoveDown = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <ProjectRow project={project} tc={tc} focusedCount={0}
          statusPalette={statusPalette as any} t={(key) => key}
          onDeleteProject={vi.fn()} onDuplicateProject={vi.fn()}
          onOpenProject={vi.fn()} onToggleProjectFocus={vi.fn()} onMoveDown={onMoveDown} />,
      );
    });
    const open = tree.root.findByProps({ testID: 'project-row-open-project-1' });
    expect(open.props.accessibilityActions).toEqual([{ name: 'moveDown', label: 'projects.moveDown' }]);

    renderer.act(() => open.props.onLongPress());
    const buttons = alertSpy.mock.calls[0]?.[2] as { text: string; onPress?: () => void }[];
    expect(buttons.map((button) => button.text)).toEqual(['projects.moveDown', 'common.cancel']);
    buttons[0].onPress?.();
    renderer.act(() => open.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveDown' } }));
    expect(onMoveDown).toHaveBeenCalledTimes(2);
    renderer.act(() => tree.unmount());
  });

  it.each(['android', 'ios'])('opens a visible project menu without opening detail on %s', (os) => {
    const previous = Platform.OS;
    Platform.OS = os as typeof Platform.OS;
    const menuProject = { ...project, title: 'A long imported project title '.repeat(120) };
    const onOpenProject = vi.fn();
    const onMoveToArea = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(
      <ProjectRow project={menuProject} tc={tc} focusedCount={0} statusPalette={statusPalette as any}
        t={(key) => key} onDeleteProject={vi.fn()} onDuplicateProject={vi.fn()}
        onOpenProject={onOpenProject} onToggleProjectFocus={vi.fn()} onMoveToArea={onMoveToArea}
        onMoveUp={vi.fn()} onMoveDown={vi.fn()} />,
    ); });
    renderer.act(() => tree.root.findByProps({ testID: 'project-row-menu-project-1' }).props.onPress());
    expect(tree.root.findByType(Modal).props.visible).toBe(true);
    expect(tree.root.findByProps({ testID: 'project-menu-title-project-1' }).props).toEqual(expect.objectContaining({ numberOfLines: 2, accessibilityLabel: menuProject.title }));
    renderer.act(() => tree.root.findByProps({ accessibilityLabel: 'projects.areaLabel' }).props.onPress());
    expect(onOpenProject).not.toHaveBeenCalled();
    expect(tree.root.findByType(Modal).props.visible).toBe(false);
    if (os === 'ios') {
      expect(onMoveToArea).not.toHaveBeenCalled();
      renderer.act(() => tree.root.findByType(Modal).props.onDismiss());
    }
    expect(onMoveToArea).toHaveBeenCalledTimes(1);
    renderer.act(() => tree.unmount());
    Platform.OS = previous;
  });

  it('has no long-press menu when the project cannot move', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <ProjectRow project={project} tc={tc} focusedCount={0}
          statusPalette={statusPalette as any} t={(key) => key}
          onDeleteProject={vi.fn()} onDuplicateProject={vi.fn()}
          onOpenProject={vi.fn()} onToggleProjectFocus={vi.fn()} />,
      );
    });
    expect(tree.root.findByProps({ testID: 'project-row-open-project-1' }).props.onLongPress).toBeUndefined();
    renderer.act(() => tree.unmount());
  });

  it('shows a clean project title without tag dots while retaining its tags', () => {
    const taggedProject = Object.freeze({ ...project, tagIds: Object.freeze(['admin', 'family']) });
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <ProjectRow project={taggedProject} tc={tc} focusedCount={0}
          statusPalette={statusPalette as any} t={(key) => key}
          onDeleteProject={vi.fn()} onDuplicateProject={vi.fn()}
          onOpenProject={vi.fn()} onToggleProjectFocus={vi.fn()} />,
      );
    });
    const titleContent = tree.root.find((node) => String(node.type) === 'View'
      && node.props.style === projectsScreenStyles.projectTitleContent);
    expect(titleContent.children).toHaveLength(1);
    expect(titleContent.findByType(Text).props.children).toBe(project.title);
    expect(taggedProject.tagIds).toEqual(['admin', 'family']);
  });

  it('requires a deliberate horizontal drag before opening project swipe actions', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <ProjectRow
          project={project}
          tc={tc}
          focusedCount={0}
          statusPalette={statusPalette as any}
          t={(key) => key}
          onDeleteProject={vi.fn()}
          onDuplicateProject={vi.fn()}
          onOpenProject={vi.fn()}
          onToggleProjectFocus={vi.fn()}
        />,
      );
    });

    const swipeable = tree.root.find((node) => (node.type as unknown) === 'Swipeable');
    expect(swipeable.props.friction).toBe(1.25);
    expect(swipeable.props.leftThreshold).toBe(72);
    expect(swipeable.props.rightThreshold).toBe(72);
    expect(swipeable.props.dragOffsetFromLeftEdge).toBe(28);
    expect(swipeable.props.dragOffsetFromRightEdge).toBe(28);
    expect(swipeable.props.overshootLeft).toBe(false);
    expect(swipeable.props.overshootRight).toBe(false);
  });

  it('keeps the focus action in a 44dp trailing target and triggers selection haptics', () => {
    const onToggleProjectFocus = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <ProjectRow
          project={project}
          tc={tc}
          focusedCount={0}
          statusPalette={statusPalette as any}
          t={(key) => key}
          onDeleteProject={vi.fn()}
          onDuplicateProject={vi.fn()}
          onOpenProject={vi.fn()}
          onToggleProjectFocus={onToggleProjectFocus}
        />,
      );
    });

    const focusButton = tree.root.find((node) => node.props.testID === 'project-row-focus-project-1');
    const trailing = tree.root.find((node) => node.props.testID === 'project-row-trailing-project-1');
    const star = tree.root.find((node) => (node.type as unknown) === 'Star');

    expect(focusButton.props.hitSlop).toEqual({ top: 12, bottom: 12, left: 12, right: 12 });
    expect(flattenStyle(focusButton.props.style)).toEqual(expect.objectContaining({ width: 44, height: 44 }));
    expect(trailing.findAll((node) => node.props.testID === 'project-row-focus-project-1').length).toBeGreaterThanOrEqual(1);
    expect(star.props.size).toBe(18);

    renderer.act(() => {
      focusButton.props.onPress();
    });

    expect(hapticsMocks.selectionAsync).toHaveBeenCalledTimes(1);
    expect(onToggleProjectFocus).toHaveBeenCalledWith('project-1');
  });

  // The star is icon-only, so its label is the whole affordance for a screen
  // reader — and it must speak the reader's language.
  it('names the focus action through the translator', () => {
    const translate = (key: string) => ({
      'projects.addToFocus': 'Zum Fokus hinzufügen',
      'projects.removeFromFocus': 'Aus dem Fokus entfernen',
    }[key] ?? key);
    const renderRow = (isFocused: boolean) => {
      let tree!: renderer.ReactTestRenderer;
      renderer.act(() => {
        tree = renderer.create(
          <ProjectRow
            project={{ ...project, isFocused }}
            tc={tc}
            focusedCount={isFocused ? 1 : 0}
            statusPalette={statusPalette as any}
            t={translate}
            onDeleteProject={vi.fn()}
            onDuplicateProject={vi.fn()}
            onOpenProject={vi.fn()}
            onToggleProjectFocus={vi.fn()}
          />,
        );
      });
      return tree.root.find((node) => node.props.testID === 'project-row-focus-project-1')
        .props.accessibilityLabel as string;
    };

    expect(renderRow(false)).toBe('Zum Fokus hinzufügen');
    expect(renderRow(true)).toBe('Aus dem Fokus entfernen');
  });

  it('uses the filled star alone for focus without adding a yellow row outline', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <ProjectRow
          project={{ ...project, isFocused: true }}
          tc={tc}
          focusedCount={1}
          statusPalette={statusPalette as any}
          t={(key) => key}
          onDeleteProject={vi.fn()}
          onDuplicateProject={vi.fn()}
          onOpenProject={vi.fn()}
          onToggleProjectFocus={vi.fn()}
        />,
      );
    });

    const row = tree.root.find((node) => node.props.testID === 'project-row-project-1');
    const rowStyle = flattenStyle(row.props.style);
    expect(rowStyle.borderColor).toBeUndefined();
    expect(rowStyle.borderWidth).toBeUndefined();
  });

  it('keeps the one-line next-action preview and opens the project from the main row target', () => {
    const onOpenProject = vi.fn();
    const nextAction = { id: 'task-next', title: 'Send the revised proposal' } as any;
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <ProjectRow
          project={project}
          taskSummary={{ activeTaskCount: 3, nextAction }}
          tc={tc}
          focusedCount={0}
          statusPalette={statusPalette as any}
          t={(key) => key}
          onDeleteProject={vi.fn()}
          onDuplicateProject={vi.fn()}
          onOpenProject={onOpenProject}
          onToggleProjectFocus={vi.fn()}
        />,
      );
    });

    const openTarget = tree.root.find((node) => node.props.testID === 'project-row-open-project-1');
    const preview = tree.root.findByProps({ testID: 'project-row-next-action-project-1' });
    expect(openTarget.props.accessibilityRole).toBe('button');
    expect(openTarget.props.accessibilityLabel).toBeUndefined();
    expect(preview.props.numberOfLines).toBe(1);
    expect(preview.props.children).toEqual(['↳ ', 'Send the revised proposal']);

    renderer.act(() => openTarget.props.onPress());
    expect(onOpenProject).toHaveBeenCalledWith(project);
  });

  it('shows the project task count from the precomputed summary', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <ProjectRow
          project={project}
          taskSummary={{ activeTaskCount: 7 }}
          tc={tc}
          focusedCount={0}
          statusPalette={statusPalette as any}
          t={(key) => ({ 'common.tasks': 'tasks' }[key] ?? key)}
          onDeleteProject={vi.fn()}
          onDuplicateProject={vi.fn()}
          onOpenProject={vi.fn()}
          onToggleProjectFocus={vi.fn()}
        />,
      );
    });

    const count = tree.root.find((node) => node.props.accessibilityLabel === '7 tasks');

    expect(count.findByType(Text).props.children).toBe(7);
    expect(flattenStyle(count.props.style)).not.toEqual(expect.objectContaining({ borderWidth: 1 }));
    expect(flattenStyle(count.props.style).backgroundColor).toBeUndefined();
    expect(count.parent?.props.testID).toBe('project-row-trailing-project-1');
  });

  it('keeps the unfocused star visible but disabled at the focus limit', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <ProjectRow
          project={project}
          tc={tc}
          focusedCount={5}
          statusPalette={statusPalette as any}
          t={(key) => key}
          onDeleteProject={vi.fn()}
          onDuplicateProject={vi.fn()}
          onOpenProject={vi.fn()}
          onToggleProjectFocus={vi.fn()}
        />,
      );
    });

    const focusButton = tree.root.findByProps({ testID: 'project-row-focus-project-1' });
    expect(focusButton.props.disabled).toBe(true);
    expect(focusButton.props.accessibilityState).toEqual({ selected: false, disabled: true });
    expect(tree.root.findAll((node) => (node.type as unknown) === 'Star')).toHaveLength(1);
  });

  it('uses warning haptics for confirmed project deletion from the swipe action', () => {
    const alertSpy = vi.spyOn(Alert, 'alert');
    const onDeleteProject = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <ProjectRow
          project={project}
          tc={tc}
          focusedCount={0}
          statusPalette={statusPalette as any}
          t={(key) =>
            ({
              'projects.title': 'Projects',
              'projects.deleteConfirm': 'Delete this project?',
              'projects.duplicate': 'Duplicate',
              'common.cancel': 'Cancel',
              'common.delete': 'Delete',
            }[key] ?? key)
          }
          onDeleteProject={onDeleteProject}
          onDuplicateProject={vi.fn()}
          onOpenProject={vi.fn()}
          onToggleProjectFocus={vi.fn()}
        />,
      );
    });

    const deleteButton = tree.root.find((node) => node.props.testID === 'project-row-delete-project-1');

    renderer.act(() => {
      deleteButton.props.onPress();
    });

    expect(hapticsMocks.selectionAsync).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith(
      'Projects',
      'Delete this project?',
      expect.arrayContaining([
        expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
        expect.objectContaining({ text: 'Delete', style: 'destructive', onPress: expect.any(Function) }),
      ]),
    );

    const buttons = alertSpy.mock.calls[0]?.[2] as { text?: string; onPress?: () => void }[];
    const deleteAction = buttons.find((button) => button.text === 'Delete');

    renderer.act(() => {
      deleteAction?.onPress?.();
    });

    expect(hapticsMocks.notificationAsync).toHaveBeenCalledWith('warning');
    expect(onDeleteProject).toHaveBeenCalledWith('project-1');
  });

  it('exposes a duplicate action for project templates', () => {
    const onDuplicateProject = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <ProjectRow
          project={project}
          tc={tc}
          focusedCount={0}
          statusPalette={statusPalette as any}
          t={(key) => ({ 'projects.duplicate': 'Duplicate' }[key] ?? key)}
          onDeleteProject={vi.fn()}
          onDuplicateProject={onDuplicateProject}
          onOpenProject={vi.fn()}
          onToggleProjectFocus={vi.fn()}
        />,
      );
    });

    const duplicateButton = tree.root.find((node) => node.props.testID === 'project-row-duplicate-project-1');

    expect(duplicateButton.props.accessibilityLabel).toBe('Duplicate');

    renderer.act(() => {
      duplicateButton.props.onPress();
    });

    expect(hapticsMocks.selectionAsync).toHaveBeenCalledTimes(1);
    expect(onDuplicateProject).toHaveBeenCalledWith('project-1');
  });

  it('distinguishes completed and cancelled closed projects', () => {
    const renderStatus = (cancelledAt?: string) => {
      let tree!: renderer.ReactTestRenderer;
      renderer.act(() => {
        tree = renderer.create(
          <ProjectRow
            project={{ ...project, status: 'archived', cancelledAt }}
            tc={tc}
            focusedCount={0}
            statusPalette={statusPalette as any}
            t={(key) => ({ 'list.done': 'Completed', 'projects.cancelled': 'Cancelled' }[key] ?? key)}
            onDeleteProject={vi.fn()}
            onDuplicateProject={vi.fn()}
            onOpenProject={vi.fn()}
            onToggleProjectFocus={vi.fn()}
          />,
        );
      });
      return tree.root.findAllByType(Text).map((node) => node.props.children);
    };

    expect(renderStatus()).toContain('Completed');
    expect(renderStatus('2026-04-02T00:00:00.000Z')).toContain('Cancelled');
  });
});

import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { Area, Project } from '@mindwtr/core';

import { DeferredProjectsSection } from './deferred-projects-section';

vi.mock('lucide-react-native', () => ({
  Folder: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
}));

vi.mock('react-native-gesture-handler', () => ({
  Swipeable: ({ children, ...props }: any) => React.createElement('Swipeable', props, children),
}));

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios' },
  Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
  TouchableOpacity: ({ children, ...props }: any) => React.createElement('TouchableOpacity', props, children),
  View: ({ children, ...props }: any) => React.createElement('View', props, children),
}));

const makeProject = (id: string, overrides: Partial<Project> = {}): Project => ({
  id,
  title: `Project ${id}`,
  status: 'someday',
  color: '#2563eb',
  order: 0,
  tagIds: [],
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  ...overrides,
} as Project);

const homeArea = { id: 'area-home', name: 'Home', order: 0 } as Area;
const areaById = new Map<string, Area>([[homeArea.id, homeArea]]);

describe('DeferredProjectsSection', () => {
  const render = (
    projects: Project[],
    handlers: {
      onActivateProject?: (projectId: string) => void;
      onOpenProject?: (projectId: string) => void;
    } = {},
  ) => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <DeferredProjectsSection
          projects={projects}
          areaById={areaById}
          themeColors={{} as never}
          t={(key: string) => key}
          onActivateProject={handlers.onActivateProject ?? vi.fn()}
          onOpenProject={handlers.onOpenProject ?? vi.fn()}
        />,
      );
    });
    return tree;
  };

  it('renders nothing when no project is deferred', () => {
    expect(render([]).toJSON()).toBeNull();
  });

  it('opens a project on press and reactivates it on left swipe', () => {
    const onOpenProject = vi.fn();
    const onActivateProject = vi.fn();
    const project = makeProject('someday-1', { areaId: homeArea.id });

    const tree = render([project], { onOpenProject, onActivateProject });

    act(() => {
      tree.root.findAllByType('TouchableOpacity' as never).find((node) => !node.props.accessibilityState)!.props.onPress();
    });
    expect(onOpenProject).toHaveBeenCalledWith('someday-1');

    act(() => {
      tree.root.findByType('Swipeable' as never).props.onSwipeableLeftOpen();
    });
    expect(onActivateProject).toHaveBeenCalledWith('someday-1');
  });

  it.each(['someday', 'waiting'] as const)('collapses %s projects without changing them and keeps the count visible', (status) => {
    const onOpenProject = vi.fn();
    const onActivateProject = vi.fn();
    const tree = render([makeProject('one', { status }), makeProject('two', { status })], { onOpenProject, onActivateProject });
    const header = () => tree.root.findAllByType('TouchableOpacity' as never).find((node) => node.props.accessibilityState)!;
    expect(header().props.accessibilityLabel).toBe('Projects (2)');
    expect(header().props.accessibilityState.expanded).toBe(true);
    expect(header().props.style.minHeight).toBe(44);
    act(() => header().props.onPress());
    expect(header().props.accessibilityState.expanded).toBe(false);
    expect(header().props.accessibilityLabel).toBe('Projects (2)');
    expect(tree.root.findAllByType('Swipeable' as never)).toHaveLength(0);
    act(() => header().props.onPress());
    expect(tree.root.findAllByType('Swipeable' as never)).toHaveLength(2);
    expect(onOpenProject).not.toHaveBeenCalled();
    expect(onActivateProject).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
});

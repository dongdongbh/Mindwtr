import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SwipeableTaskItemStatusMenu } from './SwipeableTaskItemStatusMenu';

const clipboard = vi.hoisted(() => ({ write: vi.fn(), toast: vi.fn() }));
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard.write }));
vi.mock('../../contexts/toast-context', () => ({ useToast: () => ({ showToast: clipboard.toast }) }));

vi.mock('react-native', () => ({
  Modal: ({ visible, children, ...props }: any) => visible
    ? React.createElement('Modal', props, children) : null,
  Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
  Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
  View: ({ children, ...props }: any) => React.createElement('View', props, children),
}));

vi.mock('../../hooks/use-status-colors', () => ({
  useStatusColors: () => ({
    inbox: { text: '#fff', bg: '#222' },
    next: { text: '#fff', bg: '#222' },
    waiting: { text: '#fff', bg: '#222' },
    someday: { text: '#fff', bg: '#222' },
    done: { text: '#fff', bg: '#222' },
    reference: { text: '#fff', bg: '#222' },
  }),
}));

vi.mock('./swipeable-task-item.styles', () => ({ styles: {} }));


const baseProps = {
  visible: true,
  taskStatus: 'someday' as const,
  taskId: 'task /?&#',
  onClose: vi.fn(),
  onStatusChange: vi.fn(),
  tc: { cardBg: '#fff', border: '#ddd', text: '#111' } as any,
  t: (key: string) => key,
};

describe('Someday task menu', () => {
  beforeEach(() => { vi.clearAllMocks(); clipboard.write.mockResolvedValue(undefined); });

  it.each([
    ['Copy Mindwtr link', 'mindwtr://open?task=task%20%2F%3F%26%23'],
    ['Copy task ID', 'task /?&#'],
  ])('copies %s from the actual menu without changing status', async (label, expected) => {
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<SwipeableTaskItemStatusMenu {...baseProps} />); });
    const button = tree.root.findAllByType('Pressable' as never)
      .find((node) => node.props.accessibilityLabel === label)!;
    await act(async () => { button.props.onPress(); });
    expect(clipboard.write).toHaveBeenCalledExactlyOnceWith(expected);
    expect(clipboard.toast).toHaveBeenCalledExactlyOnceWith({ message: 'Task copied to clipboard', tone: 'success' });
    expect(baseProps.onClose).toHaveBeenCalledOnce();
    expect(baseProps.onStatusChange).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it.each(['Copy Mindwtr link', 'Copy task ID'])('reports clipboard failure for %s', async (label) => {
    clipboard.write.mockRejectedValueOnce(new Error('Unavailable'));
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<SwipeableTaskItemStatusMenu {...baseProps} />); });
    const button = tree.root.findAllByType('Pressable' as never)
      .find((node) => node.props.accessibilityLabel === label)!;
    await act(async () => { button.props.onPress(); });
    expect(clipboard.toast).toHaveBeenCalledExactlyOnceWith({ message: 'Could not copy task', tone: 'error' });
    expect(baseProps.onStatusChange).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
  it('opens the grouped project or area destination picker', () => {
    const onMoveToDestination = vi.fn();
    const onClose = vi.fn();
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <SwipeableTaskItemStatusMenu
          {...baseProps}
          onClose={onClose}
          onMoveToDestination={onMoveToDestination}
        />,
      );
    });
    const button = tree!.root.findAllByType('Pressable' as never)
      .find((node) => node.props.accessibilityLabel === 'Move to project or area…');
    expect(button).toBeDefined();
    act(() => { button?.props.onPress(); });
    expect(onMoveToDestination).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    act(() => tree!.unmount());
  });

  it('offers Move to section without changing task status or opening the editor', () => {
    const onMoveToSection = vi.fn();
    let tree: ReturnType<typeof create>;
    act(() => { tree = create(<SwipeableTaskItemStatusMenu {...baseProps} onMoveToSection={onMoveToSection} />); });
    const button = tree!.root.findAllByType('Pressable' as never)
      .find((node) => node.props.accessibilityLabel === 'Move to section…');
    expect(button).toBeDefined();
    act(() => { button?.props.onPress(); });
    expect(onMoveToSection).toHaveBeenCalledOnce();
    expect(baseProps.onStatusChange).not.toHaveBeenCalled();
    expect(baseProps.onClose).toHaveBeenCalledOnce();
    act(() => tree!.unmount());
  });

  it('does not add section controls to lists that do not supply the action', () => {
    let tree: ReturnType<typeof create>;
    act(() => { tree = create(<SwipeableTaskItemStatusMenu {...baseProps} />); });
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Move to section…' })).toHaveLength(0);
    act(() => tree!.unmount());
  });
});

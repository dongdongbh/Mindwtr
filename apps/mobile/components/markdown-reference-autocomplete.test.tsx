import React from 'react';
import { Pressable } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useTaskStore, type MarkdownToolbarResult, type Task } from '@mindwtr/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MarkdownReferenceAutocomplete } from './markdown-reference-autocomplete';

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const buyMilk: Task = {
    id: 'x',
    title: 'Buy milk',
    status: 'inbox',
    tags: [],
    contexts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('MarkdownReferenceAutocomplete', () => {
    let tree: ReactTestRenderer | undefined;

    afterEach(() => {
        act(() => tree?.unmount());
        tree = undefined;
        useTaskStore.setState({ _allTasks: [], projects: [], settings: {} });
    });

    it('replaces the auto-paired ]] closer when a suggestion is picked', () => {
        useTaskStore.setState({ _allTasks: [buyMilk], projects: [], settings: {} });
        const onApplyResult = vi.fn<(result: MarkdownToolbarResult) => void>();
        const value = 'see [[Bu]]';
        const caret = 'see [[Bu'.length;

        act(() => {
            tree = create(
                <MarkdownReferenceAutocomplete
                    value={value}
                    selection={{ start: caret, end: caret }}
                    inputRef={{ current: null }}
                    visible
                    onApplyResult={onApplyResult}
                    t={(key) => key}
                    tc={{ cardBg: '#fff', border: '#ddd', text: '#111', secondaryText: '#666' } as any}
                />,
            );
        });

        const suggestion = tree!.root.findAllByType(Pressable).find((node) => node.props.onPress && node.findAllByProps({ children: 'Buy milk' }).length > 0);
        act(() => suggestion!.props.onPress());

        expect(onApplyResult).toHaveBeenCalledWith({
            value: 'see [[task:x|Buy milk]]',
            selection: { start: 23, end: 23 },
        });
    });
});

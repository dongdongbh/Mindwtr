import React from 'react';
import { readFileSync, writeFileSync } from 'node:fs';
import { Pressable } from 'react-native';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import HistoryScreen from './history';

const routeState = vi.hoisted(() => ({ tab: undefined as string | undefined }));
const setParams = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => ({ tab: routeState.tab }),
    useRouter: () => ({ setParams }),
}));

vi.mock('./done', () => ({
    default: () => React.createElement('DoneContent'),
}));

vi.mock('./archived', () => ({
    default: () => React.createElement('ArchivedContent'),
}));

vi.mock('../../contexts/language-context', () => ({
    useLanguage: () => ({
        t: (key: string) => ({ 'nav.done': 'Done', 'nav.archived': 'Archived' }[key] ?? key),
    }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
    useThemeColors: () => ({
        bg: '#fff', cardBg: '#fff', border: '#ddd', tint: '#06f', secondaryText: '#666',
    }),
}));

const FIXTURE_PATH = new URL('../../../../packages/core/src/list-views-model-parity.fixtures.json', import.meta.url).pathname;

describe('HistoryScreen', () => {
    beforeEach(() => {
        routeState.tab = undefined;
        setParams.mockReset();
    });

    it('defaults to Done and switches to Archived in the same surface', () => {
        let tree!: ReturnType<typeof create>;
        act(() => { tree = create(<HistoryScreen />); });

        expect(tree.root.findAllByType('DoneContent' as never)).toHaveLength(1);
        const archivedTab = tree.root.findAllByType(Pressable).find(
            (node) => node.props.accessibilityLabel === 'Archived',
        );
        expect(archivedTab).toBeTruthy();

        act(() => archivedTab!.props.onPress());

        expect(tree.root.findAllByType('ArchivedContent' as never)).toHaveLength(1);
        expect(setParams).toHaveBeenCalledWith({ tab: 'archived' });
    });

    it('honors an archived deep link on first render', () => {
        routeState.tab = 'archived';
        let tree!: ReturnType<typeof create>;
        act(() => { tree = create(<HistoryScreen />); });

        expect(tree.root.findAllByType('ArchivedContent' as never)).toHaveLength(1);
    });


    it('opens and switches tabs exactly as frozen', () => {
        const observed = [undefined, 'done', 'archived', 'ARCHIVED', 'trash', ''].map((tab) => {
            routeState.tab = tab;
            setParams.mockReset();
            let tree!: ReturnType<typeof create>;
            act(() => { tree = create(<HistoryScreen />); });
            const tabs = () => tree.root.findAllByType(Pressable).map((node) => [node.props.accessibilityLabel, node.props.accessibilityState.selected]);
            const content = () => (tree.root.findAllByType('DoneContent' as never).length > 0 ? 'done' : 'archived');
            const opened = { tabs: tabs(), content: content() };
            const other = tree.root.findAllByType(Pressable).find((node) => !node.props.accessibilityState.selected)!;
            act(() => other.props.onPress());
            return { tab: tab ?? null, opened, switched: { tabs: tabs(), content: content(), setParams: setParams.mock.calls } };
        });
        if (process.env.MINDWTR_CAPTURE_LIST_VIEWS === '1') {
            const previous = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
            writeFileSync(FIXTURE_PATH, `${JSON.stringify({ ...previous, history: { observations: observed } }, null, 1)}\n`);
        }
        expect(observed).toEqual(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')).history.observations);
    });
});

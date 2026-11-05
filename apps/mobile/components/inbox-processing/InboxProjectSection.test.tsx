import React from 'react';
import { View } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { InboxProjectSection } from './InboxProjectSection';
import { ThemeContext } from '../../contexts/theme-context';
import { FALLBACK_THEME_COLORS } from '../../hooks/use-theme-colors';

vi.mock('@/hooks/use-filled-button-colors', () => ({ useFilledButtonColors: () => ({ backgroundColor: '#00f', textColor: '#fff' }) }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('InboxProjectSection project chips', () => {
    it('lists active projects first, then Someday / Waiting after a heading (#1467)', () => {
        const project = (id: string, title: string, status: 'active' | 'someday' | 'waiting') => ({ id, title, status });
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <InboxProjectSection
                    t={(key) => key}
                    tc={{ text: '#fff', secondaryText: '#aaa', tint: '#00f', filterBg: '#111', cardBg: '#222', border: '#333', inputBg: '#111', onTint: '#fff' } as any}
                    show
                    showProjectField
                    showAreaField={false}
                    setSelectedAreaId={vi.fn()}
                    projectSearch=""
                    setProjectSearch={vi.fn()}
                    convertToProject={false}
                    nextActionDraft=""
                    setNextActionDraft={vi.fn()}
                    extraActionDrafts={[]}
                    setExtraActionDrafts={vi.fn()}
                    filteredProjects={[project('s', 'Someday one', 'someday'), project('a', 'Active one', 'active'), project('w', 'Waiting one', 'waiting')]}
                    areaById={new Map()}
                    hasExactProjectMatch={false}
                    handleCreateProjectEarly={vi.fn()}
                    handleConvertToProject={vi.fn()}
                    selectProjectEarly={vi.fn()}
                />,
            );
        });
        const texts = tree.root.findAll((node) => (node.type as unknown) === 'Text').map((node) => React.Children.toArray(node.props.children).join(''));
        const start = texts.indexOf('Active one');
        expect(texts.slice(start, start + 4)).toEqual(['Active one', 'Someday / Waiting', 'Someday one', 'Waiting one']);
    });

    it.each(['default', 'eink'] as const)('renders saved project and area colors safely on %s', (themePreset) => {
        const area = { id: 'area', name: 'Area', color: '#3b82f6' };
        const project = { id: 'project', title: 'Project', status: 'active' as const, areaId: area.id, colorOverride: '#f97316' };
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <ThemeContext.Provider value={{ themePreset, themeMode: 'system', themeStyle: 'default', colorScheme: 'light', isDark: false, isReady: true, setThemeMode: () => {}, setThemeStyle: () => {} }}>
                    <InboxProjectSection
                        t={(key) => key} tc={FALLBACK_THEME_COLORS}
                        show showProjectField showAreaField
                        setSelectedAreaId={vi.fn()} projectSearch="" setProjectSearch={vi.fn()}
                        convertToProject={false} nextActionDraft="" setNextActionDraft={vi.fn()}
                        extraActionDrafts={[]} setExtraActionDrafts={vi.fn()}
                        filteredProjects={[project]} areaById={new Map([[area.id, area]])}
                        hasExactProjectMatch={false} handleCreateProjectEarly={vi.fn()}
                        handleConvertToProject={vi.fn()} selectProjectEarly={vi.fn()}
                    />
                </ThemeContext.Provider>,
            );
        });
        const dots = tree.root.findAll((node) => node.type === View && Array.isArray(node.props.style) && node.props.style[0]?.width === 8);
        const colors = dots.map((node) => node.props.style[1].backgroundColor);
        expect(colors).toEqual(themePreset === 'eink' ? ['#000000', '#000000'] : ['#3b82f6', '#f97316']);
        act(() => tree.unmount());
    });
});

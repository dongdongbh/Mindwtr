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
    it('renders Area once, Projects next and one selected project with indented sections', () => {
        const area = { id: 'work', name: 'Work' };
        const project = { id: 'project', title: 'Selected project', areaId: 'work' };
        const render = (selected: boolean) => renderer.create(<InboxProjectSection
            t={(key) => key} tc={FALLBACK_THEME_COLORS} show showProjectField showAreaField
            currentProject={selected ? project : null} currentArea={area} selectedAreaId={selected ? null : area.id}
            selectedProjectId={selected ? project.id : null} setSelectedAreaId={vi.fn()}
            projectSearch="" setProjectSearch={vi.fn()} convertToProject={false} nextActionDraft="" setNextActionDraft={vi.fn()}
            extraActionDrafts={[]} setExtraActionDrafts={vi.fn()} filteredProjects={[project]} areaById={new Map([[area.id, area]])}
            hasExactProjectMatch={false} handleCreateProjectEarly={vi.fn()} handleConvertToProject={vi.fn()} selectProjectEarly={vi.fn()}
            projectSections={[{ id: 'section', title: 'Design' }]} selectedSectionId="section" selectSection={vi.fn()}
            projectBrowseScope={{ kind: 'none' }} setProjectBrowseScope={vi.fn()}
        />);
        let tree!: renderer.ReactTestRenderer;
        act(() => { tree = render(false); });
        expect(tree.root.findAll((node) => String(node.type) === 'TouchableOpacity' && node.props.accessibilityLabel === 'taskEdit.areaLabel: Work')).toHaveLength(1);
        act(() => tree.unmount());
        act(() => { tree = render(true); });
        const texts = tree.root.findAll((node) => String(node.type) === 'Text').map((node) => React.Children.toArray(node.props.children).join(''));
        expect(texts.indexOf('taskEdit.areaLabel')).toBeLessThan(texts.indexOf('Work'));
        expect(texts.indexOf('Work')).toBeLessThan(texts.indexOf('projects.title'));
        expect(texts.indexOf('projects.title')).toBeLessThan(texts.indexOf('✓ Selected project'));
        expect(texts.indexOf('✓ Selected project')).toBeLessThan(texts.indexOf('taskEdit.sectionLabel'));
        expect(tree.root.findAll((node) => String(node.type) === 'TouchableOpacity' && node.props.accessibilityLabel === 'taskEdit.projectLabel: Selected project')).toHaveLength(1);
        expect(tree.root.findAll((node) => String(node.type) === 'TouchableOpacity' && node.props.accessibilityLabel === 'taskEdit.areaLabel: Work')).toHaveLength(0);
        const sectionHeading = tree.root.find((node) => String(node.type) === 'Text' && node.props.children === 'taskEdit.sectionLabel');
        let sectionGroup = sectionHeading.parent;
        while (sectionGroup && !JSON.stringify(sectionGroup.props.style ?? []).includes('marginLeft')) sectionGroup = sectionGroup.parent;
        expect(sectionGroup?.props.style).toContainEqual({ marginLeft: 16 });
        expect(tree.root.findAll((node) => String(node.type) === 'TouchableOpacity' && node.props.accessibilityLabel === 'Browse projects: projects.allAreas')).toHaveLength(0);
        act(() => tree.unmount());
    });

});

import React from 'react';
import { Text, TextInput, TouchableOpacity } from 'react-native';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@mindwtr/core';
import { ProjectToSectionModal } from './ProjectToSectionModal';

const mocks = vi.hoisted(() => {
    const preview = { ok: true, sourceTitle: 'Source', destinationTitle: 'Destination', defaultTitle: 'Source', taskCount: 2, completedCount: 1, archivedCount: 0, colorWillBeLost: true };
    const command = { sourceProjectId: 'source', destinationProjectId: 'dest', section: { title: 'Milestones' }, source: { before: { supportNotes: 'Notes' } }, destination: { id: 'dest', title: 'Destination' }, preview };
    const previewer = vi.fn(() => preview);
    const rows = { _allProjects: [], _allSections: [], _allTasks: [] };
    return { preview, command, rows, convert: vi.fn(), prepare: vi.fn(() => ({ ok: true, preview, command })), previewCall: vi.fn(() => preview),
        createPreviewer: vi.fn(() => previewer) };
});

vi.mock('@mindwtr/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@mindwtr/core')>();
    return { ...actual, previewProjectToSection: mocks.previewCall, prepareProjectToSection: mocks.prepare,
        createProjectToSectionPreviewer: mocks.createPreviewer,
        useTaskStore: { getState: () => ({ areas: [], convertProjectToSection: mocks.convert, ...mocks.rows }) } };
});
vi.mock('../../hooks/use-theme-colors', () => ({ useThemeColors: () => ({ cardBg: '#fff', border: '#ddd', text: '#111', secondaryText: '#555', tint: '#00f', inputBg: '#fff', danger: '#f00' }) }));
vi.mock('../../contexts/language-context', () => ({ useLanguage: () => ({ t: (key: string) => key === 'common.cancel' ? 'Cancel' : key }) }));

const source = { id: 'source', title: 'Source', status: 'active', color: '#f00', supportNotes: 'Notes' } as Project;
const destination = { id: 'dest', title: 'Destination', status: 'active', color: '#00f' } as Project;
const button = (tree: ReturnType<typeof create>, label: string) => tree.root.findAllByType(TouchableOpacity).find((item) => item.props.accessibilityLabel === label)!;
const text = (tree: ReturnType<typeof create>) => tree.root.findAllByType(Text).map((item) => item.props.children).filter((value) => typeof value === 'string').join(' ');

describe('ProjectToSectionModal', () => {
    it('explains the required destination flow for a sequential source', () => {
        let tree!: ReturnType<typeof create>;
        act(() => { tree = create(<ProjectToSectionModal visible source={{ ...source, isSequential: true }} projects={[destination]} onClose={vi.fn()} onSuccess={vi.fn()} />); });
        expect(text(tree)).toContain('Choose a destination set to Sequential → Within sections');
        act(() => tree.unmount());
    });

    it('does not rebuild the destination list while the section name is typed', () => {
        let tree!: ReturnType<typeof create>;
        act(() => { tree = create(<ProjectToSectionModal visible source={source} projects={[source, destination]} onClose={vi.fn()} onSuccess={vi.fn()} />); });
        act(() => tree.root.findAllByType(TouchableOpacity).find((item) => item.props.accessibilityRole === 'radio' && item.props.children?.props?.children === 'Destination')?.props.onPress());
        const builds = mocks.createPreviewer.mock.calls.length;
        const previews = mocks.previewCall.mock.calls.length;
        expect(builds).toBeGreaterThan(0);
        for (const value of ['M', 'Mi', 'Mil', 'Mile']) act(() => tree.root.findByType(TextInput).props.onChangeText(value));
        expect(mocks.createPreviewer.mock.calls.length).toBe(builds);
        expect(mocks.previewCall.mock.calls.length).toBe(previews);
        expect(button(tree, 'Next').props.disabled).toBe(false);
    });

    it('keeps the confirmed command through an in-memory source removal and failed save', async () => {
        mocks.convert.mockReset();
        mocks.convert.mockResolvedValueOnce({ success: false, reason: 'save-failed' });
        mocks.convert.mockResolvedValueOnce({ success: true, destinationProjectId: 'dest', sectionId: 'section', receipt: mocks.command });
        const onSuccess = vi.fn();
        let tree!: ReturnType<typeof create>;
        act(() => { tree = create(<ProjectToSectionModal visible source={source} projects={[source, destination]} onClose={vi.fn()} onSuccess={onSuccess} />); });
        act(() => tree.root.findAllByType(TouchableOpacity).find((item) => item.props.accessibilityRole === 'radio' && item.props.children?.props?.children === 'Destination')?.props.onPress());
        act(() => tree.root.findByType(TextInput).props.onChangeText('Milestones'));
        act(() => button(tree, 'Next').props.onPress());
        expect(text(tree)).toContain('New section: Milestones');
        expect(text(tree)).toContain('Move 2 tasks (1 done, 0 archived) from Source into Destination.');
        await act(async () => { await button(tree, 'Convert to section…').props.onPress(); });
        act(() => tree.update(<ProjectToSectionModal visible source={{ ...source, title: 'Stale' }} projects={[destination]} onClose={vi.fn()} onSuccess={onSuccess} />));
        expect(button(tree, 'Back').props.disabled).toBe(true);
        expect(text(tree)).toContain('from Source into Destination.');
        await act(async () => { await button(tree, 'Retry').props.onPress(); });
        expect(onSuccess).toHaveBeenCalledOnce();
        expect(mocks.convert).toHaveBeenNthCalledWith(1, mocks.command);
        expect(mocks.convert).toHaveBeenNthCalledWith(2, mocks.command);
    });
});

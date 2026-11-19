import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TextInput, TouchableOpacity } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    days: 0,
    save: vi.fn(async (_days: number) => ({ success: true })),
    preview: vi.fn(() => ({ taskIds: ['task-1'], projectIds: [], sectionIds: [], legacyTaskIds: ['old-1'], legacyProjectIds: [] })),
}));

vi.mock('@mindwtr/core', () => ({
    getDocsGuideUrl: (path: string, language?: string) => `https://docs.mindwtr.app/${language === 'de' ? 'de/' : ''}${path}`,
    isArchiveRetentionDays: (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 36500,
    getArchiveRetentionPreview: harness.preview,
    useTaskStore: Object.assign(
        (selector: (state: unknown) => unknown) => selector({ settings: { gtd: { archiveRetentionDays: harness.days } } }),
        { getState: () => ({
            _allTasks: [{ id: 'task-1', title: 'Review me' }], _allProjects: [], _allSections: [],
            setArchiveRetentionDays: harness.save,
        }) },
    ),
}));
vi.mock('@/hooks/use-theme-colors', () => ({
    useThemeColors: () => ({ cardBg: '#fff', border: '#ddd', text: '#111', secondaryText: '#666', tint: '#06f' }),
}));
vi.mock('./settings.shell', () => ({
    SettingsGuideLink: (props: Record<string, unknown>) => React.createElement('SettingsGuideLink', props),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props) }));
vi.mock('./settings.hooks', () => ({
    useSettingsLocalization: () => ({ language: 'de', tr: (key: string, values?: Record<string, number>) =>
        `${key}${values ? ` ${Object.values(values).join(',')}` : ''}` }),
}));

import { ArchiveRetentionSection } from './archive-retention-section';

const openCard = async (tree: renderer.ReactTestRenderer) => {
    const disclosure = tree.root.findAllByType(TouchableOpacity).find((node) => node.props.testID === 'archive-retention-disclosure')!;
    await act(async () => disclosure.props.onPress());
};

const button = (tree: renderer.ReactTestRenderer, label: string) => tree.root.findAllByType(TouchableOpacity)
    .find((node) => node.findAllByType(Text).some((text) => text.props.children === label))!;

describe('ArchiveRetentionSection mobile', () => {
    beforeEach(() => { harness.days = 0; harness.save.mockClear(); harness.preview.mockClear(); });

    it('starts folded with the current setting and opens to a short description and a docs link', async () => {
        harness.days = 45;
        let tree!: renderer.ReactTestRenderer;
        await act(async () => { tree = renderer.create(<ArchiveRetentionSection />); });
        const texts = () => tree.root.findAllByType(Text).map((node) => node.props.children);
        expect(texts().slice(0, 2)).toEqual(['settings.archiveRetention', 'settings.archiveRetentionCurrent: settings.archiveRetentionDays 45']);
        expect(texts()).not.toContain('settings.archiveRetentionDesc');
        expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
        await openCard(tree);
        expect(texts()).toContain('settings.archiveRetentionDesc');
        expect(texts()).toContain('settings.archiveRetentionSafety');
        const link = tree.root.findByType('SettingsGuideLink' as unknown as React.ElementType);
        expect(link.props).toMatchObject({ title: 'settings.archiveRetentionLearnMore', url: 'https://docs.mindwtr.app/de/data-sync/data-lifecycle' });
        expect(tree.root.findAllByType(TextInput)).toHaveLength(1);
        await act(async () => tree.unmount());
    });

    it('keeps invalid values disabled and requires candidate review before enabling', async () => {
        let tree!: renderer.ReactTestRenderer;
        await act(async () => { tree = renderer.create(<ArchiveRetentionSection />); });
        await openCard(tree);
        const input = tree.root.findByType(TextInput);
        expect(button(tree, 'settings.archiveRetentionSave').props.disabled).toBe(true);
        await act(async () => input.props.onChangeText('1.5'));
        expect(button(tree, 'settings.archiveRetentionSave').props.disabled).toBe(true);
        await act(async () => input.props.onChangeText('30'));
        await act(async () => button(tree, 'settings.archiveRetentionSave').props.onPress());
        expect(harness.save).not.toHaveBeenCalled();
        expect(tree.root.findAllByType(Text).some((node) => node.props.children === 'calendar.tasks: Review me')).toBe(true);
        await act(async () => button(tree, 'common.cancel').props.onPress());
        expect(harness.save).not.toHaveBeenCalled();
        await act(async () => button(tree, 'settings.archiveRetentionSave').props.onPress());
        await act(async () => button(tree, 'settings.archiveRetentionConfirmAction').props.onPress());
        expect(harness.save).toHaveBeenCalledWith(30);
        await act(async () => tree.unmount());
    });

    it('reviews a shorter policy before saving', async () => {
        harness.days = 90;
        let tree!: renderer.ReactTestRenderer;
        await act(async () => { tree = renderer.create(<ArchiveRetentionSection />); });
        await openCard(tree);
        await act(async () => tree.root.findByType(TextInput).props.onChangeText('30'));
        await act(async () => button(tree, 'settings.archiveRetentionSave').props.onPress());
        expect(harness.save).not.toHaveBeenCalled();
        expect(tree.root.findAllByType(Text).some((node) => node.props.children === 'settings.archiveRetentionConfirmTitle')).toBe(true);
        await act(async () => tree.unmount());
    });
});

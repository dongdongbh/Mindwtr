import React, { type ComponentProps } from 'react';
import { Text, TextInput } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { TaskEditOrganizationField } from './TaskEditOrganizationField';

const styles = {
    formGroup: {},
    label: {},
    dateRow: {},
    dateBtn: {},
    flex1: {},
    clearDateBtn: {},
    clearDateText: {},
    compactFieldRow: {},
    compactFieldLabel: {},
    compactFieldValue: {},
    statusContainer: {},
    statusContainerCompact: {},
    statusChip: {},
    statusChipCompact: {},
    statusText: {},
    statusTextCompact: {},
    input: {},
    tokenSuggestionsMenu: {},
    tokenSuggestionItem: {},
    tokenSuggestionItemLast: {},
    tokenSuggestionText: {},
};

const tc = {
    cardBg: '#111',
    border: '#333',
    filterBg: '#222',
    inputBg: '#111',
    secondaryText: '#aaa',
    text: '#fff',
    tint: '#3b82f6',
    onTint: '#102030',
};

const t = (key: string) => ({
    'taskEdit.projectLabel': 'Project',
    'taskEdit.noProjectOption': 'No Project',
    'taskEdit.areaLabel': 'Area',
    'taskEdit.noAreaOption': 'No Area',
    'taskEdit.sectionLabel': 'Section',
    'taskEdit.noSectionOption': 'No Section',
    'taskEdit.statusLabel': 'Status',
    'status.done': 'Done',
    'status.next': 'Next',
    'task.completeBackdateHintMobile': 'Long-press to complete with a different time',
    'people.new': 'New Person',
    'common.clear': 'Clear',
}[key] ?? key);

const baseProps = {
    applyAssignedToSuggestion: vi.fn(),
    areas: [],
    assignedToSuggestions: [],
    availableStatusOptions: [],
    draft: {
        projectId: '',
        sectionId: '',
        areaId: '',
        status: 'next',
        priority: '',
        energyLevel: '',
        assignedTo: '',
        timeEstimate: '',
        timeSpentMinutes: undefined,
    },
    editedTask: {},
    energyLevelOptions: [],
    handleInputFocus: vi.fn(),
    createAssignedToPerson: vi.fn(),
    prioritiesEnabled: true,
    priorityOptions: [],
    projectSections: [],
    projects: [],
    requestBackdatedCompletion: vi.fn(),
    requestStatusChange: vi.fn(),
    setDraftField: vi.fn(),
    setShowAreaPicker: vi.fn(),
    setShowProjectPicker: vi.fn(),
    setShowSectionPicker: vi.fn(),
    styles,
    t,
    task: null,
    tc,
    timeEstimateOptions: [],
    timeEstimatesEnabled: true,
};

describe('TaskEditOrganizationField', () => {
    it('opens the completion-time picker when Done is long-pressed', () => {
        const requestBackdatedCompletion = vi.fn();
        const requestStatusChange = vi.fn();

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditOrganizationField
                    {...(baseProps as any)}
                    fieldId="status"
                    editedTask={{ status: 'next' }}
                    availableStatusOptions={['next', 'done']}
                    requestBackdatedCompletion={requestBackdatedCompletion}
                    requestStatusChange={requestStatusChange}
                />
            );
        });

        const doneButton = tree.root.findByProps({ accessibilityLabel: 'Status: Done' });
        const selectedStatusText = tree.root
            .findByProps({ accessibilityLabel: 'Status: Next' })
            .findAllByType(Text)
            .find((node) => node.props.children === 'Next');
        expect(doneButton.props.accessibilityHint).toBe('Long-press to complete with a different time');
        expect(selectedStatusText?.props.style).toEqual(expect.arrayContaining([
            expect.objectContaining({ color: tc.onTint }),
        ]));

        act(() => {
            doneButton.props.onLongPress();
        });

        expect(requestBackdatedCompletion).toHaveBeenCalledTimes(1);
        expect(requestStatusChange).not.toHaveBeenCalled();
    });

    it('renders an unset project as a compact picker row', () => {
        const setShowProjectPicker = vi.fn();

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditOrganizationField
                    {...(baseProps as any)}
                    fieldId="project"
                    setShowProjectPicker={setShowProjectPicker}
                />
            );
        });

        const compactButton = tree.root.findByProps({ accessibilityLabel: 'Project: No Project' });
        expect(compactButton.props.accessibilityRole).toBe('button');

        act(() => {
            compactButton.props.onPress();
        });

        expect(setShowProjectPicker).toHaveBeenCalledWith(true);
    });

    it('renders an unset area as a compact picker row', () => {
        const setShowAreaPicker = vi.fn();

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditOrganizationField
                    {...(baseProps as any)}
                    fieldId="area"
                    setShowAreaPicker={setShowAreaPicker}
                />
            );
        });

        const compactButton = tree.root.findByProps({ accessibilityLabel: 'Area: No Area' });
        expect(compactButton.props.accessibilityRole).toBe('button');

        act(() => {
            compactButton.props.onPress();
        });

        expect(setShowAreaPicker).toHaveBeenCalledWith(true);
    });

    it('hides section after clearing the task project', () => {
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditOrganizationField
                    {...(baseProps as any)}
                    fieldId="section"
                    editedTask={{ projectId: undefined, sectionId: undefined }}
                    task={{
                        id: 'task-1',
                        title: 'Task',
                        status: 'next',
                        projectId: 'project-1',
                        sectionId: 'section-1',
                        tags: [],
                        contexts: [],
                        createdAt: '2026-04-01T00:00:00.000Z',
                        updatedAt: '2026-04-01T00:00:00.000Z',
                    }}
                    projectSections={[{ id: 'section-1', projectId: 'project-1', title: 'Planning' }]}
                />
            );
        });

        expect(tree.toJSON()).toBeNull();
    });

    it('offers to create a person from an unmatched assignment value', async () => {
        const createAssignedToPerson = vi.fn().mockResolvedValue({ id: 'person-1', name: 'Morgan' });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <TaskEditOrganizationField
                    {...(baseProps as any)}
                    fieldId="assignedTo"
                    draft={{ ...baseProps.draft, assignedTo: 'Morgan' }}
                    assignedToSuggestions={[]}
                    createAssignedToPerson={createAssignedToPerson}
                />
            );
        });

        const createButton = tree.root.findByProps({ accessibilityLabel: 'New Person: Morgan' });
        await act(async () => {
            await createButton.props.onPress();
        });

        expect(createAssignedToPerson).toHaveBeenCalledWith('Morgan');
    });

    it('writes organization fields straight to the Task draft', () => {
        const setDraftField = vi.fn();

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditOrganizationField
                    {...(baseProps as any)}
                    fieldId="assignedTo"
                    setDraftField={setDraftField}
                />
            );
        });

        act(() => {
            tree.root.findByType(TextInput).props.onChangeText('Morgan');
        });

        expect(setDraftField).toHaveBeenCalledWith('assignedTo', 'Morgan');
    });

    it('renders the canonical priority flag beside each non-empty priority chip, but not None', () => {
        // baseProps is a deliberate partial fixture; the full renderer contract is
        // irrelevant to the priority chips under test here.
        const props = {
            ...baseProps,
            fieldId: 'priority' as const,
            priorityOptions: ['low', 'medium', 'high', 'urgent'],
        } as unknown as ComponentProps<typeof TaskEditOrganizationField>;
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(<TaskEditOrganizationField {...props} />);
        });

        const flag = (priority: string) => tree.root.findByProps({ testID: `priority-flag-${priority}` });
        expect(flag('low').props.color).toBe('#3b82f6');
        expect(flag('medium').props.color).toBe('#ca8a04');
        expect(flag('high').props.color).toBe('#f97316');
        expect(flag('urgent').props.color).toBe('#dc2626');
        // All flags render at 12pt.
        for (const priority of ['low', 'medium', 'high', 'urgent']) {
            expect(flag(priority).props.size).toBe(12);
        }
    });
});

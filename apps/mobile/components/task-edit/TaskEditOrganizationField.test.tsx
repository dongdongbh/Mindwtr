import React, { type ComponentProps } from 'react';
import { Text, TextInput, TouchableOpacity } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { Folder } from 'lucide-react-native';

import { FieldHeading } from './FieldHeading';
import { TaskEditOrganizationField } from './TaskEditOrganizationField';

const styles = {
    formGroup: {},
    label: {},
    dateRow: {},
    dateBtn: {},
    flex1: {},
    clearDateBtn: {},
    clearDateText: {},
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
    'task.destination': 'Destination',
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
    'common.none': 'None',
    'taskEdit.energyLevel': 'Energy Level',
    'energyLevel.low': 'Low',
    'energyLevel.high': 'High',
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
    destinationFields: ['project', 'area'],
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

    it('renders Destination as a field heading above a value box (#1449)', () => {
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

        const heading = tree.root.findByType(FieldHeading);
        expect(heading.props.label).toBe('Destination');
        expect(heading.props.icon).toBe(Folder);
        const valueBox = tree.root.findByProps({ accessibilityLabel: 'Destination: None' });
        expect(valueBox.props.accessibilityRole).toBe('button');
        expect(valueBox.findByType(Text).props.children).toBe('None');

        act(() => {
            valueBox.props.onPress();
        });

        expect(setShowProjectPicker).toHaveBeenCalledWith(true);
    });

    it.each([
        {
            label: 'Project before Area',
            destinationFields: ['project', 'area'],
            renderedField: 'project',
            hiddenField: 'area',
        },
        {
            label: 'Area before Project',
            destinationFields: ['area', 'project'],
            renderedField: 'area',
            hiddenField: 'project',
        },
        {
            label: 'Project only',
            destinationFields: ['project'],
            renderedField: 'project',
            hiddenField: 'area',
        },
        {
            label: 'Area only',
            destinationFields: ['area'],
            renderedField: 'area',
            hiddenField: 'project',
        },
    ])('renders Destination once at the first visible organization slot: $label', ({
        destinationFields,
        renderedField,
        hiddenField,
    }) => {
        let renderedTree!: renderer.ReactTestRenderer;
        let hiddenTree!: renderer.ReactTestRenderer;
        act(() => {
            renderedTree = renderer.create(
                <TaskEditOrganizationField
                    {...(baseProps as any)}
                    fieldId={renderedField}
                    destinationFields={destinationFields}
                />
            );
            hiddenTree = renderer.create(
                <TaskEditOrganizationField
                    {...(baseProps as any)}
                    fieldId={hiddenField}
                    destinationFields={destinationFields}
                />
            );
        });

        expect(renderedTree.root.findByProps({ accessibilityLabel: 'Destination: None' })).toBeTruthy();
        expect(hiddenTree.toJSON()).toBeNull();
    });

    it('does not render Destination when Project and Area are both hidden', () => {
        let projectTree!: renderer.ReactTestRenderer;
        let areaTree!: renderer.ReactTestRenderer;
        act(() => {
            projectTree = renderer.create(
                <TaskEditOrganizationField
                    {...(baseProps as any)}
                    fieldId="project"
                    destinationFields={[]}
                />
            );
            areaTree = renderer.create(
                <TaskEditOrganizationField
                    {...(baseProps as any)}
                    fieldId="area"
                    destinationFields={[]}
                />
            );
        });

        expect(projectTree.toJSON()).toBeNull();
        expect(areaTree.toJSON()).toBeNull();
    });

    it('shows an area selection in the combined destination row', () => {
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditOrganizationField
                    {...(baseProps as any)}
                    fieldId="project"
                    areas={[{ id: 'area-1', name: 'Home' }]}
                    draft={{ ...baseProps.draft, areaId: 'area-1' }}
                />
            );
        });

        expect(tree.root.findByProps({ accessibilityLabel: 'Destination: Home' })).toBeTruthy();
    });

    it('opens the section picker for a project task with no section (#1190)', () => {
        const setShowSectionPicker = vi.fn();
        const props = {
            ...baseProps,
            fieldId: 'section',
            draft: { ...baseProps.draft, projectId: 'project-1' },
            projectSections: [{ id: 'section-1', projectId: 'project-1', title: 'Planning' }],
            setShowSectionPicker,
        } as unknown as ComponentProps<typeof TaskEditOrganizationField>;
        let tree!: renderer.ReactTestRenderer;
        act(() => { tree = renderer.create(<TaskEditOrganizationField {...props} />); });
        try {
            expect(tree.root.findAllByType(Text).some((node) => node.props.children === 'No Section')).toBe(true);
            act(() => tree.root.findByType(TouchableOpacity).props.onPress());
            expect(setShowSectionPicker).toHaveBeenCalledWith(true);
        } finally {
            act(() => tree.unmount());
        }
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

    it('renders the priority None chip as an icon-only labelled button', () => {
        const setDraftField = vi.fn();
        const props = {
            ...baseProps,
            fieldId: 'priority' as const,
            priorityOptions: ['low', 'high'],
            setDraftField,
        } as unknown as ComponentProps<typeof TaskEditOrganizationField>;
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(<TaskEditOrganizationField {...props} />);
        });

        const noneChip = tree.root.findByProps({ accessibilityLabel: 'None' });
        expect(noneChip.props.accessibilityRole).toBe('button');
        // Icon-only: the previous "None" text is gone but the label survives.
        expect(noneChip.findAllByType(Text)).toHaveLength(0);
        expect(noneChip.findAll((node) => node.props?.size === 16).length).toBeGreaterThan(0);

        act(() => {
            noneChip.props.onPress();
        });
        expect(setDraftField).toHaveBeenCalledWith('priority', '');
    });

    it('pairs a decorative icon with each status chip label', () => {
        const props = {
            ...baseProps,
            fieldId: 'status' as const,
            editedTask: { status: 'next' },
            availableStatusOptions: ['next', 'done'],
        } as unknown as ComponentProps<typeof TaskEditOrganizationField>;
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(<TaskEditOrganizationField {...props} />);
        });

        const chip = (label: string) => tree.root.findByProps({ accessibilityLabel: label });
        // Every status chip carries a 14px leading icon and keeps its text label.
        expect(chip('Status: Next').findAll((node) => node.props?.size === 14).length).toBeGreaterThan(0);
        expect(chip('Status: Done').findAll((node) => node.props?.size === 14).length).toBeGreaterThan(0);
        expect(chip('Status: Done').findAllByType(Text).some((node) => node.props.children === 'Done')).toBe(true);
    });

    it('pairs a battery icon with each energy level chip label', () => {
        const props = {
            ...baseProps,
            fieldId: 'energyLevel' as const,
            editedTask: { energyLevel: 'low' },
            energyLevelOptions: ['low', 'high'],
        } as unknown as ComponentProps<typeof TaskEditOrganizationField>;
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(<TaskEditOrganizationField {...props} />);
        });

        const chipWithText = (label: string) => tree.root.findAll((node) => (
            typeof node.props?.onPress === 'function'
            && node.findAllByType(Text).some((textNode) => textNode.props.children === label)
        ))[0];

        // Energy level chips keep readable text labels and gain a 14px leading icon.
        expect(chipWithText('Low')?.findAll((node) => node.props?.size === 14).length).toBeGreaterThan(0);
        expect(chipWithText('High')?.findAll((node) => node.props?.size === 14).length).toBeGreaterThan(0);
    });
});

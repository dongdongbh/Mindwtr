import React from 'react';

import { TaskEditContentField } from './TaskEditContentField';
import type { TaskEditFieldRendererProps } from './TaskEditFieldRenderer.types';
import { TaskEditOrganizationField } from './TaskEditOrganizationField';
import { TaskEditScheduleField } from './TaskEditScheduleField';
import { TaskEditTokenField } from './TaskEditTokenField';

export type {
    PickerOption,
    ShowDatePickerMode,
    TaskEditFieldRendererProps,
    WeekdayButton,
} from './TaskEditFieldRenderer.types';

export function TaskEditFieldRenderer(props: TaskEditFieldRendererProps) {
    switch (props.fieldId) {
        case 'status':
        case 'project':
        case 'section':
        case 'area':
        case 'priority':
        case 'energyLevel':
        case 'assignedTo':
        case 'timeEstimate':
            return <TaskEditOrganizationField {...props} fieldId={props.fieldId} />;
        case 'contexts':
        case 'tags':
            return <TaskEditTokenField {...props} fieldId={props.fieldId} />;
        case 'recurrence':
        case 'startTime':
        case 'dueDate':
        case 'reviewAt':
            return <TaskEditScheduleField {...props} fieldId={props.fieldId} />;
        case 'description':
        case 'attachments':
        case 'checklist':
            return <TaskEditContentField {...props} fieldId={props.fieldId} />;
        default:
            return null;
    }
}

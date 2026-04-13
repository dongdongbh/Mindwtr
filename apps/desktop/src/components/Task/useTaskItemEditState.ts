import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import type { Task, TaskPriority, TaskStatus, TimeEstimate, RecurrenceRule, RecurrenceStrategy } from '@mindwtr/core';
import {
    getRecurrenceRuleValue,
    getRecurrenceStrategyValue,
    getRecurrenceRRuleValue,
    toDateTimeLocalValue,
} from './task-item-helpers';

type UseTaskItemEditStateOptions = {
    task: Task;
    resetAttachmentState: (attachments?: Task['attachments']) => void;
};

type TaskItemEditState = {
    editTitle: string;
    setEditTitle: (value: string) => void;
    editDueDate: string;
    setEditDueDate: (value: string) => void;
    editStartTime: string;
    setEditStartTime: (value: string) => void;
    editProjectId: string;
    setEditProjectId: (value: string) => void;
    editSectionId: string;
    setEditSectionId: (value: string) => void;
    editAreaId: string;
    setEditAreaId: (value: string) => void;
    editStatus: TaskStatus;
    setEditStatus: (value: TaskStatus) => void;
    editContexts: string;
    setEditContexts: (value: string) => void;
    editTags: string;
    setEditTags: (value: string) => void;
    editDescription: string;
    setEditDescription: (value: string) => void;
    editLocation: string;
    setEditLocation: (value: string) => void;
    editRecurrence: RecurrenceRule | '';
    setEditRecurrence: (value: RecurrenceRule | '') => void;
    editRecurrenceStrategy: RecurrenceStrategy;
    setEditRecurrenceStrategy: (value: RecurrenceStrategy) => void;
    editRecurrenceRRule: string;
    setEditRecurrenceRRule: (value: string) => void;
    editTimeEstimate: TimeEstimate | '';
    setEditTimeEstimate: (value: TimeEstimate | '') => void;
    editPriority: TaskPriority | '';
    setEditPriority: (value: TaskPriority | '') => void;
    editEnergyLevel: NonNullable<Task['energyLevel']> | '';
    setEditEnergyLevel: (value: NonNullable<Task['energyLevel']> | '') => void;
    editAssignedTo: string;
    setEditAssignedTo: (value: string) => void;
    editReviewAt: string;
    setEditReviewAt: (value: string) => void;
    showDescriptionPreview: boolean;
    setShowDescriptionPreview: Dispatch<SetStateAction<boolean>>;
    resetEditState: () => void;
};

export function useTaskItemEditState({
    task,
    resetAttachmentState,
}: UseTaskItemEditStateOptions): TaskItemEditState {
    const [editTitle, setEditTitle] = useState(task.title);
    const [editDueDate, setEditDueDate] = useState(toDateTimeLocalValue(task.dueDate));
    const [editStartTime, setEditStartTime] = useState(toDateTimeLocalValue(task.startTime));
    const [editProjectId, setEditProjectId] = useState(task.projectId || '');
    const [editSectionId, setEditSectionId] = useState(task.sectionId || '');
    const [editAreaId, setEditAreaId] = useState(task.areaId || '');
    const [editStatus, setEditStatus] = useState<TaskStatus>(task.status);
    const [editContexts, setEditContexts] = useState(task.contexts?.join(', ') || '');
    const [editTags, setEditTags] = useState(task.tags?.join(', ') || '');
    const [editDescription, setEditDescription] = useState(task.description || '');
    const [showDescriptionPreview, setShowDescriptionPreview] = useState(false);
    const [editLocation, setEditLocation] = useState(task.location || '');
    const [editRecurrence, setEditRecurrence] = useState<RecurrenceRule | ''>(
        getRecurrenceRuleValue(task.recurrence),
    );
    const [editRecurrenceStrategy, setEditRecurrenceStrategy] = useState<RecurrenceStrategy>(
        getRecurrenceStrategyValue(task.recurrence),
    );
    const [editRecurrenceRRule, setEditRecurrenceRRule] = useState<string>(
        getRecurrenceRRuleValue(task.recurrence),
    );
    const [editTimeEstimate, setEditTimeEstimate] = useState<TimeEstimate | ''>(task.timeEstimate || '');
    const [editPriority, setEditPriority] = useState<TaskPriority | ''>(task.priority || '');
    const [editEnergyLevel, setEditEnergyLevel] = useState<NonNullable<Task['energyLevel']> | ''>(task.energyLevel || '');
    const [editAssignedTo, setEditAssignedTo] = useState(task.assignedTo || '');
    const [editReviewAt, setEditReviewAt] = useState(toDateTimeLocalValue(task.reviewAt));

    const resetEditState = useCallback(() => {
        setEditTitle(task.title);
        setEditDueDate(toDateTimeLocalValue(task.dueDate));
        setEditStartTime(toDateTimeLocalValue(task.startTime));
        setEditProjectId(task.projectId || '');
        setEditSectionId(task.sectionId || '');
        setEditAreaId(task.areaId || '');
        setEditStatus(task.status);
        setEditContexts(task.contexts?.join(', ') || '');
        setEditTags(task.tags?.join(', ') || '');
        setEditDescription(task.description || '');
        setEditLocation(task.location || '');
        setEditRecurrence(getRecurrenceRuleValue(task.recurrence));
        setEditRecurrenceStrategy(getRecurrenceStrategyValue(task.recurrence));
        setEditRecurrenceRRule(getRecurrenceRRuleValue(task.recurrence));
        setEditTimeEstimate(task.timeEstimate || '');
        setEditPriority(task.priority || '');
        setEditEnergyLevel(task.energyLevel || '');
        setEditAssignedTo(task.assignedTo || '');
        setEditReviewAt(toDateTimeLocalValue(task.reviewAt));
        resetAttachmentState(task.attachments);
        setShowDescriptionPreview(false);
    }, [resetAttachmentState, task]);

    return {
        editTitle,
        setEditTitle,
        editDueDate,
        setEditDueDate,
        editStartTime,
        setEditStartTime,
        editProjectId,
        setEditProjectId,
        editSectionId,
        setEditSectionId,
        editAreaId,
        setEditAreaId,
        editStatus,
        setEditStatus,
        editContexts,
        setEditContexts,
        editTags,
        setEditTags,
        editDescription,
        setEditDescription,
        editLocation,
        setEditLocation,
        editRecurrence,
        setEditRecurrence,
        editRecurrenceStrategy,
        setEditRecurrenceStrategy,
        editRecurrenceRRule,
        setEditRecurrenceRRule,
        editTimeEstimate,
        setEditTimeEstimate,
        editPriority,
        setEditPriority,
        editEnergyLevel,
        setEditEnergyLevel,
        editAssignedTo,
        setEditAssignedTo,
        editReviewAt,
        setEditReviewAt,
        showDescriptionPreview,
        setShowDescriptionPreview,
        resetEditState,
    };
}

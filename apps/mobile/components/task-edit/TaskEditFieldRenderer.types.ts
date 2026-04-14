import type React from 'react';
import type { TextInput } from 'react-native';
import type { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import type {
    Attachment,
    Area,
    Project,
    RecurrenceByDay,
    RecurrenceRule,
    RecurrenceStrategy,
    RecurrenceWeekday,
    Section,
    Task,
    TaskEditorFieldId,
    TaskEnergyLevel,
    TaskPriority,
    TaskStatus,
    TimeEstimate,
    MarkdownSelection,
    MarkdownToolbarActionId,
    MarkdownToolbarResult,
} from '@mindwtr/core';
import type { ThemeColors } from '@/hooks/use-theme-colors';

import type { SetEditedTask } from './use-task-edit-state';

export type ShowDatePickerMode = 'start' | 'start-time' | 'due' | 'due-time' | 'review' | null;

export type PickerOption<T extends string> = {
    value: T | '';
    label: string;
};

export type WeekdayButton = {
    key: RecurrenceWeekday;
    label: string;
};

export type TaskEditFieldRendererProps = {
    fieldId: TaskEditorFieldId;
    addFileAttachment: () => void | Promise<void>;
    addImageAttachment: () => void | Promise<void>;
    applyContextSuggestion: (token: string) => void;
    applyTagSuggestion: (token: string) => void;
    areas: Area[];
    availableStatusOptions: TaskStatus[];
    commitContextDraft: () => void;
    commitTagDraft: () => void;
    contextInputDraft: string;
    contextTokenSuggestions: string[];
    customWeekdays: RecurrenceWeekday[];
    dailyInterval: number;
    descriptionDraft: string;
    descriptionInputRef: React.RefObject<TextInput | null>;
    descriptionSelection: MarkdownSelection;
    setDescriptionSelection: (selection: MarkdownSelection) => void;
    descriptionUndoDepth: number;
    isDescriptionInputFocused: boolean;
    setIsDescriptionInputFocused: React.Dispatch<React.SetStateAction<boolean>>;
    handleDescriptionChange: (text: string) => void;
    handleDescriptionUndo: () => MarkdownSelection | undefined;
    handleDescriptionApplyAction: (actionId: MarkdownToolbarActionId, selection: MarkdownSelection) => MarkdownToolbarResult;
    applyDescriptionResult: (result: MarkdownToolbarResult) => void;
    openDescriptionExpandedEditor: () => void;
    downloadAttachment: (attachment: Attachment) => void | Promise<void>;
    editedTask: Partial<Task>;
    formatDate: (dateStr?: string) => string;
    formatDueDate: (dateStr?: string) => string;
    frequentContextSuggestions: string[];
    frequentTagSuggestions: string[];
    getSafePickerDateValue: (dateStr?: string) => Date;
    handleInputFocus: (targetInput?: number | string) => void;
    handleResetChecklist: () => void;
    language: string;
    monthlyPattern: 'date' | 'custom';
    onDateChange: (event: DateTimePickerEvent, selectedDate?: Date) => void;
    openAttachment: (attachment: Attachment) => void | Promise<void>;
    openCustomRecurrence: () => void;
    pendingDueDate: Date | null;
    pendingStartDate: Date | null;
    prioritiesEnabled: boolean;
    energyLevelOptions: TaskEnergyLevel[];
    priorityOptions: TaskPriority[];
    projects: Project[];
    projectSections: Section[];
    recurrenceOptions: PickerOption<RecurrenceRule>[];
    recurrenceRRuleValue: string;
    recurrenceRuleValue: RecurrenceRule | '';
    recurrenceStrategyValue: RecurrenceStrategy;
    recurrenceWeekdayButtons: WeekdayButton[];
    removeAttachment: (attachmentId: string) => void | Promise<void>;
    selectedContextTokens: Set<string>;
    selectedTagTokens: Set<string>;
    setCustomWeekdays: React.Dispatch<React.SetStateAction<RecurrenceWeekday[]>>;
    setEditedTask: SetEditedTask;
    setIsContextInputFocused: React.Dispatch<React.SetStateAction<boolean>>;
    setIsTagInputFocused: React.Dispatch<React.SetStateAction<boolean>>;
    setLinkInputTouched: React.Dispatch<React.SetStateAction<boolean>>;
    setLinkModalVisible: React.Dispatch<React.SetStateAction<boolean>>;
    setShowAreaPicker: React.Dispatch<React.SetStateAction<boolean>>;
    setShowDatePicker: React.Dispatch<React.SetStateAction<ShowDatePickerMode>>;
    setShowDescriptionPreview: React.Dispatch<React.SetStateAction<boolean>>;
    setShowProjectPicker: React.Dispatch<React.SetStateAction<boolean>>;
    setShowSectionPicker: React.Dispatch<React.SetStateAction<boolean>>;
    showDatePicker: ShowDatePickerMode;
    showDescriptionPreview: boolean;
    styles: Record<string, any>;
    tagInputDraft: string;
    tagTokenSuggestions: string[];
    task: Task | null;
    t: (key: string) => string;
    tc: ThemeColors;
    timeEstimateOptions: PickerOption<TimeEstimate>[];
    timeEstimatesEnabled: boolean;
    titleDraft: string;
    toggleQuickContextToken: (token: string) => void;
    toggleQuickTagToken: (token: string) => void;
    updateContextInput: (text: string) => void;
    updateTagInput: (text: string) => void;
    visibleAttachments: Attachment[];
};

export type MonthlyRecurrenceByDay = `${'1' | '2' | '3' | '4' | '-1'}${RecurrenceWeekday}`;
export type { RecurrenceByDay };

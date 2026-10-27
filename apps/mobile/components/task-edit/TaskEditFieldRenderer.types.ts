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
    MarkdownToolbarResult,
    Person,
} from '@mindwtr/core';
import type { TaskDraft, TaskDraftSetter } from '@mindwtr/core/task-draft';
import type { ThemeColors } from '@/hooks/use-theme-colors';

export type ShowDatePickerMode = 'start' | 'start-time' | 'due' | 'due-time' | 'review' | 'review-time' | 'recurrence-end' | null;

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
    applyAssignedToSuggestion: (value: string) => void;
    applyContextSuggestion: (token: string) => void;
    applyTagSuggestion: (token: string) => void;
    areas: Area[];
    assignedToSuggestions: string[];
    availableStatusOptions: TaskStatus[];
    applyQuickDate: (mode: 'start' | 'due' | 'review', selectedDate: Date | null) => void;
    commitContextDraft: () => void;
    commitTagDraft: () => void;
    checklist: Task['checklist'];
    contextInputDraft: string;
    contextTokenSuggestions: string[];
    createAssignedToPerson: (name: string) => Promise<Person | null>;
    customWeekdays: RecurrenceWeekday[];
    dailyInterval: number;
    descriptionDraft: string;
    descriptionInputRef: React.RefObject<TextInput | null>;
    descriptionSelection: MarkdownSelection;
    descriptionSelectionRestorePending: boolean;
    setDescriptionSelection: (selection: MarkdownSelection) => void;
    descriptionToolbarInteractionUntilRef: React.MutableRefObject<number>;
    isDescriptionInputFocused: boolean;
    setIsDescriptionInputFocused: React.Dispatch<React.SetStateAction<boolean>>;
    handleDescriptionChange: (text: string) => void;
    handleDescriptionKeyPress: (event: any) => void;
    applyDescriptionResult: (result: MarkdownToolbarResult) => void;
    applyChecklistUpdate: (checklist: NonNullable<Task['checklist']>) => void;
    openDescriptionExpandedEditor: () => void;
    downloadAttachment: (attachment: Attachment) => void | Promise<void>;
    draft: TaskDraft | null;
    editLinkAttachment: (attachment: Attachment) => void | Promise<void>;
    formatDate: (dateStr?: string) => string;
    formatDueDate: (dateStr?: string) => string;
    frequentContextSuggestions: string[];
    frequentTagSuggestions: string[];
    getSafePickerDateValue: (dateStr?: string) => Date;
    handleInputFocus: (targetInput?: number | string) => void;
    handleResetChecklist: () => void;
    language: string;
    monthlyPattern: 'date' | 'custom';
    destinationFields: TaskEditorFieldId[];
    onDateChange: (event: DateTimePickerEvent, selectedDate?: Date) => void;
    openAttachment: (attachment: Attachment) => void | Promise<void>;
    openAddLinkAttachment: () => void;
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
    requestBackdatedCompletion: () => void;
    requestStatusChange: (status: TaskStatus) => void;
    removeAttachment: (attachmentId: string) => void | Promise<void>;
    selectedContextTokens: Set<string>;
    selectedTagTokens: Set<string>;
    setCustomWeekdays: React.Dispatch<React.SetStateAction<RecurrenceWeekday[]>>;
    setDraftField: TaskDraftSetter;
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
    timeSpentEnabled: boolean;
    titleDraft: string;
    toggleQuickContextToken: (token: string) => void;
    toggleQuickTagToken: (token: string) => void;
    updateContextInput: (text: string) => void;
    updateTagInput: (text: string) => void;
    visibleAttachments: Attachment[];
};

export type MonthlyRecurrenceByDay = `${'1' | '2' | '3' | '4' | '-1'}${RecurrenceWeekday}`;
export type { RecurrenceByDay };

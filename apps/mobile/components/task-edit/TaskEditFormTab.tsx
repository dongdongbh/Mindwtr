import React from 'react';
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    ScrollView,
    KeyboardAvoidingView,
    Platform,
    ActivityIndicator,
    Keyboard,
    Dimensions,
    UIManager,
    findNodeHandle,
} from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import type { Task, TaskEditorFieldId, TaskEditorSectionId, TimeEstimate } from '@mindwtr/core';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { CollapsibleSection } from './CollapsibleSection';

type CopilotSuggestion = { context?: string; timeEstimate?: TimeEstimate; tags?: string[] };

type TaskEditFormTabProps = {
    t: (key: string) => string;
    tc: ThemeColors;
    styles: Record<string, any>;
    inputStyle: Record<string, any>;
    editedTask: Partial<Task>;
    setEditedTask: React.Dispatch<React.SetStateAction<Partial<Task>>>;
    aiEnabled: boolean;
    isAIWorking: boolean;
    handleAIClarify: () => void;
    handleAIBreakdown: () => void;
    copilotSuggestion: CopilotSuggestion | null;
    copilotApplied: boolean;
    applyCopilotSuggestion: () => void;
    copilotContext: string | undefined;
    copilotEstimate: TimeEstimate | undefined;
    copilotTags: string[];
    timeEstimatesEnabled: boolean;
    renderField: (fieldId: TaskEditorFieldId) => React.ReactNode;
    basicFields: TaskEditorFieldId[];
    schedulingFields: TaskEditorFieldId[];
    organizationFields: TaskEditorFieldId[];
    detailsFields: TaskEditorFieldId[];
    sectionOpenDefaults: Record<TaskEditorSectionId, boolean>;
    showDatePicker: string | null;
    pendingStartDate: Date | null;
    pendingDueDate: Date | null;
    getSafePickerDateValue: (dateStr?: string) => Date;
    onDateChange: (event: DateTimePickerEvent, selectedDate?: Date) => void;
    containerWidth: number;
    textDirectionStyle: Record<string, any>;
    titleDraft: string;
    onTitleDraftChange: (text: string) => void;
    registerScrollToEnd?: (handler: ((targetInput?: number | string) => void) | null) => void;
    formResetKey?: string;
};

export function TaskEditFormTab({
    t,
    tc,
    styles,
    inputStyle,
    editedTask,
    setEditedTask,
    aiEnabled,
    isAIWorking,
    handleAIClarify,
    handleAIBreakdown,
    copilotSuggestion,
    copilotApplied,
    applyCopilotSuggestion,
    copilotContext,
    copilotEstimate,
    copilotTags,
    timeEstimatesEnabled,
    renderField,
    basicFields,
    schedulingFields,
    organizationFields,
    detailsFields,
    sectionOpenDefaults,
    showDatePicker,
    pendingStartDate,
    pendingDueDate,
    getSafePickerDateValue,
    onDateChange,
    containerWidth,
    textDirectionStyle,
    titleDraft,
    onTitleDraftChange,
    registerScrollToEnd,
    formResetKey,
}: TaskEditFormTabProps) {
    const [titleFocused, setTitleFocused] = React.useState(false);
    const formScrollRef = React.useRef<ScrollView | null>(null);
    const formScrollOffsetRef = React.useRef(0);
    const keyboardTopRef = React.useRef(Dimensions.get('window').height);

    React.useEffect(() => {
        if (typeof Keyboard?.addListener !== 'function') return;
        const updateKeyboardTop = (event: { endCoordinates?: { screenY?: number; height?: number } }) => {
            const windowHeight = Dimensions.get('window').height;
            const endCoords = event.endCoordinates;
            if (typeof endCoords?.screenY === 'number') {
                keyboardTopRef.current = endCoords.screenY;
                return;
            }
            if (typeof endCoords?.height === 'number') {
                keyboardTopRef.current = Math.max(0, windowHeight - endCoords.height);
                return;
            }
            keyboardTopRef.current = windowHeight;
        };
        const resetKeyboardTop = () => {
            keyboardTopRef.current = Dimensions.get('window').height;
        };
        const showListener = Keyboard.addListener('keyboardDidShow', updateKeyboardTop);
        const changeListener = Keyboard.addListener('keyboardDidChangeFrame', updateKeyboardTop);
        const hideListener = Keyboard.addListener('keyboardDidHide', resetKeyboardTop);
        return () => {
            showListener.remove();
            changeListener.remove();
            hideListener.remove();
        };
    }, []);

    const scrollDownForKeyboard = React.useCallback((amount = 180) => {
        const nextOffset = Math.max(0, formScrollOffsetRef.current + amount);
        formScrollRef.current?.scrollTo({ y: nextOffset, animated: true });
    }, []);

    const scrollHandleIntoView = React.useCallback((targetHandle: number) => {
        const scrollView = formScrollRef.current;
        if (!scrollView) return;

        const scrollHandle = findNodeHandle(scrollView);
        if (!scrollHandle) return;

        UIManager.measureInWindow(targetHandle, (_x, targetY, _w, targetH) => {
            if (!Number.isFinite(targetY) || !Number.isFinite(targetH)) return;
            UIManager.measureInWindow(scrollHandle, (_sx, scrollY, _sw, scrollH) => {
                if (!Number.isFinite(scrollY) || !Number.isFinite(scrollH)) return;
                const topPadding = 12;
                const bottomPadding = Platform.OS === 'ios' ? 44 : 12;
                const visibleTop = scrollY + topPadding;
                const keyboardTop = keyboardTopRef.current;
                const visibleBottom = Math.min(scrollY + scrollH - bottomPadding, keyboardTop - bottomPadding);
                const targetTop = targetY;
                const targetBottom = targetY + targetH;

                if (targetBottom > visibleBottom) {
                    const delta = targetBottom - visibleBottom;
                    const nextOffset = Math.max(0, formScrollOffsetRef.current + delta);
                    formScrollRef.current?.scrollTo({ y: nextOffset, animated: true });
                    return;
                }

                if (targetTop < visibleTop) {
                    const delta = visibleTop - targetTop;
                    const nextOffset = Math.max(0, formScrollOffsetRef.current - delta);
                    formScrollRef.current?.scrollTo({ y: nextOffset, animated: true });
                }
            });
        });
    }, []);

    const ensureInputVisible = React.useCallback((targetInput?: number | string) => {
        const normalizedHandle = typeof targetInput === 'number'
            ? targetInput
            : typeof targetInput === 'string'
                ? Number(targetInput)
                : NaN;
        const hasTargetHandle = Number.isFinite(normalizedHandle) && normalizedHandle > 0;
        if (!hasTargetHandle) {
            scrollDownForKeyboard(Platform.OS === 'ios' ? 140 : 96);
            return;
        }
        requestAnimationFrame(() => {
            scrollHandleIntoView(normalizedHandle);
        });
    }, [scrollDownForKeyboard, scrollHandleIntoView]);

    React.useEffect(() => {
        if (!registerScrollToEnd) return;
        registerScrollToEnd((targetInput) => {
            ensureInputVisible(targetInput);
        });
        return () => registerScrollToEnd(null);
    }, [ensureInputVisible, registerScrollToEnd]);
    const countFilledFields = (fieldIds: TaskEditorFieldId[]): number => {
        return fieldIds.filter((fieldId) => {
            switch (fieldId) {
                case 'startTime':
                    return Boolean(editedTask.startTime);
                case 'recurrence':
                    return Boolean(editedTask.recurrence);
                case 'reviewAt':
                    return Boolean(editedTask.reviewAt);
                case 'contexts':
                    return (editedTask.contexts?.length ?? 0) > 0;
                case 'tags':
                    return (editedTask.tags?.length ?? 0) > 0;
                case 'priority':
                    return Boolean(editedTask.priority);
                case 'timeEstimate':
                    return Boolean(editedTask.timeEstimate);
                case 'description':
                    return Boolean(String(editedTask.description ?? '').trim());
                case 'checklist':
                    return (editedTask.checklist?.length ?? 0) > 0;
                case 'attachments':
                    return (editedTask.attachments || []).some((attachment) => !attachment.deletedAt);
                default:
                    return false;
            }
        }).length;
    };

    return (
        <View style={[styles.tabPage, { width: containerWidth || '100%' }]}>
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={{ flex: 1 }}
                keyboardVerticalOffset={0}
            >
                <ScrollView
                    ref={formScrollRef}
                    style={styles.content}
                    contentContainerStyle={styles.contentContainer}
                    keyboardShouldPersistTaps="handled"
                    onScroll={(event) => {
                        formScrollOffsetRef.current = event.nativeEvent.contentOffset.y;
                    }}
                    scrollEventThrottle={16}
                    nestedScrollEnabled
                >
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.titleLabel')}</Text>
                        <TextInput
                            style={[styles.input, inputStyle, textDirectionStyle]}
                            value={titleDraft}
                            onChangeText={(text) => onTitleDraftChange(text)}
                            placeholderTextColor={tc.secondaryText}
                            onFocus={(event) => {
                                setTitleFocused(true);
                                ensureInputVisible(event.nativeEvent.target);
                            }}
                            onBlur={() => setTitleFocused(false)}
                            selection={titleFocused ? undefined : { start: 0, end: 0 }}
                        />
                    </View>
                    {aiEnabled && (
                        <View style={styles.aiRow}>
                            <TouchableOpacity
                                style={[styles.aiButton, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                                onPress={handleAIClarify}
                                disabled={isAIWorking}
                            >
                                <Text style={[styles.aiButtonText, { color: tc.tint }]}>{t('taskEdit.aiClarify')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[styles.aiButton, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                                onPress={handleAIBreakdown}
                                disabled={isAIWorking}
                            >
                                <Text style={[styles.aiButtonText, { color: tc.tint }]}>{t('taskEdit.aiBreakdown')}</Text>
                            </TouchableOpacity>
                            {isAIWorking && (
                                <View style={styles.aiWorking}>
                                    <ActivityIndicator size="small" color={tc.tint} />
                                    <Text style={[styles.aiWorkingText, { color: tc.secondaryText }]}>
                                        {t('ai.working') || 'Working…'}
                                    </Text>
                                </View>
                            )}
                        </View>
                    )}
                    {aiEnabled && copilotSuggestion && !copilotApplied && (
                        <TouchableOpacity
                            style={[styles.copilotPill, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                            onPress={applyCopilotSuggestion}
                        >
                            <Text style={[styles.copilotText, { color: tc.text }]}>
                                ✨ {t('copilot.suggested')}{' '}
                                {copilotSuggestion.context ? `${copilotSuggestion.context} ` : ''}
                                {timeEstimatesEnabled && copilotSuggestion.timeEstimate ? `${copilotSuggestion.timeEstimate}` : ''}
                                {copilotSuggestion.tags?.length ? copilotSuggestion.tags.join(' ') : ''}
                            </Text>
                            <Text style={[styles.copilotHint, { color: tc.secondaryText }]}>
                                {t('copilot.applyHint')}
                            </Text>
                        </TouchableOpacity>
                    )}
                    {aiEnabled && copilotApplied && (
                        <View style={[styles.copilotPill, { borderColor: tc.border, backgroundColor: tc.filterBg }]}>
                            <Text style={[styles.copilotText, { color: tc.text }]}>
                                ✅ {t('copilot.applied')}{' '}
                                {copilotContext ? `${copilotContext} ` : ''}
                                {timeEstimatesEnabled && copilotEstimate ? `${copilotEstimate}` : ''}
                                {copilotTags.length ? copilotTags.join(' ') : ''}
                            </Text>
                        </View>
                    )}
                    {basicFields.map((fieldId) => (
                        <React.Fragment key={fieldId}>{renderField(fieldId)}</React.Fragment>
                    ))}

                    <CollapsibleSection
                        resetKey={`${formResetKey ?? 'task'}:scheduling`}
                        title={t('taskEdit.scheduling')}
                        badge={countFilledFields(schedulingFields)}
                        defaultExpanded={sectionOpenDefaults.scheduling || countFilledFields(schedulingFields) > 0}
                    >
                        {schedulingFields.length === 0 ? (
                            <View style={[styles.emptySectionHint, { borderColor: tc.border, backgroundColor: tc.filterBg }]}>
                                <Text style={[styles.emptySectionHintText, { color: tc.secondaryText }]}>
                                    {t('taskEdit.schedulingEmpty')}
                                </Text>
                            </View>
                        ) : (
                            schedulingFields.map((fieldId) => (
                                <React.Fragment key={fieldId}>{renderField(fieldId)}</React.Fragment>
                            ))
                        )}
                    </CollapsibleSection>

                    <CollapsibleSection
                        resetKey={`${formResetKey ?? 'task'}:organization`}
                        title={t('taskEdit.organization')}
                        badge={countFilledFields(organizationFields)}
                        defaultExpanded={sectionOpenDefaults.organization || countFilledFields(organizationFields) > 0}
                    >
                        {organizationFields.length === 0 ? (
                            <View style={[styles.emptySectionHint, { borderColor: tc.border, backgroundColor: tc.filterBg }]}>
                                <Text style={[styles.emptySectionHintText, { color: tc.secondaryText }]}>
                                    {t('taskEdit.organizationEmpty')}
                                </Text>
                            </View>
                        ) : (
                            organizationFields.map((fieldId) => (
                                <React.Fragment key={fieldId}>{renderField(fieldId)}</React.Fragment>
                            ))
                        )}
                    </CollapsibleSection>

                    <CollapsibleSection
                        resetKey={`${formResetKey ?? 'task'}:details`}
                        title={t('taskEdit.details')}
                        badge={countFilledFields(detailsFields)}
                        defaultExpanded={
                            sectionOpenDefaults.details
                            || countFilledFields(detailsFields) > 0
                            || detailsFields.includes('description')
                            || detailsFields.includes('checklist')
                        }
                    >
                        {detailsFields.length === 0 ? (
                            <View style={[styles.emptySectionHint, { borderColor: tc.border, backgroundColor: tc.filterBg }]}>
                                <Text style={[styles.emptySectionHintText, { color: tc.secondaryText }]}>
                                    {t('taskEdit.detailsEmpty')}
                                </Text>
                            </View>
                        ) : (
                            detailsFields.map((fieldId) => (
                                <React.Fragment key={fieldId}>{renderField(fieldId)}</React.Fragment>
                            ))
                        )}
                    </CollapsibleSection>

                    <View style={{ height: 100 }} />

                    {showDatePicker && Platform.OS === 'android' && (
                        <View>
                            <DateTimePicker
                                value={(() => {
                                    if (showDatePicker === 'start') return getSafePickerDateValue(editedTask.startTime);
                                    if (showDatePicker === 'start-time') return pendingStartDate ?? getSafePickerDateValue(editedTask.startTime);
                                    if (showDatePicker === 'review') return getSafePickerDateValue(editedTask.reviewAt);
                                    if (showDatePicker === 'due-time') return pendingDueDate ?? getSafePickerDateValue(editedTask.dueDate);
                                    return getSafePickerDateValue(editedTask.dueDate);
                                })()}
                                mode={
                                    showDatePicker === 'start-time' || showDatePicker === 'due-time'
                                        ? 'time'
                                        : 'date'
                                }
                                display="default"
                                onChange={onDateChange}
                            />
                        </View>
                    )}
                </ScrollView>
            </KeyboardAvoidingView>
        </View>
    );
}

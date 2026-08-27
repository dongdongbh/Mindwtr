import React from 'react';
import {
    Alert,
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
    type ScrollViewProps,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { parseRRuleString, tFallback, type Attachment, type Task, type TaskEditorFieldId, type TaskEditorSectionId, type TimeEstimate, type ViewSectionDefinition } from '@mindwtr/core';
import type { TaskDraft } from '@mindwtr/core/task-draft';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { CollapsibleSection } from './CollapsibleSection';
import type { CopilotPart } from './use-task-edit-copilot';

type TaskEditFormTabProps = {
    t: (key: string) => string;
    tc: ThemeColors;
    styles: Record<string, any>;
    inputStyle: Record<string, any>;
    attachments: Attachment[] | undefined;
    checklist: Task['checklist'];
    draft: TaskDraft | null;
    aiEnabled: boolean;
    isAIWorking: boolean;
    handleAIClarify: () => void;
    handleAIBreakdown: () => void;
    pendingCopilotParts: CopilotPart[];
    applyCopilotPart: (part: CopilotPart) => void;
    applyCopilotSuggestion: () => void;
    copilotContext: string | undefined;
    copilotEstimate: TimeEstimate | undefined;
    copilotTags: string[];
    timeEstimatesEnabled: boolean;
    renderField: (fieldId: TaskEditorFieldId) => React.ReactNode;
    basicFields: TaskEditorFieldId[];
    somedaySections?: readonly ViewSectionDefinition[];
    selectedSomedaySectionId?: string;
    onSomedaySectionChange?: (sectionId: string | undefined) => void;
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
    onInputFocusTracked?: (targetInput?: number | string) => void;
    onTitleInputFocusChange?: (focused: boolean) => void;
    registerScrollToEnd?: (handler: ((targetInput?: number | string) => void) | null) => void;
    formResetKey?: string;
    suspendKeyboardHandling?: boolean;
    accessibilityHidden?: boolean;
};

const TASK_FORM_BASE_BOTTOM_PADDING = 32;
// Fraction of the space above the keyboard to reveal from a focused input's top edge.
const DESCRIPTION_REVEAL_FRACTION = 0.4;

function TaskEditFormTabComponent({
    t,
    tc,
    styles,
    inputStyle,
    attachments,
    checklist,
    draft,
    aiEnabled,
    isAIWorking,
    handleAIClarify,
    handleAIBreakdown,
    pendingCopilotParts,
    applyCopilotPart,
    applyCopilotSuggestion,
    copilotContext,
    copilotEstimate,
    copilotTags,
    timeEstimatesEnabled,
    renderField,
    basicFields,
    somedaySections = [],
    selectedSomedaySectionId,
    onSomedaySectionChange,
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
    onInputFocusTracked,
    onTitleInputFocusChange,
    registerScrollToEnd,
    formResetKey,
    suspendKeyboardHandling = false,
    accessibilityHidden = false,
}: TaskEditFormTabProps) {
    const [titleFocused, setTitleFocused] = React.useState(false);
    const formScrollRef = React.useRef<ScrollView | null>(null);
    const formScrollOffsetRef = React.useRef(0);
    const keyboardTopRef = React.useRef(Dimensions.get('window').height);
    const keyboardVisibleRef = React.useRef(false);
    // Android focuses before `keyboardDidShow`, so a focus scroll requested with no
    // keyboard metrics yet is stashed here and replayed once the keyboard opens (#921).
    const pendingScrollHandleRef = React.useRef<number | null>(null);
    const [keyboardBottomInset, setKeyboardBottomInset] = React.useState(0);
    const androidScrollViewFocusProps: Partial<ScrollViewProps> & { scrollsChildToFocus?: boolean } = (
        Platform.OS === 'android' ? { scrollsChildToFocus: false } : {}
    );
    const aiWorkingLabel = t('ai.working');
    const aiWorkingText = aiWorkingLabel === 'ai.working' ? 'Working...' : aiWorkingLabel;
    const hasAppliedCopilot = Boolean(copilotContext) || Boolean(copilotEstimate) || copilotTags.length > 0;
    const taskEditorLayoutHelpLabel = tFallback(t, 'taskEdit.editorLayoutHelpLabel', 'Editor layout help');
    const taskEditorLayoutHelpText = tFallback(
        t,
        'taskEdit.editorLayoutHelpText',
        'You can customize which fields appear here in Settings -> GTD -> Task Editor Layout.'
    );
    const showTaskEditorLayoutHelp = React.useCallback(() => {
        Alert.alert(taskEditorLayoutHelpLabel, taskEditorLayoutHelpText);
    }, [taskEditorLayoutHelpLabel, taskEditorLayoutHelpText]);

    React.useEffect(() => {
        formScrollOffsetRef.current = 0;
        const resetScroll = () => {
            formScrollRef.current?.scrollTo({ y: 0, animated: false });
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(resetScroll);
        } else {
            setTimeout(resetScroll, 0);
        }
    }, [formResetKey]);

    const scrollHandleIntoView = React.useCallback((targetHandle: number) => {
        const scrollView = formScrollRef.current;
        if (!scrollView) return;

        const scrollHandle = findNodeHandle(scrollView);
        if (!scrollHandle) return;

        UIManager.measureInWindow(targetHandle, (_x, targetY, _w, targetH) => {
            if (!Number.isFinite(targetY) || !Number.isFinite(targetH)) return;
            UIManager.measureInWindow(scrollHandle, (_sx, scrollY, _sw, scrollH) => {
                if (!Number.isFinite(scrollY) || !Number.isFinite(scrollH)) return;
                const visibleTop = scrollY;
                const keyboardTop = keyboardTopRef.current;
                const visibleBottom = Math.min(scrollY + scrollH, keyboardTop);
                const visibleHeight = Math.max(0, visibleBottom - visibleTop);
                const bottomClearance = visibleHeight * 0.18;
                const effectiveVisibleBottom = visibleBottom - bottomClearance;
                const targetTop = targetY;
                // Reveal at most this much of the target measured from its TOP. A tall input
                // (the description block) would otherwise scroll its whole height into view and
                // push its own top edge + caret line off the top; capping keeps the input's top
                // and first lines visible. No-op for short targets (label/checklist/title), where
                // targetH is already below the cap, so their behaviour is unchanged (#921).
                const maxReveal = visibleHeight * DESCRIPTION_REVEAL_FRACTION;
                const targetBottom = targetY + Math.min(targetH, maxReveal);

                if (targetBottom > effectiveVisibleBottom) {
                    const delta = targetBottom - effectiveVisibleBottom;
                    const nextOffset = Math.max(0, formScrollOffsetRef.current + delta);
                    // Android scrolls without animation: the settle retries below re-fire this,
                    // and animated scrolls cancel each other mid-flight (leaving the input short
                    // of clearing the keyboard) while an instant scroll keeps the tracked offset
                    // in sync via onScroll so the retries converge (#921).
                    formScrollRef.current?.scrollTo({ y: nextOffset, animated: Platform.OS !== 'android' });
                    return;
                }

                if (targetTop < visibleTop && Platform.OS !== 'android') {
                    const delta = visibleTop - targetTop;
                    const nextOffset = Math.max(0, formScrollOffsetRef.current - delta);
                    formScrollRef.current?.scrollTo({ y: nextOffset, animated: true });
                }
            });
        });
    }, []);

    const scheduleScrollHandleIntoView = React.useCallback((targetHandle: number) => {
        if (Platform.OS === 'android' && !keyboardVisibleRef.current) {
            // Keyboard not up yet; replay this once `keyboardDidShow` gives us real metrics (#921).
            pendingScrollHandleRef.current = targetHandle;
            return;
        }
        const scrollIntoView = () => scrollHandleIntoView(targetHandle);
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
                scrollIntoView();
                if (Platform.OS === 'android') {
                    requestAnimationFrame(scrollIntoView);
                }
            });
        } else {
            setTimeout(scrollIntoView, 0);
        }
        // Re-measure after the keyboard/height animation settles. A single immediate scroll
        // under-applies while the KeyboardAvoidingView is still shrinking, leaving the input
        // behind the keyboard; these retries converge (Android only ever scrolls downward, so
        // they can't jump the view upward). Runs for both platforms (#921).
        setTimeout(scrollIntoView, 180);
        setTimeout(scrollIntoView, 360);
    }, [scrollHandleIntoView]);

    React.useEffect(() => {
        if (suspendKeyboardHandling) {
            keyboardTopRef.current = Dimensions.get('window').height;
            keyboardVisibleRef.current = false;
            pendingScrollHandleRef.current = null;
            setKeyboardBottomInset(0);
            return;
        }
        if (typeof Keyboard?.addListener !== 'function') return;
        const updateKeyboardTop = (event: { endCoordinates?: { screenY?: number; height?: number } }) => {
            const windowHeight = Dimensions.get('window').height;
            const endCoords = event.endCoordinates;
            let nextKeyboardTop = windowHeight;
            if (typeof endCoords?.screenY === 'number') {
                nextKeyboardTop = endCoords.screenY;
            } else if (typeof endCoords?.height === 'number') {
                nextKeyboardTop = Math.max(0, windowHeight - endCoords.height);
            }
            keyboardTopRef.current = nextKeyboardTop;
            keyboardVisibleRef.current = nextKeyboardTop < windowHeight;
            setKeyboardBottomInset(Math.max(0, windowHeight - nextKeyboardTop));
            if (keyboardVisibleRef.current && pendingScrollHandleRef.current != null) {
                const pendingHandle = pendingScrollHandleRef.current;
                pendingScrollHandleRef.current = null;
                scheduleScrollHandleIntoView(pendingHandle);
            }
        };
        const resetKeyboardTop = () => {
            keyboardTopRef.current = Dimensions.get('window').height;
            keyboardVisibleRef.current = false;
            pendingScrollHandleRef.current = null;
            setKeyboardBottomInset(0);
        };
        const showListener = Keyboard.addListener(
            Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
            updateKeyboardTop
        );
        const changeListener = Keyboard.addListener(
            Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidChangeFrame',
            updateKeyboardTop
        );
        const hideListener = Keyboard.addListener(
            Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
            resetKeyboardTop
        );
        return () => {
            showListener.remove();
            changeListener.remove();
            hideListener.remove();
            pendingScrollHandleRef.current = null;
        };
    }, [suspendKeyboardHandling, scheduleScrollHandleIntoView]);

    const ensureInputVisible = React.useCallback((targetInput?: number | string) => {
        const normalizedHandle = typeof targetInput === 'number'
            ? targetInput
            : typeof targetInput === 'string'
                ? Number(targetInput)
                : NaN;
        const hasTargetHandle = Number.isFinite(normalizedHandle) && normalizedHandle > 0;
        if (!hasTargetHandle) {
            return;
        }
        scheduleScrollHandleIntoView(normalizedHandle);
    }, [scheduleScrollHandleIntoView]);

    React.useEffect(() => {
        if (!registerScrollToEnd) return;
        if (suspendKeyboardHandling) {
            registerScrollToEnd(null);
            return;
        }
        registerScrollToEnd((targetInput) => {
            ensureInputVisible(targetInput);
        });
        return () => registerScrollToEnd(null);
    }, [ensureInputVisible, registerScrollToEnd, suspendKeyboardHandling]);
    const countFilledFields = (fieldIds: TaskEditorFieldId[]): number => {
        return fieldIds.filter((fieldId) => {
            switch (fieldId) {
                case 'startTime':
                    return Boolean(draft?.startTime);
                case 'recurrence':
                    return Boolean(draft?.recurrence);
                case 'reviewAt':
                    return Boolean(draft?.reviewAt);
                case 'contexts':
                    return Boolean(draft?.contexts.trim());
                case 'tags':
                    return Boolean(draft?.tags.trim());
                case 'priority':
                    return Boolean(draft?.priority);
                case 'energyLevel':
                    return Boolean(draft?.energyLevel);
                case 'assignedTo':
                    return Boolean(draft?.assignedTo.trim());
                case 'timeEstimate':
                    return Boolean(draft?.timeEstimate);
                case 'description':
                    return Boolean(draft?.description.trim());
                case 'location':
                    return Boolean(draft?.location.trim());
                case 'checklist':
                    return (checklist?.length ?? 0) > 0;
                case 'attachments':
                    return (attachments || []).some((attachment) => !attachment.deletedAt);
                default:
                    return false;
            }
        }).length;
    };
    const schedulingFilledCount = countFilledFields(schedulingFields);
    const organizationFilledCount = countFilledFields(organizationFields);
    const detailsFilledCount = countFilledFields(detailsFields);

    return (
        <View
            accessibilityElementsHidden={accessibilityHidden}
            importantForAccessibility={accessibilityHidden ? 'no-hide-descendants' : 'auto'}
            style={[styles.tabPage, { width: containerWidth || '100%' }]}
        >
            <KeyboardAvoidingView
                behavior={suspendKeyboardHandling ? undefined : (Platform.OS === 'android' ? 'height' : undefined)}
                style={{ flex: 1 }}
                keyboardVerticalOffset={0}
            >
                <ScrollView
                    ref={formScrollRef}
                    style={styles.content}
                    contentContainerStyle={[
                        styles.contentContainer,
                        keyboardBottomInset > 0
                            ? { paddingBottom: TASK_FORM_BASE_BOTTOM_PADDING + keyboardBottomInset }
                            : null,
                    ]}
                    keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
                    keyboardShouldPersistTaps="handled"
                    scrollEnabled={!suspendKeyboardHandling}
                    {...androidScrollViewFocusProps}
                    onScroll={(event) => {
                        formScrollOffsetRef.current = event.nativeEvent.contentOffset.y;
                    }}
                    scrollEventThrottle={16}
                    nestedScrollEnabled
                >
                        <View style={styles.formGroup}>
                            <View style={styles.labelRow}>
                                <Text style={[styles.label, { color: tc.secondaryText, marginBottom: 0 }]}>
                                    {t('taskEdit.titleLabel')}
                                </Text>
                                <TouchableOpacity
                                    accessibilityLabel={taskEditorLayoutHelpLabel}
                                    accessibilityRole="button"
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                    onPress={showTaskEditorLayoutHelp}
                                    style={[
                                        styles.fieldHelpButton,
                                        { backgroundColor: tc.filterBg, borderColor: tc.border },
                                    ]}
                                >
                                    <Ionicons name="help-circle-outline" size={18} color={tc.secondaryText} />
                                </TouchableOpacity>
                            </View>
                            <TextInput
                            style={[styles.input, inputStyle, textDirectionStyle, styles.titleInput]}
                            value={titleDraft}
                            onChangeText={(text) => onTitleDraftChange(text.replace(/[\r\n]+/g, ' '))}
                            placeholderTextColor={tc.secondaryText}
                            multiline
                            onFocus={() => {
                                onInputFocusTracked?.(undefined);
                                setTitleFocused(true);
                                onTitleInputFocusChange?.(true);
                            }}
                            onBlur={() => {
                                setTitleFocused(false);
                                onTitleInputFocusChange?.(false);
                            }}
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
                                        {aiWorkingText}
                                    </Text>
                                </View>
                            )}
                        </View>
                    )}
                    {aiEnabled && pendingCopilotParts.length > 0 && (
                        <View style={[styles.copilotPill, { borderColor: tc.border, backgroundColor: tc.filterBg }]}>
                            <View style={styles.copilotChipRow}>
                                <Ionicons
                                    name="sparkles-outline"
                                    size={16}
                                    color={tc.text}
                                    accessible={false}
                                />
                                <Text style={[styles.copilotText, { color: tc.text }]}>
                                    {t('copilot.suggested')}
                                </Text>
                                {pendingCopilotParts.map((part) => (
                                    <TouchableOpacity
                                        key={`${part.kind}:${part.value}`}
                                        accessibilityRole="button"
                                        accessibilityLabel={part.value}
                                        style={[styles.copilotChip, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                                        onPress={() => applyCopilotPart(part)}
                                    >
                                        <Text style={[styles.copilotText, { color: tc.text }]}>{part.value}</Text>
                                    </TouchableOpacity>
                                ))}
                                {pendingCopilotParts.length > 1 && (
                                    <TouchableOpacity
                                        accessibilityRole="button"
                                        accessibilityLabel={t('copilot.applyAll')}
                                        style={styles.copilotApplyAll}
                                        onPress={applyCopilotSuggestion}
                                    >
                                        <Text style={[styles.copilotText, { color: tc.tint }]}>{t('copilot.applyAll')}</Text>
                                    </TouchableOpacity>
                                )}
                            </View>
                            <Text style={[styles.copilotHint, { color: tc.secondaryText }]}>
                                {t('copilot.applyHint')}
                            </Text>
                        </View>
                    )}
                    {aiEnabled && hasAppliedCopilot && (
                        <View style={[styles.copilotPill, { borderColor: tc.border, backgroundColor: tc.filterBg }]}>
                            <View style={{ flexDirection: 'row', alignItems: 'flex-start', columnGap: 4 }}>
                                <Ionicons
                                    name="checkmark-circle-outline"
                                    size={16}
                                    color={tc.text}
                                    accessible={false}
                                />
                                <Text style={[styles.copilotText, { color: tc.text, flexShrink: 1 }]}>
                                    {t('copilot.applied')}{' '}
                                    {copilotContext ? `${copilotContext} ` : ''}
                                    {timeEstimatesEnabled && copilotEstimate ? `${copilotEstimate}` : ''}
                                    {copilotTags.length ? copilotTags.join(' ') : ''}
                                </Text>
                            </View>
                        </View>
                    )}
                    {basicFields.map((fieldId) => (
                        <React.Fragment key={fieldId}>{renderField(fieldId)}</React.Fragment>
                    ))}

                    {draft?.status === 'someday' && somedaySections.length > 0 && onSomedaySectionChange ? (
                        <View style={styles.formGroup}>
                            <Text style={[styles.label, { color: tc.secondaryText }]}>
                                {tFallback(t, 'viewSections.somedaySection', 'Someday section')}
                            </Text>
                            <View style={styles.statusContainer}>
                                {[{ id: '', title: tFallback(t, 'viewSections.noSection', 'No section') }, ...somedaySections]
                                    .map((section) => {
                                        const selected = (selectedSomedaySectionId ?? '') === section.id;
                                        return (
                                            <TouchableOpacity
                                                key={section.id || 'no-section'}
                                                accessibilityRole="button"
                                                accessibilityLabel={section.title}
                                                accessibilityState={{ selected }}
                                                onPress={() => onSomedaySectionChange(section.id || undefined)}
                                                style={[
                                                    styles.statusChip,
                                                    {
                                                        backgroundColor: selected ? tc.tint : tc.filterBg,
                                                        borderColor: selected ? tc.tint : tc.border,
                                                    },
                                                ]}
                                            >
                                                <Text style={[styles.statusText, { color: selected ? tc.onTint : tc.text }]}>
                                                    {section.title}
                                                </Text>
                                            </TouchableOpacity>
                                        );
                                    })}
                            </View>
                        </View>
                    ) : null}

                    {schedulingFields.length > 0 && (
                        <CollapsibleSection
                            resetKey={`${formResetKey ?? 'task'}:scheduling`}
                            title={t('taskEdit.scheduling')}
                            badge={schedulingFilledCount}
                            defaultExpanded={sectionOpenDefaults.scheduling || schedulingFilledCount > 0}
                        >
                            {schedulingFields.map((fieldId) => (
                                <React.Fragment key={fieldId}>{renderField(fieldId)}</React.Fragment>
                            ))}
                        </CollapsibleSection>
                    )}

                    {organizationFields.length > 0 && (
                        <CollapsibleSection
                            resetKey={`${formResetKey ?? 'task'}:organization`}
                            title={t('taskEdit.organization')}
                            badge={organizationFilledCount}
                            defaultExpanded={sectionOpenDefaults.organization || organizationFilledCount > 0}
                        >
                            {organizationFields.map((fieldId) => (
                                <React.Fragment key={fieldId}>{renderField(fieldId)}</React.Fragment>
                            ))}
                        </CollapsibleSection>
                    )}

                    {detailsFields.length > 0 && (
                        <CollapsibleSection
                            resetKey={`${formResetKey ?? 'task'}:details`}
                            title={t('taskEdit.details')}
                            badge={detailsFilledCount}
                            defaultExpanded={sectionOpenDefaults.details || detailsFilledCount > 0}
                        >
                            {detailsFields.map((fieldId) => (
                                <React.Fragment key={fieldId}>{renderField(fieldId)}</React.Fragment>
                            ))}
                        </CollapsibleSection>
                    )}

                    <View style={{ height: 100 }} />

                    {showDatePicker && Platform.OS === 'android' && (
                        <View>
                            <DateTimePicker
                                value={(() => {
                                    if (showDatePicker === 'start') return getSafePickerDateValue(draft?.startTime);
                                    if (showDatePicker === 'start-time') return pendingStartDate ?? getSafePickerDateValue(draft?.startTime);
                                    if (showDatePicker === 'review') return getSafePickerDateValue(draft?.reviewAt);
                                    if (showDatePicker === 'recurrence-end') {
                                        return getSafePickerDateValue(parseRRuleString(draft?.recurrenceRRule ?? '').until);
                                    }
                                    if (showDatePicker === 'due-time') return pendingDueDate ?? getSafePickerDateValue(draft?.dueDate);
                                    return getSafePickerDateValue(draft?.dueDate);
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

export const TaskEditFormTab = React.memo(TaskEditFormTabComponent);

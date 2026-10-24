import React from 'react';
import {
    Text,
    Switch,
    TextInput,
    TouchableOpacity,
    View,
    Platform,
    findNodeHandle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
    AlignLeft,
    Check,
    Eye,
    ListChecks,
    Navigation,
    Paperclip,
    Pencil,
    Plus,
    Trash2,
} from 'lucide-react-native';
import {
    applyTaskChecklistEdit,
    buildTaskChecklistFieldModel,
    generateUUID,
    getAttachmentDisplayTitle,
    isAttachmentKeptWithoutFile,
    isMarkdownEditorAssistEnabled,
    resolveAutoTextDirection,
    useTaskStore,
    type MarkdownSelection,
    type TaskChecklistEdit,
} from '@mindwtr/core';

import { MarkdownReferenceAutocomplete } from '../markdown-reference-autocomplete';
import { MarkdownText } from '../markdown-text';
import { logInfo } from '../../lib/app-log';
import { FieldHeading } from './FieldHeading';
import { getControlledTextInputSelection } from '../text-input-selection';
import {
    applyMarkdownPairInsertionWithSelectionFallback,
    createIgnoredNativePairChangeFromTextChange,
    shouldIgnoreNativePairChange,
    type IgnoredNativePairChange,
    isRangeSelection,
} from '../markdown-selection-utils';
import type { TaskEditFieldRendererProps } from './TaskEditFieldRenderer.types';

type ContentFieldId = 'description' | 'location' | 'attachments' | 'checklist';

type TaskEditContentFieldProps = TaskEditFieldRendererProps & {
    fieldId: ContentFieldId;
};

const getChecklistItemKey = (item: { id?: string }, index: number) => item.id || `index:${index}`;
const selectionsEqual = (left: MarkdownSelection, right: MarkdownSelection) => (
    left.start === right.start && left.end === right.end
);

export function TaskEditContentField({
    addFileAttachment,
    addImageAttachment,
    applyChecklistUpdate,
    applyDescriptionResult,
    checklist,
    descriptionDraft,
    descriptionInputRef,
    descriptionSelection,
    descriptionSelectionRestorePending,
    descriptionToolbarInteractionUntilRef,
    downloadAttachment,
    editLinkAttachment,
    draft,
    fieldId,
    handleDescriptionChange,
    handleDescriptionKeyPress,
    handleInputFocus,
    handleResetChecklist,
    isDescriptionInputFocused,
    language,
    openAttachment,
    openAddLinkAttachment,
    openDescriptionExpandedEditor,
    removeAttachment,
    setDescriptionSelection,
    setDraftField,
    setIsDescriptionInputFocused,
    setShowDescriptionPreview,
    showDescriptionPreview,
    styles,
    t,
    task,
    tc,
    titleDraft,
    visibleAttachments,
}: TaskEditContentFieldProps) {
    const inputStyle = { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text };
    const [checklistOrderMode, setChecklistOrderMode] = React.useState(false);
    const isReference = (draft?.status ?? task?.status) === 'reference';
    const editChecklist = React.useCallback((edit: TaskChecklistEdit) => {
        const result = applyTaskChecklistEdit(checklist, edit, { newId: generateUUID });
        if (result) applyChecklistUpdate(result.checklist);
        return result;
    }, [applyChecklistUpdate, checklist]);
    const combinedText = `${titleDraft ?? ''}\n${descriptionDraft ?? ''}`.trim();
    const resolvedDirection = resolveAutoTextDirection(combinedText, language);
    const textDirectionStyle = {
        writingDirection: resolvedDirection,
        textAlign: resolvedDirection === 'rtl' ? 'right' : 'left',
    } as const;
    const checklistInputRefs = React.useRef<Record<string, TextInput | null>>({});
    const checklistInputRefCallbacks = React.useRef<Record<string, (node: TextInput | null) => void>>({});
    const checklistTitleRefs = React.useRef<Record<string, string>>({});
    const checklistSelectionRefs = React.useRef<Record<string, MarkdownSelection>>({});
    const lastChecklistRangeRefs = React.useRef<Record<string, MarkdownSelection | null>>({});
    const ignoredNativePairChangeRefs = React.useRef<Record<string, IgnoredNativePairChange>>({});
    const pendingChecklistSelectionRefs = React.useRef<Record<string, MarkdownSelection | null>>({});
    const [checklistSelectionRestorePending, setChecklistSelectionRestorePending] = React.useState<Record<string, boolean>>({});
    const pendingChecklistFocusKeyRef = React.useRef<string | null>(null);
    const checklistFocusFrameRef = React.useRef<number | null>(null);
    const checklistFocusTargetRef = React.useRef<TextInput | null>(null);
    const cancelPendingChecklistFocus = React.useCallback(() => {
        if (checklistFocusFrameRef.current !== null) {
            cancelAnimationFrame(checklistFocusFrameRef.current);
            checklistFocusFrameRef.current = null;
        }
        checklistFocusTargetRef.current = null;
        pendingChecklistFocusKeyRef.current = null;
    }, []);
    const requestChecklistInsertionFocus = React.useCallback((key: string) => {
        cancelPendingChecklistFocus();
        pendingChecklistFocusKeyRef.current = key;
    }, [cancelPendingChecklistFocus]);
    const getChecklistInputRef = React.useCallback((key: string) => {
        checklistInputRefCallbacks.current[key] ??= (node: TextInput | null) => {
            checklistInputRefs.current[key] = node;
            if (
                pendingChecklistFocusKeyRef.current === key
                && checklistFocusTargetRef.current
                && node !== checklistFocusTargetRef.current
            ) {
                cancelPendingChecklistFocus();
            }
        };
        return checklistInputRefCallbacks.current[key];
    }, [cancelPendingChecklistFocus]);
    const checklistLength = checklist?.length ?? 0;
    React.useEffect(() => {
        if (fieldId !== 'checklist' || checklistLength < 2) {
            setChecklistOrderMode(false);
        }
    }, [checklistLength, fieldId]);

    React.useEffect(() => {
        const activeKeys = new Set<string>();
        (checklist || []).forEach((item, index) => {
            const key = getChecklistItemKey(item, index);
            activeKeys.add(key);
            checklistTitleRefs.current[key] = item.title;
        });
        for (const key of Object.keys(checklistInputRefs.current)) {
            if (activeKeys.has(key)) continue;
            delete checklistInputRefs.current[key];
            delete checklistTitleRefs.current[key];
            delete checklistSelectionRefs.current[key];
            delete lastChecklistRangeRefs.current[key];
            delete ignoredNativePairChangeRefs.current[key];
            delete pendingChecklistSelectionRefs.current[key];
            delete checklistInputRefCallbacks.current[key];
        }
        const pendingFocusKey = pendingChecklistFocusKeyRef.current;
        if (pendingFocusKey && !activeKeys.has(pendingFocusKey)) {
            cancelPendingChecklistFocus();
        }
    }, [cancelPendingChecklistFocus, checklist]);

    React.useEffect(
        () => cancelPendingChecklistFocus,
        [cancelPendingChecklistFocus, fieldId, task?.id],
    );

    // A just-added row is focused from its first onLayout, not the mount commit:
    // focusing before native layout makes Android's ScrollView scroll-to-focused-
    // child measure the unpositioned row and jump to the top of the checklist.
    const handleChecklistRowLayout = React.useCallback((key: string) => {
        if (pendingChecklistFocusKeyRef.current !== key) return;
        const target = checklistInputRefs.current[key];
        if (!target) return;
        if (Platform.OS !== 'android') {
            pendingChecklistFocusKeyRef.current = null;
            target.focus();
            return;
        }
        if (checklistFocusFrameRef.current !== null) return;

        checklistFocusTargetRef.current = target;
        const frame = requestAnimationFrame(() => {
            if (checklistFocusFrameRef.current !== frame) return;
            checklistFocusFrameRef.current = null;
            if (
                pendingChecklistFocusKeyRef.current !== key
                || checklistInputRefs.current[key] !== target
            ) {
                checklistFocusTargetRef.current = null;
                pendingChecklistFocusKeyRef.current = null;
                return;
            }

            checklistFocusTargetRef.current = null;
            pendingChecklistFocusKeyRef.current = null;
            target.focus();
            void logInfo('Checklist insertion focus requested after layout', {
                scope: 'task-edit',
                extra: {
                    releaseCheck: 'v1.3.0/checklist-insert-focus',
                    stage: 'layout-ready',
                },
            });
        });
        checklistFocusFrameRef.current = frame;
    }, []);

    const getChecklistSelection = React.useCallback((key: string, value: string): MarkdownSelection => (
        checklistSelectionRefs.current[key] ?? { start: value.length, end: value.length }
    ), []);

    const restoreChecklistSelection = React.useCallback((key: string, selection: MarkdownSelection) => {
        checklistSelectionRefs.current[key] = selection;
        lastChecklistRangeRefs.current[key] = isRangeSelection(selection) ? selection : null;
        pendingChecklistSelectionRefs.current[key] = selection;
        setChecklistSelectionRestorePending((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
        const applySelection = () => {
            const input = checklistInputRefs.current[key];
            input?.focus?.();
            input?.setNativeProps?.({ selection });
        };
        const clearPendingSelection = () => {
            if (
                pendingChecklistSelectionRefs.current[key]
                && selectionsEqual(pendingChecklistSelectionRefs.current[key], selection)
            ) {
                delete pendingChecklistSelectionRefs.current[key];
            }
            setChecklistSelectionRestorePending((prev) => {
                if (!prev[key]) return prev;
                const next = { ...prev };
                delete next[key];
                return next;
            });
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(applySelection);
        } else {
            setTimeout(applySelection, 0);
        }
        setTimeout(applySelection, 40);
        setTimeout(applySelection, 140);
        setTimeout(() => {
            applySelection();
            clearPendingSelection();
        }, 300);
    }, []);

    // Return key on a filled checklist item inserts an empty item right after it
    // and moves focus there, so a list can be typed without tapping "+ Add item"
    // between entries (matching the desktop editor's Enter). On an empty item the
    // return key just ends editing.
    const handleChecklistSubmit = React.useCallback((index: number, key: string) => {
        if (!(checklist || [])[index]) return;
        const result = applyTaskChecklistEdit(checklist, { kind: 'insertAfter', index, text: checklistTitleRefs.current[key] }, { newId: generateUUID,
        });
        if (!result) {
            checklistInputRefs.current[key]?.blur();
            return;
        }
        if (result.focusId) requestChecklistInsertionFocus(result.focusId);
        applyChecklistUpdate(result.checklist);
    }, [applyChecklistUpdate, checklist, requestChecklistInsertionFocus]);

    const updateChecklistTitle = React.useCallback((index: number, key: string, title: string) => {
        checklistTitleRefs.current[key] = title;
        editChecklist({ kind: 'rename', index, text: title });
    }, [editChecklist]);

    const handleChecklistSelectionChange = React.useCallback((key: string, selection: MarkdownSelection) => {
        const pendingSelection = pendingChecklistSelectionRefs.current[key];
        if (pendingSelection) {
            if (!selectionsEqual(pendingSelection, selection)) {
                return;
            }
            delete pendingChecklistSelectionRefs.current[key];
            setChecklistSelectionRestorePending((prev) => {
                if (!prev[key]) return prev;
                const next = { ...prev };
                delete next[key];
                return next;
            });
        }
        checklistSelectionRefs.current[key] = selection;
        if (isRangeSelection(selection)) {
            lastChecklistRangeRefs.current[key] = selection;
        } else {
            lastChecklistRangeRefs.current[key] = null;
        }
    }, []);

    const getDescriptionFocusScrollTarget = React.useCallback((nativeTarget?: number) => {
        if (Platform.OS === 'android') {
            // Scroll to the input itself, not the label header above it, so the field (not just
            // the "DESCRIPTION" label) lands above the keyboard. The reveal cap in
            // scrollHandleIntoView keeps a tall description from over-scrolling (#921).
            return findNodeHandle(descriptionInputRef.current) ?? undefined;
        }
        return nativeTarget || undefined;
    }, [descriptionInputRef]);

    const handleDescriptionSelectionChange = React.useCallback((selection: MarkdownSelection) => {
        setDescriptionSelection(selection);

        if (Platform.OS !== 'android') return;
        const isFocused = isDescriptionInputFocused || descriptionInputRef.current?.isFocused?.();
        if (!isFocused) return;
        handleInputFocus(undefined);
    }, [
        descriptionInputRef,
        handleInputFocus,
        isDescriptionInputFocused,
        setDescriptionSelection,
    ]);

    const handleChecklistTitleChange = React.useCallback((index: number, key: string, text: string) => {
        if (/[\r\n]/.test(text)) {
            // Multi-line paste: split into one checklist item per line. The
            // first line replaces this item's title; the rest insert after it.
            const result = applyTaskChecklistEdit(checklist, { kind: 'rename', index, text }, { newId: generateUUID });
            if (!result) return;
            const updatedTitle = result.checklist[index].title;
            checklistTitleRefs.current[key] = updatedTitle;
            checklistSelectionRefs.current[key] = {
                start: updatedTitle.length,
                end: updatedTitle.length,
            };
            lastChecklistRangeRefs.current[key] = null;
            applyChecklistUpdate(result.checklist);
            return;
        }
        const previousValue = checklistTitleRefs.current[key] ?? '';
        const ignoredNativeChange = ignoredNativePairChangeRefs.current[key];
        if (ignoredNativeChange) {
            if (shouldIgnoreNativePairChange(text, previousValue, ignoredNativeChange)) {
                restoreChecklistSelection(key, ignoredNativeChange.selection);
                return;
            }
            delete ignoredNativePairChangeRefs.current[key];
        }

        const currentSelection = getChecklistSelection(key, previousValue);
        const assistEnabled = isMarkdownEditorAssistEnabled(useTaskStore.getState().settings);
        const pairedInsertion = applyMarkdownPairInsertionWithSelectionFallback(
            previousValue,
            text,
            currentSelection,
            lastChecklistRangeRefs.current[key],
            { assist: assistEnabled },
        );
        if (pairedInsertion) {
            const ignoredTextChange = createIgnoredNativePairChangeFromTextChange(
                previousValue,
                text,
                pairedInsertion.baseSelection,
                pairedInsertion.result,
            );
            if (ignoredTextChange) {
                ignoredNativePairChangeRefs.current[key] = ignoredTextChange;
            } else {
                delete ignoredNativePairChangeRefs.current[key];
            }
            lastChecklistRangeRefs.current[key] = isRangeSelection(pairedInsertion.result.selection)
                ? pairedInsertion.result.selection
                : null;
            updateChecklistTitle(index, key, pairedInsertion.result.value);
            restoreChecklistSelection(key, pairedInsertion.result.selection);
            return;
        }

        lastChecklistRangeRefs.current[key] = null;
        updateChecklistTitle(index, key, text);
    }, [applyChecklistUpdate, checklist, getChecklistSelection, restoreChecklistSelection, updateChecklistTitle]);

    // Checklist auto-pairing intentionally lives only in handleChecklistTitleChange. On
    // Android the keyPress event is synthesized from the same native edit as the text
    // change (and preventDefault cannot cancel it), so a keyPress pairing path processes
    // one keystroke twice — IME-specific echo orders then double the pair (#565).
    const handleChecklistMove = React.useCallback((from: number, to: number) => {
        editChecklist({ kind: 'move', from, to });
    }, [editChecklist]);

    switch (fieldId) {
        case 'description':
            return (
                <View style={styles.formGroup}>
                    <View
                        style={styles.inlineHeader}
                    >
                        <FieldHeading
                            icon={AlignLeft}
                            label={t('taskEdit.descriptionLabel')}
                            iconColor={tc.secondaryText}
                            labelStyle={[styles.label, { color: tc.secondaryText }]}
                        />
                        <View style={styles.inlineActions}>
                            <TouchableOpacity
                                onPress={() => setShowDescriptionPreview((value) => !value)}
                                accessibilityRole="button"
                                accessibilityLabel={showDescriptionPreview ? t('markdown.edit') : t('markdown.preview')}
                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                            >
                                {showDescriptionPreview ? (
                                    <Pencil
                                        size={18}
                                        color={tc.tint}
                                        aria-hidden
                                        accessible={false}
                                        pointerEvents="none"
                                    />
                                ) : (
                                    <Eye
                                        size={18}
                                        color={tc.tint}
                                        aria-hidden
                                        accessible={false}
                                        pointerEvents="none"
                                    />
                                )}
                            </TouchableOpacity>
                            <TouchableOpacity
                                onPress={openDescriptionExpandedEditor}
                                accessibilityRole="button"
                                accessibilityLabel={t('markdown.expand')}
                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                            >
                                <Ionicons name="expand-outline" size={20} color={tc.tint} />
                            </TouchableOpacity>
                        </View>
                    </View>
                    {showDescriptionPreview ? (
                        <View style={[styles.markdownPreview, { backgroundColor: tc.filterBg, borderColor: tc.border }]}>
                            <MarkdownText markdown={descriptionDraft || ''} tc={tc} direction={resolvedDirection} />
                        </View>
                    ) : (
                        <>
                            <MarkdownReferenceAutocomplete
                                currentTaskId={task?.id}
                                value={descriptionDraft}
                                selection={descriptionSelection}
                                inputRef={descriptionInputRef}
                                visible={isDescriptionInputFocused}
                                onApplyResult={applyDescriptionResult}
                                t={t}
                                tc={tc}
                            />
                            <TextInput
                                ref={descriptionInputRef}
                                style={[styles.input, styles.textArea, inputStyle, textDirectionStyle]}
                                value={descriptionDraft}
                                onFocus={(event) => {
                                    setIsDescriptionInputFocused(true);
                                    const target = event.nativeEvent.target;
                                    handleInputFocus(getDescriptionFocusScrollTarget(target));
                                }}
                                onBlur={() => {
                                    const preserveFocus = descriptionToolbarInteractionUntilRef.current > Date.now();
                                    if (preserveFocus) {
                                        requestAnimationFrame(() => {
                                            descriptionInputRef.current?.focus();
                                        });
                                        return;
                                    }
                                    setTimeout(() => {
                                        if (!descriptionInputRef.current?.isFocused?.()) {
                                            setIsDescriptionInputFocused(false);
                                        }
                                    }, 0);
                                }}
                                onChangeText={handleDescriptionChange}
                                onKeyPress={handleDescriptionKeyPress}
                                onSelectionChange={(event) => handleDescriptionSelectionChange(event.nativeEvent.selection)}
                                selection={getControlledTextInputSelection(descriptionSelection, {
                                    force: descriptionSelectionRestorePending,
                                })}
                                placeholder={t('taskEdit.descriptionPlaceholder')}
                                multiline
                                spellCheck={true}
                                autoCorrect={true}
                                autoCapitalize="sentences"
                                autoComplete="off"
                                importantForAutofill="no"
                                inputMode="text"
                                textContentType="none"
                                keyboardType="default"
                                placeholderTextColor={tc.secondaryText}
                                accessibilityLabel={t('taskEdit.descriptionLabel')}
                                accessibilityHint={t('taskEdit.descriptionPlaceholder')}
                            />
                        </>
                    )}
                </View>
            );
        case 'location':
            return (
                <View style={styles.formGroup}>
                    <FieldHeading
                        icon={Navigation}
                        label={t('taskEdit.locationLabel')}
                        iconColor={tc.secondaryText}
                        labelStyle={[styles.label, { color: tc.secondaryText }]}
                    />
                    <TextInput
                        style={[styles.input, inputStyle]}
                        value={draft?.location ?? ''}
                        onChangeText={(location) => setDraftField('location', location)}
                        placeholder={t('taskEdit.locationPlaceholder')}
                        placeholderTextColor={tc.secondaryText}
                        accessibilityLabel={t('taskEdit.locationLabel')}
                        accessibilityHint={t('taskEdit.locationPlaceholder')}
                        onFocus={(event) => {
                            if (event.nativeEvent.target) {
                                handleInputFocus(event.nativeEvent.target);
                            }
                        }}
                    />
                </View>
            );
        case 'attachments':
            return (
                <View style={styles.formGroup}>
                    <View style={styles.attachmentHeader}>
                        <FieldHeading
                            icon={Paperclip}
                            label={t('attachments.title')}
                            iconColor={tc.secondaryText}
                            labelStyle={[styles.label, { color: tc.secondaryText }]}
                        />
                    </View>
                    <View style={styles.attachmentActions}>
                        <TouchableOpacity
                            onPress={addFileAttachment}
                            style={[styles.attachmentButton, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                        >
                            <Ionicons name="document-attach-outline" size={16} color={tc.tint} />
                            <Text style={[styles.attachmentButtonText, { color: tc.tint }]} numberOfLines={1}>{t('attachments.addFile')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            onPress={addImageAttachment}
                            style={[styles.attachmentButton, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                        >
                            <Ionicons name="image-outline" size={16} color={tc.tint} />
                            <Text style={[styles.attachmentButtonText, { color: tc.tint }]} numberOfLines={1}>{t('attachments.addPhoto')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            onPress={openAddLinkAttachment}
                            style={[styles.attachmentButton, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                        >
                            <Ionicons name="link-outline" size={16} color={tc.tint} />
                            <Text style={[styles.attachmentButtonText, { color: tc.tint }]} numberOfLines={1}>{t('attachments.addLink')}</Text>
                        </TouchableOpacity>
                    </View>
                    {visibleAttachments.length === 0 ? (
                        <Text style={[styles.helperText, { color: tc.secondaryText }]}>{t('common.none')}</Text>
                    ) : (
                        <View style={[styles.attachmentsList, { borderColor: tc.border, backgroundColor: tc.cardBg }]}>
                            {visibleAttachments.map((attachment) => {
                                const displayTitle = getAttachmentDisplayTitle(attachment);
                                const isMissing = attachment.kind === 'file'
                                    && (!attachment.uri || attachment.localStatus === 'missing');
                                const canDownload = isMissing && Boolean(attachment.cloudKey) && !isAttachmentKeptWithoutFile(attachment);
                                const isDownloading = attachment.localStatus === 'downloading';
                                return (
                                    <View key={attachment.id} style={[styles.attachmentRow, { borderBottomColor: tc.border }]}>
                                        <TouchableOpacity
                                            style={styles.attachmentTitleWrap}
                                            onPress={() => openAttachment(attachment)}
                                            disabled={isDownloading}
                                        >
                                            <Text style={[styles.attachmentTitle, { color: tc.tint }]} numberOfLines={1}>
                                                {displayTitle}
                                            </Text>
                                        </TouchableOpacity>
                                        {isDownloading ? (
                                            <Text style={[styles.attachmentStatus, { color: tc.secondaryText }]}>
                                                {t('common.loading')}
                                            </Text>
                                        ) : canDownload ? (
                                            <TouchableOpacity onPress={() => downloadAttachment(attachment)}>
                                                <Text style={[styles.attachmentDownload, { color: tc.tint }]}>
                                                    {t('attachments.download')}
                                                </Text>
                                            </TouchableOpacity>
                                        ) : isMissing ? (
                                            <Text style={[styles.attachmentStatus, { color: tc.secondaryText }]}>
                                                {t('attachments.missing')}
                                            </Text>
                                        ) : null}
                                        <View style={styles.attachmentActions}>
                                            {attachment.kind === 'link' ? (
                                                <TouchableOpacity
                                                    onPress={() => editLinkAttachment(attachment)}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={t('common.edit')}
                                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                                    style={{ opacity: 0.85 }}
                                                >
                                                    <Pencil
                                                        size={14}
                                                        color={tc.tint}
                                                        aria-hidden
                                                        accessible={false}
                                                        pointerEvents="none"
                                                    />
                                                </TouchableOpacity>
                                            ) : null}
                                            <TouchableOpacity
                                                onPress={() => removeAttachment(attachment.id)}
                                                accessibilityRole="button"
                                                accessibilityLabel={t('attachments.remove')}
                                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                                style={{ opacity: 0.85 }}
                                            >
                                                <Trash2
                                                    size={14}
                                                    color={tc.tint}
                                                    aria-hidden
                                                    accessible={false}
                                                    pointerEvents="none"
                                                />
                                            </TouchableOpacity>
                                        </View>
                                    </View>
                                );
                            })}
                        </View>
                    )}
                </View>
            );
        case 'checklist': {
            const field = buildTaskChecklistFieldModel({ checklist, isReference, t });

            return (
                <View style={styles.formGroup}>
                    <View style={styles.checklistHeader}>
                        <FieldHeading
                            icon={ListChecks}
                            label={field.label}
                            iconColor={tc.secondaryText}
                            labelStyle={[styles.label, styles.checklistHeaderLabel, { color: tc.secondaryText }]}
                            rowStyle={{ flex: 1, marginBottom: 0 }}
                        />
                        {field.canReorder ? (
                            <TouchableOpacity
                                accessibilityRole="button"
                                accessibilityLabel={checklistOrderMode ? field.labels.done : field.labels.reorder}
                                onPress={() => setChecklistOrderMode((value) => !value)}
                                style={[styles.checklistHeaderButton, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                testID="mobile-checklist-order-toggle"
                            >
                                <Text style={[styles.checklistHeaderButtonText, { color: tc.tint }]}>
                                    {checklistOrderMode ? field.labels.done : field.labels.reorder}
                                </Text>
                            </TouchableOpacity>
                        ) : null}
                    </View>
                    {draft?.recurrence && task?.taskMode !== 'list' && !isReference && Boolean(checklist?.length) && (
                        <View>
                            <View style={styles.checklistHeader}>
                                <Text style={[styles.label, { color: tc.text, flex: 1 }]}>{t('taskEdit.resetChecklistOnRepeat')}</Text>
                                <Switch value={!draft.preserveChecklistOnRepeat}
                                    accessibilityLabel={t('taskEdit.resetChecklistOnRepeat')}
                                    onValueChange={(reset) => setDraftField('preserveChecklistOnRepeat', !reset)} />
                            </View>
                            <Text style={[styles.helperText, { color: tc.secondaryText }]}>{t('taskEdit.resetChecklistOnRepeatHint')}</Text>
                        </View>
                    )}
                    <View style={[styles.checklistContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                        {checklistOrderMode ? (
                            <View style={styles.checklistOrderPanel} testID="mobile-checklist-order-panel">
                                {field.items.map((item) => {
                                    const { index, orderTitle: itemTitle, canMoveUp, canMoveDown } = item;
                                    const checklistItemKey = getChecklistItemKey(item, index);

                                    return (
                                        <View
                                            key={checklistItemKey}
                                            style={[
                                                styles.checklistOrderItem,
                                                { borderBottomColor: tc.border },
                                            ]}
                                        >
                                            <Text
                                                style={[styles.checklistOrderTitle, { color: item.struck ? tc.secondaryText : tc.text }]}
                                                numberOfLines={1}
                                            >
                                                {itemTitle}
                                            </Text>
                                            <View style={styles.checklistOrderControls}>
                                                <TouchableOpacity
                                                    accessibilityRole="button"
                                                    accessibilityLabel={item.moveUpLabel}
                                                    disabled={!canMoveUp}
                                                    onPress={() => handleChecklistMove(index, index - 1)}
                                                    style={[
                                                        styles.checklistOrderButton,
                                                        { borderColor: tc.border, backgroundColor: tc.filterBg },
                                                        !canMoveUp && styles.checklistOrderButtonDisabled,
                                                    ]}
                                                    testID={`mobile-checklist-move-up-${checklistItemKey}`}
                                                >
                                                    <Ionicons name="chevron-up" size={18} color={canMoveUp ? tc.tint : tc.secondaryText} />
                                                </TouchableOpacity>
                                                <TouchableOpacity
                                                    accessibilityRole="button"
                                                    accessibilityLabel={item.moveDownLabel}
                                                    disabled={!canMoveDown}
                                                    onPress={() => handleChecklistMove(index, index + 1)}
                                                    style={[
                                                        styles.checklistOrderButton,
                                                        { borderColor: tc.border, backgroundColor: tc.filterBg },
                                                        !canMoveDown && styles.checklistOrderButtonDisabled,
                                                    ]}
                                                    testID={`mobile-checklist-move-down-${checklistItemKey}`}
                                                >
                                                    <Ionicons name="chevron-down" size={18} color={canMoveDown ? tc.tint : tc.secondaryText} />
                                                </TouchableOpacity>
                                            </View>
                                        </View>
                                    );
                                })}
                            </View>
                        ) : (
                            <>
                                {field.items.map((item) => {
                                    const { index } = item;
                                    const checklistItemKey = getChecklistItemKey(item, index);
                                    return (
                                        <View
                                            key={checklistItemKey}
                                            style={[
                                                styles.checklistItem,
                                                { borderBottomColor: tc.border },
                                            ]}
                                        >
                                            <TouchableOpacity
                                                accessibilityRole="checkbox"
                                                accessibilityLabel={item.checkboxLabel}
                                                accessibilityState={{ checked: item.completed }}
                                                onPress={() => editChecklist({ kind: 'toggle', index })}
                                                style={styles.checkboxTouch}
                                            >
                                                <View style={[
                                                    styles.checkbox,
                                                    { borderColor: tc.tint },
                                                    item.completed && { backgroundColor: tc.tint },
                                                ]}>
                                                    {item.completed && <Check size={12} color={tc.onTint} strokeWidth={3} />}
                                                </View>
                                            </TouchableOpacity>
                                            <TextInput
                                                ref={getChecklistInputRef(checklistItemKey)}
                                                onLayout={() => handleChecklistRowLayout(checklistItemKey)}
                                                style={[
                                                    styles.checklistInput,
                                                    textDirectionStyle,
                                                    { color: item.struck ? tc.secondaryText : tc.text },
                                                    item.struck && styles.completedText,
                                                ]}
                                                value={item.title}
                                                onFocus={(event) => {
                                                    if (event.nativeEvent.target) {
                                                        handleInputFocus(event.nativeEvent.target);
                                                    }
                                                }}
                                                onChangeText={(text) => handleChecklistTitleChange(index, checklistItemKey, text)}
                                                onSelectionChange={(event) => handleChecklistSelectionChange(
                                                    checklistItemKey,
                                                    event.nativeEvent.selection,
                                                )}
                                                // Native caret movement must not be overwritten by a stale ref on iOS.
                                                selection={checklistSelectionRestorePending[checklistItemKey] ? getControlledTextInputSelection(
                                                    checklistSelectionRefs.current[checklistItemKey] ?? {
                                                        start: item.title.length,
                                                        end: item.title.length,
                                                    },
                                                    { force: Boolean(checklistSelectionRestorePending[checklistItemKey]) },
                                                ) : undefined}
                                                placeholder={field.labels.placeholder}
                                                placeholderTextColor={tc.secondaryText}
                                                accessibilityLabel={item.inputLabel}
                                                accessibilityHint={field.labels.placeholder}
                                                returnKeyType="next"
                                                blurOnSubmit={false}
                                                onSubmitEditing={() => handleChecklistSubmit(index, checklistItemKey)}
                                            />
                                            <TouchableOpacity
                                                onPress={() => editChecklist({ kind: 'remove', index })}
                                                style={styles.deleteBtn}
                                            >
                                                <Text style={[styles.deleteBtnText, { color: tc.secondaryText }]}>×</Text>
                                            </TouchableOpacity>
                                        </View>
                                    );
                                })}
                                <TouchableOpacity
                                    style={[styles.addChecklistBtn, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                    onPress={() => {
                                        const result = applyTaskChecklistEdit(checklist, { kind: 'add' }, { newId: generateUUID });
                                        if (!result) return;
                                        if (result.focusId) requestChecklistInsertionFocus(result.focusId);
                                        applyChecklistUpdate(result.checklist);
                                    }}
                                    testID="mobile-checklist-add-item"
                                >
                                    <Plus size={14} color={tc.tint} accessible={false} />
                                    <Text style={[styles.addChecklistText, { color: tc.tint }]}>{field.labels.add}</Text>
                                </TouchableOpacity>
                                {field.canReset && (
                                    <View style={styles.checklistActions}>
                                        <TouchableOpacity
                                            style={[styles.checklistActionButton, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                            onPress={handleResetChecklist}
                                        >
                                            <Text style={[styles.checklistActionText, { color: tc.secondaryText }]}>
                                                {field.labels.reset}
                                            </Text>
                                        </TouchableOpacity>
                                    </View>
                                )}
                            </>
                        )}
                    </View>
                </View>
            );
        }
        default:
            return null;
    }
}

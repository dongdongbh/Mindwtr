import React from 'react';
import {
    Text,
    TextInput,
    TouchableOpacity,
    View,
    Platform,
    findNodeHandle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
    AlignLeft,
    Eye,
    ListChecks,
    Paperclip,
    Pencil,
    Trash2,
    Navigation,
    Plus,
} from 'lucide-react-native';
import {
    generateUUID,
    getAttachmentDisplayTitle,
    isMarkdownEditorAssistEnabled,
    parsePastedChecklistItems,
    resolveAutoTextDirection,
    useTaskStore,
    type MarkdownSelection,
    type Task,
} from '@mindwtr/core';

import { MarkdownReferenceAutocomplete } from '../markdown-reference-autocomplete';
import { MarkdownText } from '../markdown-text';
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

export const reorderChecklistItems = (
    checklist: Task['checklist'],
    fromIndex: number,
    toIndex: number,
): Task['checklist'] => {
    const items = checklist || [];

    if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= items.length ||
        toIndex >= items.length
    ) {
        return items;
    }

    const nextItems = [...items];
    const [movedItem] = nextItems.splice(fromIndex, 1);

    if (!movedItem) {
        return items;
    }

    nextItems.splice(toIndex, 0, movedItem);
    return nextItems;
};

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
    const combinedText = `${titleDraft ?? ''}\n${descriptionDraft ?? ''}`.trim();
    const resolvedDirection = resolveAutoTextDirection(combinedText, language);
    const textDirectionStyle = {
        writingDirection: resolvedDirection,
        textAlign: resolvedDirection === 'rtl' ? 'right' : 'left',
    } as const;
    const checklistInputRefs = React.useRef<Record<string, TextInput | null>>({});
    const checklistTitleRefs = React.useRef<Record<string, string>>({});
    const checklistSelectionRefs = React.useRef<Record<string, MarkdownSelection>>({});
    const lastChecklistRangeRefs = React.useRef<Record<string, MarkdownSelection | null>>({});
    const ignoredNativePairChangeRefs = React.useRef<Record<string, IgnoredNativePairChange>>({});
    const pendingChecklistSelectionRefs = React.useRef<Record<string, MarkdownSelection | null>>({});
    const [checklistSelectionRestorePending, setChecklistSelectionRestorePending] = React.useState<Record<string, boolean>>({});
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
        }
    }, [checklist]);

    const pendingChecklistFocusKeyRef = React.useRef<string | null>(null);
    // A just-added row is focused from its first onLayout, not the mount commit:
    // focusing before native layout makes Android's ScrollView scroll-to-focused-
    // child measure the unpositioned row and jump to the top of the checklist.
    const handleChecklistRowLayout = React.useCallback((key: string) => {
        if (pendingChecklistFocusKeyRef.current !== key) return;
        pendingChecklistFocusKeyRef.current = null;
        checklistInputRefs.current[key]?.focus();
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
        const list = checklist || [];
        const current = list[index];
        if (!current) return;
        const title = (checklistTitleRefs.current[key] ?? current.title).trim();
        if (!title) {
            checklistInputRefs.current[key]?.blur();
            return;
        }
        const nextItem = {
            id: generateUUID(),
            title: '',
            isCompleted: false,
        };
        pendingChecklistFocusKeyRef.current = nextItem.id;
        applyChecklistUpdate([...list.slice(0, index + 1), nextItem, ...list.slice(index + 1)]);
    }, [applyChecklistUpdate, checklist]);

    const updateChecklistTitle = React.useCallback((index: number, key: string, title: string) => {
        checklistTitleRefs.current[key] = title;
        const nextChecklist = (checklist || []).map((entry, entryIndex) =>
            entryIndex === index ? { ...entry, title } : entry
        );
        applyChecklistUpdate(nextChecklist);
    }, [applyChecklistUpdate, checklist]);

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
            const [first, ...rest] = parsePastedChecklistItems(text);
            const list = checklist || [];
            const current = list[index];
            if (!current) return;
            const updatedCurrent = {
                ...current,
                title: first?.title ?? '',
                isCompleted: current.isCompleted || (first?.isCompleted ?? false),
            };
            const inserted = rest.map((item) => ({
                id: generateUUID(),
                title: item.title,
                isCompleted: item.isCompleted,
            }));
            checklistTitleRefs.current[key] = updatedCurrent.title;
            checklistSelectionRefs.current[key] = {
                start: updatedCurrent.title.length,
                end: updatedCurrent.title.length,
            };
            lastChecklistRangeRefs.current[key] = null;
            applyChecklistUpdate([...list.slice(0, index), updatedCurrent, ...inserted, ...list.slice(index + 1)]);
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
        if (from === to || to < 0) return;

        applyChecklistUpdate(reorderChecklistItems(checklist, from, to) || []);
    }, [applyChecklistUpdate, checklist]);

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
                                const canDownload = isMissing && Boolean(attachment.cloudKey);
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
            const checklistItems = checklist || [];
            const canReorderChecklist = checklistItems.length > 1;
            const hasEmptyChecklistItem = checklistItems.some((item) => item.title.trim().length === 0);

            return (
                <View style={styles.formGroup}>
                    <View style={styles.checklistHeader}>
                        <FieldHeading
                            icon={ListChecks}
                            label={t('taskEdit.checklist')}
                            iconColor={tc.secondaryText}
                            labelStyle={[styles.label, styles.checklistHeaderLabel, { color: tc.secondaryText }]}
                            rowStyle={{ flex: 1, marginBottom: 0 }}
                        />
                        {canReorderChecklist ? (
                            <TouchableOpacity
                                accessibilityRole="button"
                                accessibilityLabel={checklistOrderMode ? t('common.done') : t('projects.reorderTasks')}
                                onPress={() => setChecklistOrderMode((value) => !value)}
                                style={[styles.checklistHeaderButton, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                testID="mobile-checklist-order-toggle"
                            >
                                <Text style={[styles.checklistHeaderButtonText, { color: tc.tint }]}>
                                    {checklistOrderMode ? t('common.done') : t('projects.reorderTasks')}
                                </Text>
                            </TouchableOpacity>
                        ) : null}
                    </View>
                    <View style={[styles.checklistContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                        {checklistOrderMode ? (
                            <View style={styles.checklistOrderPanel} testID="mobile-checklist-order-panel">
                                {checklistItems.map((item, index) => {
                                    const checklistItemKey = getChecklistItemKey(item, index);
                                    const itemTitle = item.title.trim() || t('taskEdit.itemNamePlaceholder');
                                    const canMoveUp = index > 0;
                                    const canMoveDown = index < checklistItems.length - 1;

                                    return (
                                        <View
                                            key={checklistItemKey}
                                            style={[
                                                styles.checklistOrderItem,
                                                { borderBottomColor: tc.border },
                                            ]}
                                        >
                                            <Text
                                                style={[styles.checklistOrderTitle, { color: item.isCompleted ? tc.secondaryText : tc.text }]}
                                                numberOfLines={1}
                                            >
                                                {itemTitle}
                                            </Text>
                                            <View style={styles.checklistOrderControls}>
                                                <TouchableOpacity
                                                    accessibilityRole="button"
                                                    accessibilityLabel={`${t('projects.moveUp')}: ${itemTitle}`}
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
                                                    accessibilityLabel={`${t('projects.moveDown')}: ${itemTitle}`}
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
                                {checklistItems.map((item, index) => {
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
                                                accessibilityLabel={item.title.trim() || t('taskEdit.itemNamePlaceholder')}
                                                accessibilityState={{ checked: item.isCompleted }}
                                                onPress={() => {
                                            const nextChecklist = (checklist || []).map((entry, entryIndex) =>
                                                        entryIndex === index ? { ...entry, isCompleted: !entry.isCompleted } : entry
                                                    );
                                                    applyChecklistUpdate(nextChecklist);
                                                }}
                                                style={styles.checkboxTouch}
                                            >
                                                <View style={[
                                                    styles.checkbox,
                                                    { borderColor: tc.tint },
                                                    item.isCompleted && { backgroundColor: tc.tint },
                                                ]}>
                                                    {item.isCompleted && <Text style={[styles.checkmark, { color: tc.onTint }]}>✓</Text>}
                                                </View>
                                            </TouchableOpacity>
                                            <TextInput
                                                ref={(node) => {
                                                    checklistInputRefs.current[checklistItemKey] = node;
                                                }}
                                                onLayout={() => handleChecklistRowLayout(checklistItemKey)}
                                                style={[
                                                    styles.checklistInput,
                                                    textDirectionStyle,
                                                    { color: item.isCompleted ? tc.secondaryText : tc.text },
                                                    item.isCompleted && styles.completedText,
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
                                                selection={getControlledTextInputSelection(
                                                    checklistSelectionRefs.current[checklistItemKey] ?? {
                                                        start: item.title.length,
                                                        end: item.title.length,
                                                    },
                                                    { force: Boolean(checklistSelectionRestorePending[checklistItemKey]) },
                                                )}
                                                placeholder={t('taskEdit.itemNamePlaceholder')}
                                                placeholderTextColor={tc.secondaryText}
                                                accessibilityLabel={`${t('taskEdit.checklist')} ${index + 1}`}
                                                accessibilityHint={t('taskEdit.itemNamePlaceholder')}
                                                returnKeyType="next"
                                                blurOnSubmit={false}
                                                onSubmitEditing={() => handleChecklistSubmit(index, checklistItemKey)}
                                            />
                                            <TouchableOpacity
                                                onPress={() => {
                                            const nextChecklist = (checklist || []).filter((_, entryIndex) => entryIndex !== index);
                                                    applyChecklistUpdate(nextChecklist);
                                                }}
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
                                        if (hasEmptyChecklistItem) return;
                                        const nextItem = {
                                            id: generateUUID(),
                                            title: '',
                                            isCompleted: false,
                                        };
                                        pendingChecklistFocusKeyRef.current = nextItem.id;
                                applyChecklistUpdate([...(checklist || []), nextItem]);
                                    }}
                                    testID="mobile-checklist-add-item"
                                >
                                    <Plus size={14} color={tc.tint} accessible={false} />
                                    <Text style={[styles.addChecklistText, { color: tc.tint }]}>{t('taskEdit.addItem')}</Text>
                                </TouchableOpacity>
                    {(checklist?.length ?? 0) > 0 && (
                                    <View style={styles.checklistActions}>
                                        <TouchableOpacity
                                            style={[styles.checklistActionButton, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                            onPress={handleResetChecklist}
                                        >
                                            <Text style={[styles.checklistActionText, { color: tc.secondaryText }]}>
                                                {t('taskEdit.resetChecklist')}
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

import React from 'react';
import { AccessibilityInfo, Image, Modal, Platform, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { formatI18nTemplate, parseAttachmentLinkBatch, translateWithFallback, type Attachment } from '@mindwtr/core';

import { styles } from './task-edit-modal.styles';
import { logTaskError } from './task-edit-modal.utils';
import { shareFileWithFeedback } from '../../lib/share-file-with-feedback';
import { useKeyboardInset } from '../../lib/use-android-keyboard-inset';

type ThemeColors = {
    cardBg: string;
    border: string;
    text: string;
    secondaryText: string;
    inputBg: string;
    tint: string;
    danger: string;
};

type Translator = (key: string) => string;

type TaskEditLinkModalProps = {
    visible: boolean;
    t: Translator;
    tc: ThemeColors;
    title: string;
    multiline: boolean;
    linkInput: string;
    linkInputTouched: boolean;
    onChangeLinkInput: (value: string) => void;
    onBlurLinkInput: () => void;
    onClose: () => void;
    onSave: () => void;
};

export const TaskEditLinkModal = ({
    visible,
    t,
    tc,
    title,
    multiline,
    linkInput,
    linkInputTouched,
    onChangeLinkInput,
    onBlurLinkInput,
    onClose,
    onSave,
}: TaskEditLinkModalProps) => {
    const invalidLine = multiline ? parseAttachmentLinkBatch(linkInput).invalidLine : null;
    const error = invalidLine !== null
        ? formatI18nTemplate(t('attachments.invalidLinkLine'), { line: invalidLine })
        : null;
    const keyboardInset = useKeyboardInset(visible);
    React.useEffect(() => {
        if (visible && error && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(error);
    }, [visible, error]);
    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={onClose}
        >
            <View style={keyboardInset > 0 ? [styles.overlay, { paddingBottom: keyboardInset }] : styles.overlay}>
                <View style={[styles.modalCard, { maxHeight: '100%', backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                    <Text style={[styles.modalTitle, { color: tc.text }]}>{title}</Text>
                    <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled">
                    <TextInput
                        value={linkInput}
                        onChangeText={onChangeLinkInput}
                        onBlur={onBlurLinkInput}
                        placeholder={t('attachments.linkPlaceholder')}
                        placeholderTextColor={tc.secondaryText}
                        autoCapitalize="none"
                        autoCorrect={false}
                        multiline={multiline}
                        textAlignVertical={multiline ? 'top' : undefined}
                        style={[styles.modalInput, multiline && { height: 120 }, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                        returnKeyType={multiline ? undefined : 'done'}
                        accessibilityLabel={t('attachments.addLink')}
                        accessibilityHint={t(multiline ? 'attachments.linkBatchHint' : 'attachments.linkInputHint')}
                    />
                    <Text style={[styles.modalLabel, { color: tc.secondaryText, marginTop: 8 }]}>
                        {t(multiline ? 'attachments.linkBatchHint' : 'attachments.linkInputHint')}
                    </Text>
                    {linkInputTouched && !linkInput.trim() && (
                        <Text style={[styles.validationText, { color: tc.danger }]}>
                            {t('common.validationRequired')}
                        </Text>
                    )}
                    {error && <Text accessibilityLiveRegion="polite" style={[styles.validationText, { color: tc.danger }]}>{error}</Text>}
                    </ScrollView>
                    <View style={styles.modalButtons}>
                        <TouchableOpacity
                            onPress={onClose}
                            style={styles.modalButton}
                        >
                            <Text style={[styles.modalButtonText, { color: tc.secondaryText }]}>{t('common.cancel')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            onPress={onSave}
                            disabled={!linkInput.trim() || Boolean(error)}
                            style={[styles.modalButton, (!linkInput.trim() || error) && styles.modalButtonDisabled]}
                        >
                            <Text style={[styles.modalButtonText, { color: tc.tint }]}>{t('common.save')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        </Modal>
    );
};

type TaskEditWaitingAssignmentModalProps = {
    visible: boolean;
    t: Translator;
    tc: ThemeColors;
    value: string;
    suggestions?: string[];
    onChangeValue: (value: string) => void;
    onClose: () => void;
    onSave: () => void;
};

export const TaskEditWaitingAssignmentModal = ({
    visible,
    t,
    tc,
    value,
    suggestions = [],
    onChangeValue,
    onClose,
    onSave,
}: TaskEditWaitingAssignmentModalProps) => {
    const title = translateWithFallback(t, 'process.waitingFor', 'Who/what are you waiting for?');
    const description = translateWithFallback(
        t,
        'process.waitingForDesc',
        "Add a note to remember what you're waiting on",
    );
    const placeholder = translateWithFallback(
        t,
        'taskEdit.assignedToPlaceholder',
        'Who is this waiting for?',
    );

    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={onClose}
        >
            <Pressable style={styles.overlay} onPress={onClose}>
                <Pressable
                    style={[styles.modalCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                    onPress={(event) => event.stopPropagation()}
                >
                    <Text style={[styles.modalTitle, { color: tc.text }]}>{title}</Text>
                    <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{description}</Text>
                    <TextInput
                        value={value}
                        onChangeText={onChangeValue}
                        placeholder={placeholder}
                        placeholderTextColor={tc.secondaryText}
                        style={[styles.modalInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                        autoCapitalize="words"
                        returnKeyType="done"
                        accessibilityLabel={title}
                        accessibilityHint={description}
                        onSubmitEditing={onSave}
                    />
                    {suggestions.length > 0 && (
                        <View style={[styles.tokenSuggestionsMenu, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            {suggestions.map((name, index) => (
                                <TouchableOpacity
                                    key={name}
                                    style={[
                                        styles.tokenSuggestionItem,
                                        index === suggestions.length - 1 ? styles.tokenSuggestionItemLast : null,
                                    ]}
                                    onPress={() => onChangeValue(name)}
                                >
                                    <Text style={[styles.tokenSuggestionText, { color: tc.text }]}>{name}</Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                    )}
                    <View style={styles.modalButtons}>
                        <TouchableOpacity onPress={onClose} style={styles.modalButton}>
                            <Text style={[styles.modalButtonText, { color: tc.secondaryText }]}>{t('common.cancel')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={onSave} style={styles.modalButton}>
                            <Text style={[styles.modalButtonText, { color: tc.tint }]}>{t('common.save')}</Text>
                        </TouchableOpacity>
                    </View>
                </Pressable>
            </Pressable>
        </Modal>
    );
};

type AudioStatusLike = {
    isLoaded?: boolean;
    playing?: boolean;
    currentTime?: number;
    duration?: number;
} | null | undefined;

const formatAudioTimestamp = (millis?: number): string => {
    if (!millis || millis < 0) return '0:00';
    const totalSeconds = Math.floor(millis / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

type TaskEditAudioModalProps = {
    visible: boolean;
    t: Translator;
    tc: ThemeColors;
    audioTitle?: string;
    audioStatus?: AudioStatusLike;
    audioLoading: boolean;
    audioTranscribing: boolean;
    audioTranscriptionError?: string | null;
    onTogglePlayback: () => void;
    onRetryTranscription: () => void;
    onClose: () => void;
};

export const TaskEditAudioModal = ({
    visible,
    t,
    tc,
    audioTitle,
    audioStatus,
    audioLoading,
    audioTranscribing,
    audioTranscriptionError,
    onTogglePlayback,
    onRetryTranscription,
    onClose,
}: TaskEditAudioModalProps) => {
    const resolveText = (key: string, fallback: string) => translateWithFallback(t, key, fallback);

    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={onClose}
        >
            <Pressable style={styles.overlay} onPress={onClose}>
                <Pressable
                    style={[styles.modalCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                    onPress={(event) => event.stopPropagation()}
                >
                    <Text style={[styles.modalTitle, { color: tc.text }]}>
                        {audioTitle || t('quickAdd.audioNoteTitle')}
                    </Text>
                    <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>
                        {audioStatus?.isLoaded
                            ? `${formatAudioTimestamp((audioStatus.currentTime ?? 0) * 1000)} / ${formatAudioTimestamp((audioStatus.duration ?? 0) * 1000)}`
                            : t('audio.loading')}
                    </Text>
                    {audioTranscriptionError ? (
                        <Text style={[styles.validationText, { color: tc.danger }]}>
                            {audioTranscriptionError}
                        </Text>
                    ) : null}
                    <View style={styles.modalButtons}>
                        <TouchableOpacity
                            onPress={onTogglePlayback}
                            disabled={audioLoading || !audioStatus?.isLoaded || audioTranscribing}
                            style={[styles.modalButton, (audioLoading || !audioStatus?.isLoaded || audioTranscribing) && styles.modalButtonDisabled]}
                        >
                            <Text style={[styles.modalButtonText, { color: tc.tint }]}>
                                {audioStatus?.isLoaded && audioStatus.playing ? t('common.pause') : t('common.play')}
                            </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            onPress={onRetryTranscription}
                            disabled={audioTranscribing}
                            style={[styles.modalButton, audioTranscribing && styles.modalButtonDisabled]}
                        >
                            <Text style={[styles.modalButtonText, { color: tc.tint }]}>
                                {audioTranscribing
                                    ? resolveText('attachments.transcribing', 'Transcribing...')
                                    : resolveText('attachments.retryTranscription', 'Re-transcribe')}
                            </Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={onClose} style={styles.modalButton}>
                            <Text style={[styles.modalButtonText, { color: tc.secondaryText }]}>{t('common.close')}</Text>
                        </TouchableOpacity>
                    </View>
                </Pressable>
            </Pressable>
        </Modal>
    );
};

type TaskEditImagePreviewModalProps = {
    visible: boolean;
    t: Translator;
    tc: ThemeColors;
    imagePreviewAttachment: Attachment | null;
    onClose: () => void;
};

export const TaskEditImagePreviewModal = ({
    visible,
    t,
    tc,
    imagePreviewAttachment,
    onClose,
}: TaskEditImagePreviewModalProps) => (
    <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={onClose}
    >
        <Pressable style={styles.previewOverlay} onPress={onClose}>
            <Pressable
                style={[styles.previewCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                onPress={(event) => event.stopPropagation()}
            >
                <View style={styles.previewHeader}>
                    <Text
                        numberOfLines={1}
                        style={[styles.previewTitle, { color: tc.text }]}
                    >
                        {imagePreviewAttachment?.title || t('attachments.title')}
                    </Text>
                    {imagePreviewAttachment?.uri ? (
                        <TouchableOpacity
                            onPress={() => {


                                void shareFileWithFeedback(imagePreviewAttachment.uri, t, (error) =>
                                    logTaskError('Failed to share attachment', error));
                            }}
                            style={styles.modalButton}
                        >
                            <Text style={[styles.modalButtonText, { color: tc.tint }]}>{t('common.share')}</Text>
                        </TouchableOpacity>
                    ) : null}
                    <TouchableOpacity onPress={onClose} style={styles.modalButton}>
                        <Text style={[styles.modalButtonText, { color: tc.secondaryText }]}>{t('common.close')}</Text>
                    </TouchableOpacity>
                </View>
                {imagePreviewAttachment?.uri ? (
                    <Image
                        source={{ uri: imagePreviewAttachment.uri }}
                        style={styles.previewImage}
                        resizeMode="contain"
                    />
                ) : (
                    <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('attachments.missing')}</Text>
                )}
            </Pressable>
        </Pressable>
    </Modal>
);

import React from 'react';
import { Image, Modal, Pressable, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { translateWithFallback, type Attachment } from '@mindwtr/core';

import { styles } from './task-edit-modal.styles';

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
    linkInput,
    linkInputTouched,
    onChangeLinkInput,
    onBlurLinkInput,
    onClose,
    onSave,
}: TaskEditLinkModalProps) => (
    <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={onClose}
    >
        <View style={styles.overlay}>
            <View style={[styles.modalCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                <Text style={[styles.modalTitle, { color: tc.text }]}>{t('attachments.addLink')}</Text>
                <TextInput
                    value={linkInput}
                    onChangeText={onChangeLinkInput}
                    onBlur={onBlurLinkInput}
                    placeholder={t('attachments.linkPlaceholder')}
                    placeholderTextColor={tc.secondaryText}
                    style={[styles.modalInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="done"
                    accessibilityLabel={t('attachments.addLink')}
                    accessibilityHint={t('attachments.linkInputHint')}
                />
                <Text style={[styles.modalLabel, { color: tc.secondaryText, marginTop: 8 }]}>
                    {t('attachments.linkInputHint')}
                </Text>
                {linkInputTouched && !linkInput.trim() && (
                    <Text style={[styles.validationText, { color: tc.danger }]}>
                        Link is required.
                    </Text>
                )}
                <View style={styles.modalButtons}>
                    <TouchableOpacity
                        onPress={onClose}
                        style={styles.modalButton}
                    >
                        <Text style={[styles.modalButtonText, { color: tc.secondaryText }]}>{t('common.cancel')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        onPress={onSave}
                        style={[styles.modalButton, !linkInput.trim() && styles.modalButtonDisabled]}
                    >
                        <Text style={[styles.modalButtonText, { color: tc.tint }]}>{t('common.save')}</Text>
                    </TouchableOpacity>
                </View>
            </View>
        </View>
    </Modal>
);

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

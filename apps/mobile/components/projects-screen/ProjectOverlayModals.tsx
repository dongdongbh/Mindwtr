import React from 'react';
import { AccessibilityInfo, Image, Modal, Platform, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { formatI18nTemplate, parseAttachmentLinkBatch, type Attachment } from '@mindwtr/core';
import { logError } from '../../lib/app-log';
import { shareFileWithFeedback } from '../../lib/share-file-with-feedback';

import { projectsScreenStyles as styles } from '@/components/projects-screen/projects-screen.styles';
import { useAndroidKeyboardInset, useKeyboardInset } from '../../lib/use-android-keyboard-inset';

type ThemeColors = {
    border: string;
    cardBg: string;
    filterBg: string;
    inputBg: string;
    secondaryText: string;
    text: string;
    tint: string;
};

type OverlayPresentationStyle = 'overFullScreen' | 'fullScreen';

type SharedOverlayProps = {
    presentationStyle: OverlayPresentationStyle;
    tc: ThemeColors;
    t: (key: string) => string;
};

type ProjectLinkModalProps = SharedOverlayProps & {
    visible: boolean;
    linkInput: string;
    onChangeLinkInput: (value: string) => void;
    onClose: () => void;
    onSave: () => void;
};

export function ProjectLinkModal({
    visible,
    presentationStyle,
    tc,
    t,
    linkInput,
    onChangeLinkInput,
    onClose,
    onSave,
}: ProjectLinkModalProps) {
    const keyboardInset = useKeyboardInset(visible);
    const invalidLine = parseAttachmentLinkBatch(linkInput).invalidLine;
    const error = invalidLine === null ? null : formatI18nTemplate(t('attachments.invalidLinkLine'), { line: invalidLine });
    React.useEffect(() => {
        if (visible && error && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(error);
    }, [visible, error]);
    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            presentationStyle={presentationStyle}
            onRequestClose={onClose}
        >
            <View style={keyboardInset > 0 ? [styles.overlay, { paddingBottom: keyboardInset }] : styles.overlay}>
                <View style={[styles.linkModalCard, { maxHeight: '100%', backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                    <Text style={[styles.linkModalTitle, { color: tc.text }]}>{t('attachments.addLink')}</Text>
                    <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled">
                    <TextInput
                        value={linkInput}
                        onChangeText={onChangeLinkInput}
                        placeholder={t('attachments.linkPlaceholder')}
                        placeholderTextColor={tc.secondaryText}
                        style={[
                            styles.linkModalInput,
                            { height: 120, backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text },
                        ]}
                        autoCapitalize="none"
                        autoCorrect={false}
                        multiline
                        textAlignVertical="top"
                        accessibilityLabel={t('attachments.addLink')}
                        accessibilityHint={t('attachments.linkBatchHint')}
                    />
                    <Text style={[styles.linkModalHint, { color: tc.secondaryText }]}>
                        {t('attachments.linkBatchHint')}
                    </Text>
                    {error && <Text accessibilityLiveRegion="polite" style={[styles.linkModalHint, { color: tc.text }]}>{error}</Text>}
                    </ScrollView>
                    <View style={styles.linkModalButtons}>
                        <TouchableOpacity onPress={onClose} style={styles.linkModalButton}>
                            <Text style={[styles.linkModalButtonText, { color: tc.secondaryText }]}>
                                {t('common.cancel')}
                            </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            onPress={onSave}
                            disabled={!linkInput.trim() || Boolean(error)}
                            style={[styles.linkModalButton, (!linkInput.trim() || error) && styles.linkModalButtonDisabled]}
                        >
                            <Text style={[styles.linkModalButtonText, { color: tc.tint }]}>{t('common.save')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        </Modal>
    );
}

type ProjectImagePreviewModalProps = SharedOverlayProps & {
    attachment: Attachment | null;
    visible: boolean;
    onClose: () => void;
};

export function ProjectImagePreviewModal({
    attachment,
    visible,
    presentationStyle,
    tc,
    t,
    onClose,
}: ProjectImagePreviewModalProps) {
    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            presentationStyle={presentationStyle}
            onRequestClose={onClose}
        >
            <Pressable style={styles.overlay} onPress={onClose}>
                <Pressable
                    style={[styles.previewCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                    onPress={(event) => event.stopPropagation()}
                >
                    <View style={styles.previewHeader}>
                        <Text style={[styles.previewTitle, { color: tc.text }]} numberOfLines={1}>
                            {attachment?.title || t('attachments.title')}
                        </Text>
                        {attachment?.uri ? (
                            <TouchableOpacity
                                onPress={() => {


                                    void shareFileWithFeedback(attachment.uri, t, (error) => {
                                        void logError(error, { scope: 'project', extra: { message: 'Failed to share attachment' } });
                                    });
                                }}
                                style={styles.smallButton}
                            >
                                <Text style={[styles.smallButtonText, { color: tc.tint }]}>
                                    {t('common.share')}
                                </Text>
                            </TouchableOpacity>
                        ) : null}
                        <TouchableOpacity onPress={onClose} style={styles.smallButton}>
                            <Text style={[styles.smallButtonText, { color: tc.secondaryText }]}>
                                {t('common.close')}
                            </Text>
                        </TouchableOpacity>
                    </View>
                    {attachment?.uri ? (
                        <Image source={{ uri: attachment.uri }} style={styles.previewImage} resizeMode="contain" />
                    ) : (
                        <Text style={[styles.helperText, { color: tc.secondaryText }]}>{t('attachments.missing')}</Text>
                    )}
                </Pressable>
            </Pressable>
        </Modal>
    );
}

type ProjectTagPickerModalProps = SharedOverlayProps & {
    visible: boolean;
    tagDraft: string;
    projectTagOptions: string[];
    selectedTags: string[];
    onAddTag: () => void;
    onChangeTagDraft: (value: string) => void;
    onClose: () => void;
    onToggleTag: (tag: string) => void;
};

export function ProjectTagPickerModal({
    visible,
    presentationStyle,
    tc,
    t,
    tagDraft,
    projectTagOptions,
    selectedTags,
    onAddTag,
    onChangeTagDraft,
    onClose,
    onToggleTag,
}: ProjectTagPickerModalProps) {
    const keyboardInset = useAndroidKeyboardInset(visible);
    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            presentationStyle={presentationStyle}
            onRequestClose={onClose}
        >
            <Pressable
                style={keyboardInset > 0 ? [styles.overlay, { paddingBottom: keyboardInset }] : styles.overlay}
                onPress={onClose}
            >
                <Pressable
                    style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                    onPress={(event) => event.stopPropagation()}
                >
                    <Text style={[styles.linkModalTitle, { color: tc.text }]}>{t('taskEdit.tagsLabel')}</Text>
                    <View style={[styles.tagInputRow, { borderColor: tc.border, backgroundColor: tc.inputBg }]}>
                        <TextInput
                            value={tagDraft}
                            onChangeText={onChangeTagDraft}
                            placeholder={t('taskEdit.tagsLabel')}
                            placeholderTextColor={tc.secondaryText}
                            style={[styles.tagInput, { color: tc.text }]}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                        <TouchableOpacity
                            onPress={onAddTag}
                            style={[styles.tagAddButton, { borderColor: tc.border }]}
                        >
                            <Text style={[styles.tagAddButtonText, { color: tc.tint }]}>+</Text>
                        </TouchableOpacity>
                    </View>
                    <View style={styles.tagOptions}>
                        {projectTagOptions.map((tag) => {
                            const isActive = selectedTags.includes(tag);
                            return (
                                <TouchableOpacity
                                    key={tag}
                                    onPress={() => onToggleTag(tag)}
                                    style={[
                                        styles.tagOption,
                                        {
                                            borderColor: tc.border,
                                            backgroundColor: isActive ? tc.filterBg : tc.cardBg,
                                        },
                                    ]}
                                >
                                    <Text style={[styles.tagOptionText, { color: tc.text }]}>{tag}</Text>
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                </Pressable>
            </Pressable>
        </Modal>
    );
}

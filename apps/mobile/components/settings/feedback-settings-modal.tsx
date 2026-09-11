import React, { useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    type ScrollViewProps,
    Switch,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { Bug, Lightbulb, MessageSquare, X, type LucideIcon } from 'lucide-react-native';

import { FEEDBACK_CATEGORIES, type FeedbackCategory } from '@mindwtr/core';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { styles } from './settings.styles';

export type FeedbackSubmitInput = {
    category: FeedbackCategory;
    message: string;
    email?: string;
    includeDiagnostics: boolean;
};

type FeedbackSettingsModalProps = {
    visible: boolean;
    isConfigured: boolean;
    tr: (key: string) => string;
    onClose: () => void;
    onOpenGitHub?: (category: FeedbackCategory) => void;
    onSubmit: (input: FeedbackSubmitInput) => Promise<void>;
};

const categoryIcons: Record<FeedbackCategory, LucideIcon> = {
    bug: Bug,
    feature: Lightbulb,
    other: MessageSquare,
};

const feedbackLocations = [
    'inbox',
    'focus',
    'projects',
    'review',
    'settings',
    'sync',
    'importExport',
    'notifications',
    'other',
] as const;

type FeedbackLocation = typeof feedbackLocations[number];

export function FeedbackSettingsModal({
    isConfigured,
    onClose,
    onOpenGitHub,
    onSubmit,
    tr,
    visible,
}: FeedbackSettingsModalProps) {
    const tc = useThemeColors();
    const filledButton = useFilledButtonColors();
    const [category, setCategory] = useState<FeedbackCategory>('bug');
    const [message, setMessage] = useState('');
    const [email, setEmail] = useState('');
    const [bugLocation, setBugLocation] = useState<FeedbackLocation | ''>('');
    const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
    const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
    const [error, setError] = useState<string | null>(null);
    const androidScrollViewFocusProps: Partial<ScrollViewProps> & { scrollsChildToFocus?: boolean } = (
        Platform.OS === 'android' ? { scrollsChildToFocus: false } : {}
    );

    useEffect(() => {
        if (!visible) return;
        setStatus('idle');
        setError(null);
    }, [visible]);

    useEffect(() => {
        if (category === 'bug') return;
        setIncludeDiagnostics(false);
        setBugLocation('');
    }, [category]);

    const categoryLabels = useMemo<Record<FeedbackCategory, string>>(() => ({
        bug: tr('settings.feedbackCategoryBug'),
        feature: tr('settings.feedbackCategoryFeature'),
        other: tr('settings.feedbackCategoryOther'),
    }), [tr]);
    const messagePlaceholders = useMemo<Record<FeedbackCategory, string>>(() => ({
        bug: tr('settings.feedbackMessagePlaceholderBug'),
        feature: tr('settings.feedbackMessagePlaceholderFeature'),
        other: tr('settings.feedbackMessagePlaceholderOther'),
    }), [tr]);
    const locationLabels = useMemo<Record<FeedbackLocation, string>>(() => ({
        inbox: tr('settings.feedbackWhereInbox'),
        focus: tr('settings.feedbackWhereFocus'),
        projects: tr('settings.feedbackWhereProjects'),
        review: tr('settings.feedbackWhereReview'),
        settings: tr('settings.feedbackWhereSettings'),
        sync: tr('settings.feedbackWhereSync'),
        importExport: tr('settings.feedbackWhereImportExport'),
        notifications: tr('settings.feedbackWhereNotifications'),
        other: tr('settings.feedbackWhereOther'),
    }), [tr]);

    const trimmedMessage = message.trim();
    const trimmedEmail = email.trim();
    const emailValid = !trimmedEmail || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail);
    const canSubmit = isConfigured && trimmedMessage.length > 0 && emailValid && status !== 'sending';
    const visibleError = error
        ?? (trimmedEmail && !emailValid ? tr('settings.feedbackInvalidEmail') : null);

    const submit = async () => {
        if (!trimmedMessage) {
            setError(tr('settings.feedbackRequired'));
            return;
        }
        if (!emailValid) {
            setError(tr('settings.feedbackInvalidEmail'));
            return;
        }
        setStatus('sending');
        setError(null);
        const submittedMessage = category === 'bug' && bugLocation
            ? `${tr('settings.feedbackWhereMessagePrefix')}: ${locationLabels[bugLocation]}\n\n${trimmedMessage}`
            : trimmedMessage;
        try {
            await onSubmit({
                category,
                email: trimmedEmail || undefined,
                includeDiagnostics: category === 'bug' && includeDiagnostics,
                message: submittedMessage,
            });
            setStatus('sent');
            setMessage('');
            setEmail('');
            setBugLocation('');
            setIncludeDiagnostics(false);
        } catch {
            setStatus('error');
            setError(tr('settings.feedbackFailed'));
        }
    };

    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={styles.feedbackModalOverlay}
            >
                <View style={styles.feedbackModalBackdrop}>
                    <Pressable style={styles.feedbackModalBackdropPressable} onPress={onClose} />
                    <View
                        style={[styles.feedbackModalCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                    >
                        <View style={[styles.feedbackModalHeader, { borderBottomColor: tc.border }]}>
                            <View style={styles.feedbackModalTitleBlock}>
                                <Text style={[styles.feedbackModalTitle, { color: tc.text }]}>
                                    {tr('settings.feedback')}
                                </Text>
                                <Text style={[styles.feedbackModalSubtitle, { color: tc.secondaryText }]}>
                                    {tr('settings.feedbackDesc')}
                                </Text>
                            </View>
                            <TouchableOpacity
                                accessibilityLabel={tr('common.close')}
                                onPress={onClose}
                                style={styles.feedbackCloseButton}
                            >
                                <X size={20} color={tc.secondaryText} />
                            </TouchableOpacity>
                        </View>

                        {status === 'sent' ? (
                            <View style={styles.feedbackSentBody}>
                                <View style={[styles.feedbackNotice, { backgroundColor: `${tc.success}22`, borderColor: `${tc.success}55` }]}>
                                    <Text style={[styles.feedbackNoticeText, { color: tc.success }]}>
                                        {tr('settings.feedbackSent')}
                                    </Text>
                                </View>
                                <TouchableOpacity
                                    style={[styles.feedbackPrimaryButton, { backgroundColor: filledButton.backgroundColor }]}
                                    onPress={onClose}
                                >
                                    <Text style={[styles.feedbackPrimaryButtonText, { color: filledButton.textColor ?? tc.onTint }]}>
                                        {tr('common.close')}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        ) : (
                            <ScrollView
                                style={styles.feedbackModalScroll}
                                contentContainerStyle={styles.feedbackModalBody}
                                keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
                                keyboardShouldPersistTaps="handled"
                                nestedScrollEnabled
                                showsVerticalScrollIndicator
                                {...androidScrollViewFocusProps}
                            >
                                {onOpenGitHub ? (
                                    <View style={[styles.feedbackGitHubOption, { borderBottomColor: tc.border }]}>
                                        <TouchableOpacity
                                            accessibilityRole="link"
                                            onPress={() => onOpenGitHub(category)}
                                            style={styles.feedbackNoticeLink}
                                        >
                                            <Text style={[styles.feedbackNoticeLinkText, { color: tc.tint }]}>
                                                {tr(category === 'other' ? 'settings.feedbackOpenGitHubDiscussion' : 'settings.feedbackOpenGitHubIssue')}
                                            </Text>
                                        </TouchableOpacity>
                                        <Text style={[styles.feedbackNoticeDescription, { color: tc.secondaryText }]}>
                                            {tr('settings.feedbackGitHubDesc')}
                                        </Text>
                                    </View>
                                ) : null}
                                <Text style={[styles.feedbackFieldLabel, { color: tc.secondaryText }]}>
                                    {tr('settings.feedbackCategory')}
                                </Text>
                                <View style={styles.feedbackCategoryGrid}>
                                    {FEEDBACK_CATEGORIES.map((item) => {
                                        const selected = item === category;
                                        const Icon = categoryIcons[item];
                                        return (
                                            <TouchableOpacity
                                                key={item}
                                                style={[
                                                    styles.feedbackCategoryButton,
                                                    {
                                                        backgroundColor: selected ? `${tc.tint}18` : tc.bg,
                                                        borderColor: selected ? tc.tint : tc.border,
                                                    },
                                                ]}
                                                onPress={() => setCategory(item)}
                                            >
                                                <Icon size={17} color={selected ? tc.tint : tc.secondaryText} />
                                                <Text
                                                    style={[
                                                        styles.feedbackCategoryText,
                                                        { color: selected ? tc.tint : tc.secondaryText },
                                                    ]}
                                                    numberOfLines={1}
                                                >
                                                    {categoryLabels[item]}
                                                </Text>
                                            </TouchableOpacity>
                                        );
                                    })}
                                </View>

                                {category === 'bug' ? (
                                    <>
                                        <Text style={[styles.feedbackFieldLabel, { color: tc.secondaryText }]}>
                                            {tr('settings.feedbackWhere')}
                                        </Text>
                                        <View style={styles.feedbackLocationGrid}>
                                            {feedbackLocations.map((location) => {
                                                const selected = location === bugLocation;
                                                return (
                                                    <TouchableOpacity
                                                        key={location}
                                                        accessibilityRole="button"
                                                        accessibilityState={{ selected }}
                                                        style={[
                                                            styles.feedbackLocationChip,
                                                            {
                                                                backgroundColor: selected ? `${tc.tint}18` : tc.bg,
                                                                borderColor: selected ? tc.tint : tc.border,
                                                            },
                                                        ]}
                                                        onPress={() => {
                                                            setBugLocation(selected ? '' : location);
                                                            setError(null);
                                                        }}
                                                    >
                                                        <Text
                                                            style={[
                                                                styles.feedbackLocationChipText,
                                                                { color: selected ? tc.tint : tc.secondaryText },
                                                            ]}
                                                        >
                                                            {locationLabels[location]}
                                                        </Text>
                                                    </TouchableOpacity>
                                                );
                                            })}
                                        </View>
                                    </>
                                ) : null}

                                <Text style={[styles.feedbackFieldLabel, { color: tc.secondaryText }]}>
                                    {tr('settings.feedbackMessage')}
                                </Text>
                                <TextInput
                                    value={message}
                                    onChangeText={(next) => {
                                        setMessage(next);
                                        setError(null);
                                    }}
                                    placeholder={messagePlaceholders[category]}
                                    placeholderTextColor={tc.secondaryText}
                                    multiline
                                    maxLength={4000}
                                    style={[
                                        styles.feedbackTextArea,
                                        {
                                            backgroundColor: tc.bg,
                                            borderColor: tc.border,
                                            color: tc.text,
                                        },
                                    ]}
                                    textAlignVertical="top"
                                />

                                <Text style={[styles.feedbackFieldLabel, { color: tc.secondaryText }]}>
                                    {tr('settings.feedbackEmail')}
                                </Text>
                                <TextInput
                                    value={email}
                                    onChangeText={(next) => {
                                        setEmail(next);
                                        setError(null);
                                    }}
                                    placeholder={tr('settings.feedbackEmailPlaceholder')}
                                    placeholderTextColor={tc.secondaryText}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    keyboardType="email-address"
                                    style={[
                                        styles.feedbackInput,
                                        {
                                            backgroundColor: tc.bg,
                                            borderColor: tc.border,
                                            color: tc.text,
                                        },
                                    ]}
                                />

                                {category === 'bug' ? (
                                    <View style={[styles.feedbackDiagnosticsRow, { backgroundColor: tc.bg, borderColor: tc.border }]}>
                                        <View style={styles.feedbackDiagnosticsCopy}>
                                            <Text style={[styles.feedbackDiagnosticsTitle, { color: tc.text }]}>
                                                {tr('settings.feedbackIncludeDiagnostics')}
                                            </Text>
                                            <Text style={[styles.feedbackDiagnosticsDescription, { color: tc.secondaryText }]}>
                                                {tr('settings.feedbackIncludeDiagnosticsDesc')}
                                            </Text>
                                        </View>
                                        <Switch
                                            value={includeDiagnostics}
                                            onValueChange={setIncludeDiagnostics}
                                            trackColor={{ false: tc.border, true: `${tc.tint}66` }}
                                            thumbColor={includeDiagnostics ? tc.tint : tc.secondaryText}
                                        />
                                    </View>
                                ) : null}

                                <Text style={[styles.feedbackPrivacyText, { color: tc.secondaryText, backgroundColor: tc.bg }]}>
                                    {tr('settings.feedbackPrivacy')}
                                </Text>

                                {!isConfigured ? (
                                    <View style={[styles.feedbackNotice, { backgroundColor: `${tc.danger}18`, borderColor: `${tc.danger}55` }]}>
                                        <Text style={[styles.feedbackNoticeText, { color: tc.danger }]}>
                                            {tr('settings.feedbackUnavailable')}
                                        </Text>
                                        <Text style={[styles.feedbackNoticeDescription, { color: tc.danger }]}>
                                            {tr('settings.feedbackUnavailableDesc')}
                                        </Text>
                                    </View>
                                ) : null}

                                {visibleError ? (
                                    <View style={[styles.feedbackNotice, { backgroundColor: `${tc.danger}18`, borderColor: `${tc.danger}55` }]}>
                                        <Text style={[styles.feedbackNoticeText, { color: tc.danger }]}>
                                            {visibleError}
                                        </Text>
                                    </View>
                                ) : null}
                            </ScrollView>
                        )}
                        {status !== 'sent' ? (
                            <View style={[styles.feedbackActions, { borderTopColor: tc.border }]}>
                                <TouchableOpacity
                                    style={[styles.feedbackSecondaryButton, { borderColor: tc.border }]}
                                    onPress={onClose}
                                >
                                    <Text style={[styles.feedbackSecondaryButtonText, { color: tc.secondaryText }]}>
                                        {tr('common.cancel')}
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    disabled={!canSubmit}
                                    style={[
                                        styles.feedbackPrimaryButton,
                                        { backgroundColor: filledButton.backgroundColor },
                                        !canSubmit && styles.feedbackButtonDisabled,
                                    ]}
                                    onPress={() => void submit()}
                                >
                                    {status === 'sending' ? (
                                        <ActivityIndicator size="small" color={filledButton.textColor ?? tc.onTint} />
                                    ) : null}
                                    <Text style={[styles.feedbackPrimaryButtonText, { color: filledButton.textColor ?? tc.onTint }]}>
                                        {status === 'sending'
                                            ? tr('settings.feedbackSending')
                                            : tr('settings.feedbackSubmit')}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        ) : null}
                    </View>
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
}

import React, { useEffect, useMemo, useRef, useState } from 'react';
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

import {
    buildFeedbackModalText,
    FEEDBACK_CATEGORIES,
    FEEDBACK_LOCATIONS as feedbackLocations,
    getFeedbackDraftState,
    getFeedbackMessageMaxLength,
    planFeedbackSubmit,
    type FeedbackCategory,
    type FeedbackLocation,
} from '@mindwtr/core';
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

    // Each opening is its own visit: a send from an earlier visit that ends later changes nothing here.
    const visit = useRef(0);
    useEffect(() => {
        visit.current += 1;
        if (!visible) return;
        setStatus('idle');
        setError(null);
    }, [visible]);

    useEffect(() => {
        if (category === 'bug') return;
        setIncludeDiagnostics(false);
        setBugLocation('');
    }, [category]);

    // Core's words and rules (about-settings-model.ts), shared with the native host.
    const text = useMemo(() => buildFeedbackModalText(tr), [tr]);
    const categoryLabels = text.categories;
    const messagePlaceholders = text.messagePlaceholders;
    const locationLabels = text.locations;

    const { canSubmit, visibleError } = getFeedbackDraftState({ tr, isConfigured, message, email, status, error });

    const submit = async () => {
        const plan = planFeedbackSubmit({ category, message, email, location: bugLocation, includeDiagnostics }, tr);
        if ('error' in plan) {
            setError(plan.error);
            return;
        }
        setStatus('sending');
        setError(null);
        const sentIn = visit.current;
        try {
            await onSubmit(plan.input);
            if (visit.current !== sentIn) return;
            setStatus('sent');
            setMessage('');
            setEmail('');
            setBugLocation('');
            setIncludeDiagnostics(false);
        } catch {
            if (visit.current !== sentIn) return;
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
                                    {text.title}
                                </Text>
                                {onOpenGitHub && status !== 'sent' ? (
                                    <Text style={[styles.feedbackModalSubtitle, { color: tc.secondaryText }]}>
                                        {text.gitHub[category].before}
                                        <Text
                                            accessibilityRole="link"
                                            onPress={() => onOpenGitHub(category)}
                                            style={{ color: tc.tint, textDecorationLine: 'underline' }}
                                        >
                                            {text.gitHub[category].link}
                                        </Text>
                                        {text.gitHub[category].after}
                                    </Text>
                                ) : null}
                            </View>
                            <TouchableOpacity
                                accessibilityLabel={text.close}
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
                                        {text.sent}
                                    </Text>
                                </View>
                                <TouchableOpacity
                                    style={[styles.feedbackPrimaryButton, { backgroundColor: filledButton.backgroundColor }]}
                                    onPress={onClose}
                                >
                                    <Text style={[styles.feedbackPrimaryButtonText, { color: filledButton.textColor ?? tc.onTint }]}>
                                        {text.close}
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
                                <Text style={[styles.feedbackFieldLabel, { color: tc.secondaryText }]}>
                                    {text.category}
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
                                            {text.where}
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
                                    {text.message}
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
                                    maxLength={getFeedbackMessageMaxLength({ category, location: bugLocation }, tr)}
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
                                    {text.email}
                                </Text>
                                <TextInput
                                    value={email}
                                    onChangeText={(next) => {
                                        setEmail(next);
                                        setError(null);
                                    }}
                                    placeholder={text.emailPlaceholder}
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
                                                {text.includeDiagnostics}
                                            </Text>
                                            <Text style={[styles.feedbackDiagnosticsDescription, { color: tc.secondaryText }]}>
                                                {text.includeDiagnosticsDescription}
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

                                {!isConfigured ? (
                                    <View style={[styles.feedbackNotice, { backgroundColor: `${tc.danger}18`, borderColor: `${tc.danger}55` }]}>
                                        <Text style={[styles.feedbackNoticeText, { color: tc.danger }]}>
                                            {text.unavailable}
                                        </Text>
                                        <Text style={[styles.feedbackNoticeDescription, { color: tc.danger }]}>
                                            {text.unavailableDescription}
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
                                        {text.cancel}
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
                                            ? text.sending
                                            : text.submit}
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

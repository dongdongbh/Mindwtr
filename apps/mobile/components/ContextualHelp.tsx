import React, { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { HelpCircle, ExternalLink } from 'lucide-react-native';
import { getOnboardingGuideUrl, ONBOARDING_TOPIC_COPY, type OnboardingTopic } from '@mindwtr/core';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { useLanguage } from '@/contexts/language-context';

type Props = {
    topic: OnboardingTopic;
    t: (key: string) => string;
    tc: Pick<ThemeColors, 'secondaryText' | 'filterBg' | 'tint' | 'danger'>;
};

/** The (?) control that sits in a section header and toggles that section's help text. */
export function ContextualHelpButton({ topic, t, tc, expanded, onPress }: Props & { expanded: boolean; onPress: () => void }) {
    return (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded }}
            accessibilityLabel={`${t('onboarding.help')}: ${t(ONBOARDING_TOPIC_COPY[topic].title)}`}
            hitSlop={12} onPress={onPress}
            style={({ pressed }) => [styles.button, { backgroundColor: pressed ? tc.filterBg : undefined }]}>
            <HelpCircle size={16} color={tc.secondaryText} />
        </Pressable>
    );
}

/** The help text shown under the section header, with a link to the guide. */
export function ContextualHelpBody({ topic, t, tc }: Props) {
    const { language } = useLanguage();
    const [error, setError] = useState(false);
    return (
        <View style={styles.body}>
            <Text style={[styles.copy, { color: tc.secondaryText }]}>{t(ONBOARDING_TOPIC_COPY[topic].body)}</Text>
            <Pressable accessibilityRole="link"
                onPress={() => {
                    setError(false);
                    void Linking.openURL(getOnboardingGuideUrl(topic, 'mobile', language)).catch(() => setError(true));
                }} style={styles.link}>
                <Text style={[styles.label, { color: tc.tint }]}>{t('onboarding.readGuide')}</Text>
                <ExternalLink size={14} color={tc.tint} />
            </Pressable>
            {error && <Text accessibilityRole="alert" style={{ color: tc.danger }}>{t('onboarding.guideError')}</Text>}
        </View>
    );
}

const styles = StyleSheet.create({
    button: { padding: 4, borderRadius: 8 },
    label: { fontSize: 14, flexShrink: 1 },
    copy: { fontSize: 14, lineHeight: 21 },
    body: { paddingBottom: 8 },
    link: { minHeight: 44, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6 },
});

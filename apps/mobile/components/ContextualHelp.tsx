import React, { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { HelpCircle, ExternalLink, X } from 'lucide-react-native';
import { getOnboardingGuideUrl, ONBOARDING_TOPIC_COPY, type OnboardingTopic } from '@mindwtr/core';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { dismissMobileHint, isMobileHintDismissed } from '@/lib/onboarding-hints';

type Props = {
    topic: OnboardingTopic;
    autoReveal?: boolean;
    t: (key: string) => string;
    tc: Pick<ThemeColors, 'secondaryText' | 'filterBg' | 'tint' | 'danger'>;
};

/** Editor help is opt-in; only an explicit onboarding surface may auto-reveal it. */
export function ContextualHelp({ topic, autoReveal = false, t, tc }: Props) {
    return <TopicHelp key={topic} topic={topic} autoReveal={autoReveal} t={t} tc={tc} />;
}

function TopicHelp({ topic, autoReveal, t, tc }: Props) {
    const [expanded, setExpanded] = useState(false);
    const [error, setError] = useState(false);
    const interacted = React.useRef(false);
    useEffect(() => {
        let active = true;
        void isMobileHintDismissed(topic).then((dismissed) => {
            if (active && !interacted.current) setExpanded(Boolean(autoReveal && !dismissed));
        });
        return () => { active = false; };
    }, [topic, autoReveal]);
    const copy = ONBOARDING_TOPIC_COPY[topic];
    const label = `${t('onboarding.help')}: ${t(copy.title)}`;
    const close = () => {
        interacted.current = true;
        setExpanded(false);
        void dismissMobileHint(topic);
    };
    return (
        <View style={styles.root}>
            <View style={styles.row}>
                <Pressable accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={label}
                    onPress={() => {
                        interacted.current = true;
                        if (expanded) close(); else setExpanded(true);
                    }}
                    style={({ pressed }) => [styles.control, expanded && styles.heading, { backgroundColor: pressed ? tc.filterBg : undefined }]}>
                    <HelpCircle size={16} color={tc.secondaryText} />
                    {expanded && <Text style={[styles.label, { color: tc.secondaryText }]}>{label}</Text>}
                </Pressable>
                {expanded && <Pressable accessibilityRole="button" accessibilityLabel={t('common.dismiss')}
                    onPress={close} style={styles.control}>
                    <X size={18} color={tc.secondaryText} />
                </Pressable>}
            </View>
            {expanded && <View style={styles.body}>
                <Text style={[styles.copy, { color: tc.secondaryText }]}>{t(copy.body)}</Text>
                <Pressable accessibilityRole="link"
                    onPress={() => {
                        setError(false);
                        void Linking.openURL(getOnboardingGuideUrl(topic, 'mobile')).catch(() => setError(true));
                    }} style={[styles.control, styles.link]}>
                    <Text style={[styles.label, { color: tc.tint }]}>{t('onboarding.readGuide')}</Text>
                    <ExternalLink size={14} color={tc.tint} />
                </Pressable>
                {error && <Text accessibilityRole="alert" style={{ color: tc.danger }}>{t('onboarding.guideError')}</Text>}
            </View>}
        </View>
    );
}

const styles = StyleSheet.create({
    root: { paddingVertical: 4 },
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: 4 },
    heading: { flex: 1, justifyContent: 'flex-start' },
    control: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 8 },
    label: { fontSize: 14, flexShrink: 1 },
    copy: { fontSize: 14, lineHeight: 21 },
    body: { paddingHorizontal: 8, paddingBottom: 4 },
    link: { alignSelf: 'flex-start' },
});

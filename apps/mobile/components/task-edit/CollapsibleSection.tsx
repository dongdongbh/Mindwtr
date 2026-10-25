import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, LayoutAnimation, Platform, UIManager } from 'react-native';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import type { OnboardingTopic } from '@mindwtr/core';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { ContextualHelpBody, ContextualHelpButton } from '../ContextualHelp';

const isFabricEnabled = Boolean((globalThis as { nativeFabricUIManager?: unknown }).nativeFabricUIManager);

if (Platform.OS === 'android' && !isFabricEnabled && UIManager.setLayoutAnimationEnabledExperimental) {
    UIManager.setLayoutAnimationEnabledExperimental(true);
}

type CollapsibleSectionProps = {
    title: string;
    badge?: number;
    defaultExpanded?: boolean;
    resetKey?: string | number;
    /** Adds a (?) after the title; its text opens under the header. */
    help?: { topic: OnboardingTopic; t: (key: string) => string };
    children: React.ReactNode;
};

export function CollapsibleSection({
    title,
    badge = 0,
    defaultExpanded = false,
    resetKey,
    help,
    children,
}: CollapsibleSectionProps) {
    const [expanded, setExpanded] = useState(defaultExpanded);
    const [helpOpen, setHelpOpen] = useState(false);
    const tc = useThemeColors();
    const latestDefaultExpandedRef = useRef(defaultExpanded);
    latestDefaultExpandedRef.current = defaultExpanded;

    useEffect(() => {
        setExpanded(latestDefaultExpandedRef.current);
        setHelpOpen(false);
    }, [resetKey]);

    const toggle = () => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setExpanded((prev) => !prev);
    };

    return (
        <View style={[styles.container, { borderColor: tc.border }]}>
            <View style={styles.header}>
                <Pressable
                    style={styles.toggle}
                    onPress={toggle}
                    accessibilityRole="button"
                    accessibilityLabel={title}
                    accessibilityState={{ expanded }}
                >
                    {expanded
                        ? <ChevronDown size={16} color={tc.secondaryText} aria-hidden accessible={false} pointerEvents="none" />
                        : <ChevronRight size={16} color={tc.secondaryText} aria-hidden accessible={false} pointerEvents="none" />}
                    <Text style={[styles.title, { color: tc.text }]}>{title}</Text>
                </Pressable>
                {help && (
                    <ContextualHelpButton
                        topic={help.topic}
                        t={help.t}
                        tc={tc}
                        expanded={helpOpen}
                        onPress={() => setHelpOpen((prev) => !prev)}
                    />
                )}
                {/* The rest of the row toggles too, so the whole header stays a tap target; the titled button is the accessible one. */}
                <Pressable
                    style={styles.headerRest}
                    onPress={toggle}
                    accessible={false}
                    importantForAccessibility="no-hide-descendants"
                    accessibilityElementsHidden
                >
                    {badge > 0 && (
                        <View style={[styles.badge, { backgroundColor: tc.tint }]}>
                            <Text style={[styles.badgeText, { color: tc.onTint }]}>{badge}</Text>
                        </View>
                    )}
                </Pressable>
            </View>
            {help && helpOpen && <ContextualHelpBody topic={help.topic} t={help.t} tc={tc} />}
            {expanded && <View style={styles.content}>{children}</View>}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        borderTopWidth: 1,
        marginTop: 8,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    toggle: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        paddingVertical: 12,
        gap: 8,
    },
    headerRest: {
        flex: 1,
        alignSelf: 'stretch',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
    },
    title: {
        flexShrink: 1,
        fontSize: 12,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.6,
    },
    badge: {
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 10,
    },
    badgeText: {
        fontSize: 12,
        fontWeight: '600',
    },
    content: {
        paddingBottom: 16,
    },
});

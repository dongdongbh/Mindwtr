import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, LayoutAnimation, Platform, UIManager } from 'react-native';
import { useThemeColors } from '@/hooks/use-theme-colors';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
    UIManager.setLayoutAnimationEnabledExperimental(true);
}

type CollapsibleSectionProps = {
    title: string;
    badge?: number;
    defaultExpanded?: boolean;
    resetKey?: string | number;
    children: React.ReactNode;
};

export function CollapsibleSection({
    title,
    badge = 0,
    defaultExpanded = false,
    resetKey,
    children,
}: CollapsibleSectionProps) {
    const [expanded, setExpanded] = useState(defaultExpanded);
    const tc = useThemeColors();
    const latestDefaultExpandedRef = useRef(defaultExpanded);
    latestDefaultExpandedRef.current = defaultExpanded;

    useEffect(() => {
        setExpanded(latestDefaultExpandedRef.current);
    }, [resetKey]);

    const toggle = () => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setExpanded((prev) => !prev);
    };

    return (
        <View style={[styles.container, { borderColor: tc.border }]}>
            <Pressable style={styles.header} onPress={toggle}>
                <Text style={[styles.chevron, { color: tc.secondaryText }]}>{expanded ? '▾' : '▸'}</Text>
                <Text style={[styles.title, { color: tc.text }]}>{title}</Text>
                {badge > 0 && (
                    <View style={[styles.badge, { backgroundColor: tc.tint }]}>
                        <Text style={styles.badgeText}>{badge}</Text>
                    </View>
                )}
            </Pressable>
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
        paddingVertical: 12,
        gap: 8,
    },
    chevron: {
        fontSize: 12,
        width: 16,
        textAlign: 'center',
    },
    title: {
        flex: 1,
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
        color: '#FFFFFF',
        fontSize: 12,
        fontWeight: '600',
    },
    content: {
        paddingBottom: 16,
    },
});

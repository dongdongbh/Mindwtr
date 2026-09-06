import React from 'react';
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';

type FieldHeadingProps = {
    /** Decorative glyph shown before the field label. */
    icon: LucideIcon;
    label: string;
    /** Label color; the icon inherits it so the pair reads as one line. */
    iconColor: string;
    /** Text style for the label (theme label token + color overrides). */
    labelStyle: StyleProp<TextStyle>;
    /**
     * Extra row layout. The row already carries the field label's standard
     * bottom margin (8) unless this prop overrides `marginBottom`.
     */
    rowStyle?: StyleProp<ViewStyle>;
};

/**
 * A field sub-heading: icon before the label, sharing the label color. The
 * icon is decorative (`accessible={false}`), so the label text stays the
 * accessible name of the section.
 */
export function FieldHeading({
    icon: HeadingIcon,
    label,
    iconColor,
    labelStyle,
    rowStyle,
}: FieldHeadingProps) {
    return (
        <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }, rowStyle]}>
            <HeadingIcon
                size={16}
                color={iconColor}
                aria-hidden
                accessible={false}
                pointerEvents="none"
            />
            <Text style={[labelStyle, { marginBottom: 0 }]}>{label}</Text>
        </View>
    );
}

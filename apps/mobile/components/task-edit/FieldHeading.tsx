import React from 'react';
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';

type FieldHeadingProps = {

    icon: LucideIcon;
    label: string;

    iconColor: string;

    labelStyle: StyleProp<TextStyle>;


    rowStyle?: StyleProp<ViewStyle>;
};


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

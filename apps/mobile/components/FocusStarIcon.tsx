import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { Star } from 'lucide-react-native';
import { useEinkSafeColor } from '../hooks/use-eink-safe-color';

export const FOCUS_STAR_COLOR = '#F59E0B';

type FocusStarIconProps = {
    disabled?: boolean;
    focused: boolean;
    inactiveColor: string;
    size?: number;
    style?: StyleProp<ViewStyle>;
};

export function FocusStarIcon({
    disabled = false,
    focused,
    inactiveColor,
    size = 22,
    style,
}: FocusStarIconProps) {
    const einkSafe = useEinkSafeColor();
    const starColor = einkSafe(FOCUS_STAR_COLOR);
    return (
        <Star
            size={size}
            color={focused ? starColor : inactiveColor}
            fill={focused ? starColor : 'transparent'}
            strokeWidth={2}
            style={[
                style,
                { opacity: focused ? 1 : disabled ? 0.3 : 0.6 },
            ]}
        />
    );
}

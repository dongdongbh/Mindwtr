import { BottomTabBarButtonProps } from '@react-navigation/bottom-tabs';
import { PlatformPressable } from '@react-navigation/elements';
import { StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';

interface HapticTabProps extends BottomTabBarButtonProps {
  activeBackgroundColor?: string;
  inactiveBackgroundColor?: string;
}

export function HapticTab({
  activeBackgroundColor = 'transparent',
  inactiveBackgroundColor = 'transparent',
  ...props
}: HapticTabProps) {
  const isFocused = props.accessibilityState?.selected;
  return (
    <PlatformPressable
      {...props}
      style={[
        props.style,
        styles.tabButton,
        { backgroundColor: isFocused ? activeBackgroundColor : inactiveBackgroundColor },
      ]}
      onPressIn={(ev) => {
        if (process.env.EXPO_OS === 'ios') {
          // Add a soft haptic feedback when pressing down on the tabs.
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
        props.onPressIn?.(ev);
      }}
    />
  );
}

const styles = StyleSheet.create({
  tabButton: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 0,
    width: '100%',
    height: '100%',
  },
});

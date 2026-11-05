import { BottomTabBarButtonProps } from '@react-navigation/bottom-tabs';
import { PlatformPressable } from '@react-navigation/elements';
import { StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';

interface HapticTabProps extends BottomTabBarButtonProps {
  activeBackgroundColor?: string;
  inactiveBackgroundColor?: string;
  activeIndicatorColor?: string;
  indicatorHeight?: number;
}

export function HapticTab({
  activeBackgroundColor = 'transparent',
  inactiveBackgroundColor = 'transparent',
  activeIndicatorColor = 'transparent',
  indicatorHeight = 2,
  ...props
}: HapticTabProps) {
  const isFocused = props.accessibilityState?.selected;
  return (
    <PlatformPressable
      {...props}
      style={[
        styles.tabButton,
        props.style,
        {
          backgroundColor: isFocused ? activeBackgroundColor : inactiveBackgroundColor,
          borderBottomWidth: isFocused ? indicatorHeight : 0,
          borderBottomColor: isFocused ? activeIndicatorColor : 'transparent',
        },
      ]}
      onPressIn={(ev) => {
        if (process.env.EXPO_OS === 'ios') {

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

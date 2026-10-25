import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { getHeaderTitle } from '@react-navigation/elements';
import { Stack } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useLanguage } from '../../contexts/language-context';
import { MobileAreaSwitcher } from '@/components/mobile-area-switcher';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { WidgetLaunchContext } from '@/hooks/use-widget-launch';
import { getWidgetLaunchState } from '@/modules/android-widget';

function DrawerHeader({
  title,
  canGoBack,
  onBack,
  tintColor,
  backgroundColor,
  borderColor,
  backAccessibilityLabel,
  showAreaSwitcher,
  rightAction,
}: {
  title: string;
  canGoBack: boolean;
  onBack: () => void;
  tintColor: string;
  backgroundColor: string;
  borderColor: string;
  backAccessibilityLabel: string;
  showAreaSwitcher: boolean;
  rightAction?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.headerContainer,
        {
          backgroundColor,
          borderBottomColor: borderColor,
          height: 52 + insets.top,
          paddingTop: insets.top,
        },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={backAccessibilityLabel}
        disabled={!canGoBack}
        hitSlop={8}
        onPress={onBack}
        style={[styles.headerBackButton, !canGoBack && styles.headerBackButtonHidden]}
      >
        <Ionicons color={tintColor} name="chevron-back" size={24} />
      </Pressable>
      <Text numberOfLines={1} style={[styles.headerTitle, { color: tintColor }]}>
        {title}
      </Text>
      <View style={styles.headerRight}>
        {showAreaSwitcher ? <MobileAreaSwitcher /> : null}
        {rightAction || !showAreaSwitcher ? <View style={styles.headerRightAction}>{rightAction}</View> : null}
      </View>
    </View>
  );
}

// Screens whose lists follow the area filter show it, as the tab headers do,
// so a task hidden by it has a visible reason (#1448). Widget lists use the widget's
// own scope, and Settings has no header.
const AREA_FILTERED_ROUTES = new Set([
  'board', 'calendar', 'review', 'contexts', 'waiting', 'someday', 'reference', 'done',
  'history', 'projects-screen', 'archived', 'trash', 'saved-search/[id]',
]);

// Cold starts and deep links that land directly on a stack screen (session
// restore to Archive, widget/notification links) must still have the tabs
// beneath them, so the header back button and Android system back return to
// the app instead of exiting it (#842).
export const unstable_settings = {
  anchor: '(tabs)',
};

export default function AppLayout() {
  const tc = useThemeColors();
  const { t } = useLanguage();
  const backAccessibilityLabel = t('common.back');
  const { pending: widgetLaunch } = React.useContext(WidgetLaunchContext);
  // Linking may change the route before the root hook's effect runs. Read the already-held native token in that commit.
  const widgetTransition = widgetLaunch || getWidgetLaunchState()?.stage === 'pending';

  return (
    <Stack
      screenOptions={{
        ...(widgetTransition ? { animation: 'none' as const } : {}),
        header: ({ navigation, route, options, back }) => (
          <DrawerHeader
            backgroundColor={tc.cardBg}
            borderColor={tc.border}
            canGoBack={!!back}
            onBack={() => {
              if (navigation.canGoBack()) {
                navigation.goBack();
              }
            }}
            tintColor={tc.text}
            title={getHeaderTitle(options, route.name)}
            backAccessibilityLabel={backAccessibilityLabel}
            showAreaSwitcher={AREA_FILTERED_ROUTES.has(route.name)}
            rightAction={options.headerRight?.({ tintColor: tc.text, canGoBack: !!back })}
          />
        ),
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="board" options={{ title: t('nav.board') }} />
      <Stack.Screen name="calendar" options={{ title: t('nav.calendar') }} />
      <Stack.Screen name="review" options={{ title: t('nav.review') }} />
      <Stack.Screen name="contexts" options={{ title: t('contexts.title') }} />
      <Stack.Screen name="waiting" options={{ title: t('waiting.title') }} />
      <Stack.Screen name="someday" options={{ title: t('someday.title') }} />
      <Stack.Screen name="reference" options={{ title: t('nav.reference') }} />
      <Stack.Screen name="done" options={{ title: t('nav.done') }} />
      <Stack.Screen name="history" options={{ title: t('nav.history') }} />
      <Stack.Screen name="projects-screen" options={{ title: t('projects.title') }} />
      <Stack.Screen name="archived" options={{ title: t('archived.title') }} />
      <Stack.Screen name="trash" options={{ title: t('trash.title') }} />
      <Stack.Screen
        name="settings"
        options={{
          headerShown: false,
          gestureEnabled: true,
        }}
      />
      <Stack.Screen name="saved-search/[id]" options={{ title: t('search.title') }} />
      <Stack.Screen name="widget-list/[id]" options={{ title: t('nav.next') }} />
    </Stack>
  );
}

const styles = StyleSheet.create({
  headerContainer: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
  },
  headerBackButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerRight: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  headerRightAction: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  headerBackButtonHidden: {
    opacity: 0,
  },
  headerTitle: {
    flex: 1,
    marginHorizontal: 4,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '700',
  },
});

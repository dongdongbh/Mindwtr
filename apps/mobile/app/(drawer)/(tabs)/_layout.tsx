import { Link, Tabs } from 'expo-router';
import { Search, Inbox, ArrowRightCircle, Folder, Menu, Plus } from 'lucide-react-native';
import { Platform, StyleSheet, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useState } from 'react';

import { HapticTab } from '@/components/haptic-tab';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useLanguage } from '../../../contexts/language-context';
import { QuickCaptureSheet } from '@/components/quick-capture-sheet';

export default function TabLayout() {
  const tc = useThemeColors();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const androidNavInset = Platform.OS === 'android' && insets.bottom >= 20
    ? Math.max(0, insets.bottom - 12)
    : 0;
  const tabBarHeight = 58 + androidNavInset;
  const iconLift = Platform.OS === 'android' ? 6 : 0;
  const [captureOpen, setCaptureOpen] = useState(false);

  const iconTint = tc.text;
  const inactiveTint = tc.secondaryText;
  const activeIndicator = tc.tint;
  const captureColor = tc.tint;

  return (
    <>
      <Tabs
        initialRouteName="inbox"
        screenOptions={({ route }) => ({
        tabBarActiveTintColor: iconTint,
        tabBarInactiveTintColor: inactiveTint,
        tabBarShowLabel: false,
        headerShown: true,
        headerTitleAlign: 'center',
        headerShadowVisible: false,
        headerStyle: {
          backgroundColor: tc.cardBg,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: tc.border,
        },
        headerTintColor: tc.text,
        headerTitleStyle: {
          fontSize: 17,
          fontWeight: '700',
        },
        headerRight: route.name === 'menu'
          ? undefined
          : () => (
            <Link href="/global-search" asChild>
              <TouchableOpacity style={styles.headerIconButton} accessibilityLabel={t('search.title')}>
                <Search size={22} color={tc.text} />
              </TouchableOpacity>
            </Link>
          ),
        tabBarButton: (props) => (
          <HapticTab
            {...props}
            activeBackgroundColor="transparent"
            inactiveBackgroundColor="transparent"
            activeIndicatorColor={activeIndicator}
            indicatorHeight={2}
          />
        ),
        tabBarItemStyle: {
          flex: 1,
          borderRadius: 0,
          marginHorizontal: 0,
          marginVertical: 0,
          paddingVertical: 0,
          height: tabBarHeight,
          paddingBottom: androidNavInset,
          paddingTop: iconLift,
          justifyContent: 'center',
          alignItems: 'center',
        },
        tabBarStyle: {
          backgroundColor: tc.cardBg,
          borderTopColor: tc.border,
          paddingTop: 0,
          paddingBottom: 0,
          height: tabBarHeight,
          paddingHorizontal: 0,
          alignItems: 'stretch',
          ...Platform.select({
            ios: {
              position: 'absolute',
            },
            default: {},
          }),
        },
      })}
      >
      <Tabs.Screen
        name="inbox"
        options={{
          title: t('tab.inbox'),
          tabBarIcon: ({ color, focused }) => (
            <Inbox size={focused ? 26 : 24} color={color} strokeWidth={2} opacity={focused ? 1 : 0.8} />
          ),
        }}
      />
      <Tabs.Screen
        name="focus"
        options={{
          title: t('tab.next'),
          tabBarIcon: ({ color, focused }) => (
            <ArrowRightCircle size={focused ? 26 : 24} color={color} strokeWidth={2} opacity={focused ? 1 : 0.8} />
          ),
        }}
      />
      <Tabs.Screen
        name="capture"
        options={{
          title: t('nav.addTask'),
          tabBarButton: () => (
            <TouchableOpacity
              onPress={() => setCaptureOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={t('nav.addTask')}
              style={styles.captureButton}
            >
              <View style={[styles.captureButtonInner, { backgroundColor: captureColor }]}>
                <Plus size={24} color={tc.onTint} strokeWidth={3} />
              </View>
            </TouchableOpacity>
          ),
        }}
      />
      <Tabs.Screen
        name="projects"
        options={{
          title: t('projects.title'),
          tabBarIcon: ({ color, focused }) => (
            <Folder size={focused ? 26 : 24} color={color} strokeWidth={2} opacity={focused ? 1 : 0.8} />
          ),
        }}
      />
      <Tabs.Screen
        name="menu"
        options={{
          title: t('tab.menu'),
          tabBarIcon: ({ color, focused }) => (
            <Menu size={focused ? 26 : 24} color={color} strokeWidth={2} opacity={focused ? 1 : 0.8} />
          ),
        }}
      />
    </Tabs>
    <QuickCaptureSheet visible={captureOpen} onClose={() => setCaptureOpen(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  headerIconButton: {
    marginRight: 16,
    padding: 4,
  },
  captureButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureButtonInner: {
    width: 54,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -8,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});

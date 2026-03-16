import { Link, Tabs } from 'expo-router';
import { CommonActions } from '@react-navigation/native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Search, Inbox, ArrowRightCircle, Folder, Menu, Mic, Plus } from 'lucide-react-native';
import { Platform, StyleSheet, TouchableOpacity, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCallback, useRef, useState } from 'react';

import { HapticTab } from '@/components/haptic-tab';
import { MobileAreaSwitcher } from '@/components/mobile-area-switcher';
import { MobileHeaderSyncBar } from '@/components/mobile-header-sync-bar';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useMobileSyncBadge } from '@/hooks/use-mobile-sync-badge';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useLanguage } from '../../../contexts/language-context';
import { QuickCaptureSheet } from '@/components/quick-capture-sheet';
import { QuickCaptureProvider } from '../../../contexts/quick-capture-context';
import { useTaskStore, type Task } from '@mindwtr/core';

function NativeTabBar({
  state,
  descriptors,
  navigation,
  iconTint,
  inactiveTint,
  tc,
  tabBarHeight,
  tabBarBottomInset,
  tabBarBottomOffset,
  tabItemTopOffset,
  iconLift,
  openQuickCapture,
  defaultAutoRecord,
  menuSyncIndicatorColor,
}: BottomTabBarProps & {
  iconTint: string;
  inactiveTint: string;
  tc: { cardBg: string; border: string; onTint: string; tint: string };
  tabBarHeight: number;
  tabBarBottomInset: number;
  tabBarBottomOffset: number;
  tabItemTopOffset: number;
  iconLift: number;
  openQuickCapture: (options?: { initialValue?: string; initialProps?: Partial<Task>; autoRecord?: boolean }) => void;
  defaultAutoRecord: boolean;
  menuSyncIndicatorColor?: string;
}) {
  const longPressRef = useRef(false);
  const visibleTabNames = new Set(['inbox', 'focus', 'capture', 'projects', 'menu']);
  const visibleRoutes = state.routes.filter((route) => visibleTabNames.has(route.name));

  return (
    <View
      style={[
        styles.nativeTabBar,
        {
          backgroundColor: tc.cardBg,
          borderTopColor: tc.border,
          height: tabBarHeight,
          paddingBottom: tabBarBottomInset,
          marginBottom: tabBarBottomOffset,
        },
      ]}
    >
      {visibleRoutes.map((route) => {
        const focused = state.routes[state.index]?.key === route.key;
        const descriptor = descriptors[route.key];
        const options = descriptor.options;

        if (route.name === 'capture') {
          return (
            <TouchableOpacity
              key={route.key}
              onPress={() => {
                if (longPressRef.current) {
                  longPressRef.current = false;
                  return;
                }
                openQuickCapture({ autoRecord: defaultAutoRecord });
              }}
              onLongPress={() => {
                longPressRef.current = true;
                openQuickCapture({ autoRecord: !defaultAutoRecord });
                setTimeout(() => {
                  longPressRef.current = false;
                }, 400);
              }}
              accessibilityRole="button"
              accessibilityLabel={defaultAutoRecord ? 'Audio capture' : 'Add task'}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={[
                styles.nativeTabItem,
                { paddingTop: iconLift, transform: [{ translateY: tabItemTopOffset }] },
              ]}
            >
              <View style={[styles.captureButtonInner, { backgroundColor: tc.tint }]}>
                {defaultAutoRecord ? (
                  <Mic size={24} color={tc.onTint} strokeWidth={2.5} />
                ) : (
                  <Plus size={24} color={tc.onTint} strokeWidth={3} />
                )}
              </View>
            </TouchableOpacity>
          );
        }

        const onPress = () => {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });
          if (focused || event.defaultPrevented) return;
          navigation.dispatch({
            ...CommonActions.navigate(route),
            target: state.key,
          });
        };

        const onLongPress = () => {
          navigation.emit({ type: 'tabLongPress', target: route.key });
        };

        const tabIcon = options.tabBarIcon?.({
          focused,
          color: focused ? iconTint : inactiveTint,
          size: focused ? 26 : 24,
        });

        return (
          <TouchableOpacity
            key={route.key}
            accessibilityRole="button"
            accessibilityState={focused ? { selected: true } : {}}
            accessibilityLabel={options.tabBarAccessibilityLabel}
            testID={options.tabBarButtonTestID}
            onPress={onPress}
            onLongPress={onLongPress}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={[
              styles.nativeTabItem,
              { paddingTop: iconLift, transform: [{ translateY: tabItemTopOffset }] },
            ]}
          >
            <View style={styles.nativeTabIconWrap}>
              {tabIcon}
              {route.name === 'menu' && menuSyncIndicatorColor ? (
                <View
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                  style={[
                    styles.menuSyncDot,
                    {
                      backgroundColor: menuSyncIndicatorColor,
                      borderColor: tc.cardBg,
                    },
                  ]}
                />
              ) : null}
            </View>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export default function TabLayout() {
  const tc = useThemeColors();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const { settings } = useTaskStore();
  const androidNavInset = Platform.OS === 'android' && insets.bottom >= 20
    ? Math.max(0, insets.bottom - 12)
    : 0;
  const iosBottomInset = Platform.OS === 'ios'
    ? Math.max(0, insets.bottom - 12)
    : 0;
  const tabBarBottomInset = Platform.OS === 'ios' ? iosBottomInset : androidNavInset;
  const tabBarBottomOffset = 0;
  const tabItemTopOffset = Platform.OS === 'ios' ? 0 : -6;
  const tabBarHeight = 58 + tabBarBottomInset;
  const iconLift = Platform.OS === 'android' ? 4 : 0;
  const [captureState, setCaptureState] = useState<{
    visible: boolean;
    initialValue?: string;
    initialProps?: Partial<Task> | null;
    autoRecord?: boolean;
  }>({
    visible: false,
    initialValue: '',
    initialProps: null,
    autoRecord: false,
  });
  const longPressRef = useRef(false);
  const { selectedAreaIdForNewTasks } = useMobileAreaFilter();

  const withSelectedArea = useCallback((initialProps?: Partial<Task> | null): Partial<Task> | undefined => {
    const nextInitialProps = initialProps ? { ...initialProps } : {};
    if (!nextInitialProps.projectId && !nextInitialProps.areaId && selectedAreaIdForNewTasks) {
      nextInitialProps.areaId = selectedAreaIdForNewTasks;
    }
    return Object.keys(nextInitialProps).length > 0 ? nextInitialProps : undefined;
  }, [selectedAreaIdForNewTasks]);

  const openQuickCapture = useCallback((options?: { initialValue?: string; initialProps?: Partial<Task>; autoRecord?: boolean }) => {
    setCaptureState({
      visible: true,
      initialValue: options?.initialValue ?? '',
      initialProps: withSelectedArea(options?.initialProps) ?? null,
      autoRecord: options?.autoRecord ?? false,
    });
  }, [withSelectedArea]);

  const closeQuickCapture = useCallback(() => {
    setCaptureState({ visible: false, initialValue: '', initialProps: null, autoRecord: false });
  }, []);

  const iconTint = tc.tabIconSelected;
  const inactiveTint = tc.tabIconDefault;
  const captureColor = tc.tint;
  const defaultCapture = settings.gtd?.defaultCaptureMethod ?? 'text';
  const defaultAutoRecord = defaultCapture === 'audio';
  const { syncBadgeAccessibilityLabel, syncBadgeColor } = useMobileSyncBadge();

  return (
    <QuickCaptureProvider value={{ openQuickCapture }}>
      <Tabs
        initialRouteName="inbox"
        tabBar={(props) => (
          <NativeTabBar
            {...props}
            iconTint={iconTint}
            inactiveTint={inactiveTint}
            tc={{ cardBg: tc.cardBg, border: tc.border, onTint: tc.onTint, tint: tc.tint }}
            tabBarHeight={tabBarHeight}
            tabBarBottomInset={tabBarBottomInset}
            tabBarBottomOffset={tabBarBottomOffset}
            tabItemTopOffset={tabItemTopOffset}
            iconLift={iconLift}
            openQuickCapture={openQuickCapture}
            defaultAutoRecord={defaultAutoRecord}
            menuSyncIndicatorColor={syncBadgeColor}
          />
        )}
        screenOptions={({ route }) => ({
        tabBarActiveTintColor: iconTint,
        tabBarInactiveTintColor: inactiveTint,
        tabBarShowLabel: false,
        headerShown: true,
        headerTitleAlign: 'center',
        headerShadowVisible: false,
        headerStyle: {
          backgroundColor: tc.cardBg,
          borderBottomWidth: 0,
        },
        headerBackground: () => (
          <View
            style={[
              StyleSheet.absoluteFillObject,
              {
                backgroundColor: tc.cardBg,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: tc.border,
              },
            ]}
          >
            <MobileHeaderSyncBar />
          </View>
        ),
        headerLeft: () => <MobileAreaSwitcher />,
        headerLeftContainerStyle: {
          paddingLeft: 16,
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
        headerRightContainerStyle: {
          paddingRight: 16,
        },
        tabBarButton: (props) => (
          <HapticTab
            {...props}
            activeBackgroundColor="transparent"
            inactiveBackgroundColor="transparent"
            activeIndicatorColor="transparent"
            indicatorHeight={0}
          />
        ),
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
              onPress={() => {
                if (longPressRef.current) {
                  longPressRef.current = false;
                  return;
                }
                openQuickCapture({ autoRecord: defaultAutoRecord });
              }}
              onLongPress={() => {
                longPressRef.current = true;
                openQuickCapture({ autoRecord: !defaultAutoRecord });
                setTimeout(() => {
                  longPressRef.current = false;
                }, 400);
              }}
              accessibilityRole="button"
              accessibilityLabel={defaultAutoRecord ? t('quickAdd.audioCaptureLabel') : t('nav.addTask')}
              style={styles.captureButton}
            >
              <View style={[styles.captureButtonInner, { backgroundColor: captureColor }]}>
                {defaultAutoRecord ? (
                  <Mic size={24} color={tc.onTint} strokeWidth={2.5} />
                ) : (
                  <Plus size={24} color={tc.onTint} strokeWidth={3} />
                )}
              </View>
            </TouchableOpacity>
          ),
        }}
      />
      <Tabs.Screen
        name="capture-quick"
        options={{
          href: null,
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
          tabBarAccessibilityLabel: syncBadgeAccessibilityLabel
            ? `${t('tab.menu')}, ${syncBadgeAccessibilityLabel}`
            : t('tab.menu'),
          tabBarIcon: ({ color, focused }) => (
            <Menu size={focused ? 26 : 24} color={color} strokeWidth={2} opacity={focused ? 1 : 0.8} />
          ),
        }}
      />
    </Tabs>
    <QuickCaptureSheet
      visible={captureState.visible}
      initialValue={captureState.initialValue}
      initialProps={captureState.initialProps ?? undefined}
      autoRecord={captureState.autoRecord}
      onClose={closeQuickCapture}
    />
    </QuickCaptureProvider>
  );
}

const styles = StyleSheet.create({
  nativeTabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: 'stretch',
    overflow: 'visible',
  },
  nativeTabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nativeTabIconWrap: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  menuSyncDot: {
    position: 'absolute',
    top: -2,
    right: -7,
    width: 7,
    height: 7,
    borderRadius: 3.5,
    borderWidth: 1.5,
    opacity: 0.85,
  },
  headerIconButton: {
    padding: 4,
  },
  captureButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureButtonInner: {
    width: 48,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -4,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
});

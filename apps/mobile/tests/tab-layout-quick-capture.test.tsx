import React from 'react';
import { TouchableOpacity } from 'react-native';
import { Plus } from 'lucide-react-native';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import Index from '../app/index';
import { unstable_settings as drawerLayoutSettings } from '../app/(drawer)/_layout';
import TabLayout from '../app/(drawer)/(tabs)/_layout';

const mockRouterPush = vi.hoisted(() => vi.fn());
const mockRouteQuickCapture = vi.hoisted(() => vi.fn());
const tabProviderValue = vi.hoisted(() => ({
  current: null as null | { openQuickCapture: (options?: Record<string, unknown>) => void },
}));
const mockRestorableRoute = vi.hoisted(() => ({
  current: null as null | { pathname: string; params?: Record<string, string> },
}));
const selectedAreaIdForNewTasksMock = vi.hoisted(() => ({ current: null as string | null | undefined }));
const mockTaskSettings = vi.hoisted(() => ({
  appearance: {} as Record<string, unknown>,
  features: {} as { board?: boolean },
  gtd: {
    defaultCaptureMethod: 'text',
    defaultAreaMode: undefined as 'none' | 'fixed' | 'active' | undefined,
    defaultAreaId: undefined as string | undefined,
  },
  savedSearches: [],
}));
const mockThemeTokens = vi.hoisted(() => ({
  value: { isMaterial: false, roles: null, shape: { large: 16 } } as {
    isMaterial: boolean;
    roles: Record<string, string> | null;
    shape: { large: number };
  },
}));
const mockUseTaskStore = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => {
  function RedirectMock(props: { href: unknown; withAnchor?: boolean }) {
    return React.createElement('Redirect', props);
  }
  function LinkMock({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
  }
  function TabsScreenMock() {
    return null;
  }
  const Tabs = ({ children, tabBar, ...props }: any) => React.createElement(
    'Tabs',
    props,
    tabBar({
      state: {
        index: 0,
        key: 'tabs',
        routes: [
          { key: 'focus-key', name: 'focus' },
          { key: 'inbox-key', name: 'inbox' },
          { key: 'capture-key', name: 'capture' },
          { key: 'projects-key', name: 'projects' },
          { key: 'calendar-key', name: 'calendar-tab' },
          { key: 'contexts-key', name: 'contexts-tab' },
          { key: 'review-key', name: 'review-tab' },
          { key: 'menu-key', name: 'menu' },
        ],
      },
      descriptors: {
        'inbox-key': { options: { title: 'Inbox' } },
        'focus-key': { options: { title: 'Focus' } },
        'capture-key': { options: { title: 'Add task' } },
        'projects-key': { options: { title: 'Projects' } },
        'calendar-key': { options: { title: 'Calendar' } },
        'contexts-key': { options: { title: 'Contexts' } },
        'review-key': { options: { title: 'Review' } },
        'menu-key': { options: { title: 'Menu', tabBarAccessibilityLabel: 'Menu' } },
      },
      navigation: {
        emit: vi.fn(() => ({ defaultPrevented: false })),
        dispatch: vi.fn(),
      },
    }),
    children,
  );
  Tabs.Screen = TabsScreenMock;
  return {
    Link: LinkMock,
    Redirect: RedirectMock,
    Tabs,
    useRouter: () => ({ push: mockRouterPush }),
  };
});

vi.mock('@/lib/session-restore', () => ({
  readRestorableRoute: vi.fn(async () => mockRestorableRoute.current),
}));

vi.mock('@react-navigation/native', () => ({
  CommonActions: {
    navigate: vi.fn((route) => ({ type: 'NAVIGATE', payload: route })),
  },
}));

vi.mock('@react-navigation/elements', () => ({
  getHeaderTitle: (_options: unknown, fallback: string) => fallback,
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
  const { mockCore } = await import('../test-support/mock-core');
  // This suite drives the store hook itself, so it supplies its own.
  return mockCore(importOriginal, () => ({}), { useTaskStore: mockUseTaskStore });
});

vi.mock('@/components/haptic-tab', () => ({
  HapticTab: (props: any) => React.createElement('HapticTab', props, props.children),
}));

vi.mock('@/components/ui/icon-symbol', () => ({
  IconSymbol: (props: any) => React.createElement('IconSymbol', props, props.children),
}));

vi.mock('@/components/mobile-area-switcher', () => ({
  MobileAreaSwitcher: () => React.createElement('MobileAreaSwitcher'),
}));

vi.mock('@/components/quick-capture-sheet', () => ({
  QuickCaptureSheet: (props: any) => React.createElement('QuickCaptureSheet', props),
}));

vi.mock('@/hooks/use-mobile-area-filter', () => ({
  useMobileAreaFilter: () => ({ selectedAreaIdForNewTasks: selectedAreaIdForNewTasksMock.current }),
}));

vi.mock('@/hooks/use-mobile-sync-badge', () => ({
  useMobileSyncBadge: () => ({ syncBadgeAccessibilityLabel: '', syncBadgeColor: '' }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#0f172a',
    border: '#334155',
    cardBg: '#111827',
    filterBg: '#1f2937',
    onTint: '#ffffff',
    secondaryText: '#94a3b8',
    tabIconDefault: '#94a3b8',
    tabIconSelected: '#f8fafc',
    text: '#f8fafc',
    tint: '#3b82f6',
    danger: '#ef4444',
  }),
}));

vi.mock('@/hooks/use-theme-tokens', () => ({
  useThemeTokens: () => mockThemeTokens.value,
}));

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) => ({
      'nav.addTask': 'Add task',
      'nav.archived': 'Archived',
      'nav.board': 'Board View',
      'nav.calendar': 'Calendar',
      'nav.contexts': 'Contexts',
      'nav.done': 'Done',
      'nav.projects': 'Projects',
      'nav.reference': 'Reference',
      'nav.review': 'Review',
      'nav.settings': 'Settings',
      'nav.sectionArchive': 'Archive',
      'nav.sectionLists': 'Lists',
      'nav.sectionOrganize': 'Organize',
      'nav.someday': 'Someday',
      'nav.trash': 'Trash',
      'nav.waiting': 'Waiting For',
      'quickAdd.audioCaptureLabel': 'Audio capture',
      'search.title': 'Search',
      'search.savedSearches': 'Saved searches',
      'tab.inbox': 'Inbox',
      'tab.menu': 'Menu',
      'tab.next': 'Focus',
      'tab.review': 'Review',
      'common.close': 'Close',
    }[key] ?? key),
  }),
}));

vi.mock('../contexts/quick-capture-context', () => ({
  QuickCaptureProvider: ({ value, children }: { value: unknown; children: React.ReactNode }) => {
    tabProviderValue.current = value as typeof tabProviderValue.current;
    return <>{children}</>;
  },
  useQuickCapture: () => ({ openQuickCapture: mockRouteQuickCapture }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const getAddTaskButton = (tree: ReturnType<typeof create>) => {
  const button = tree.root.findAllByType(TouchableOpacity).find(
    (node) => node.props.accessibilityLabel === 'Add task'
  );
  if (!button) throw new Error('Add task button not found');
  return button;
};

const flattenStyle = (style: unknown): Record<string, unknown> => {
  if (typeof style === 'function') {
    return flattenStyle(style({ pressed: false }));
  }
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>((acc, item) => ({
      ...acc,
      ...flattenStyle(item),
    }), {});
  }
  return style && typeof style === 'object' ? style as Record<string, unknown> : {};
};

const getMoreSheetButtonLabelNode = (tree: ReturnType<typeof create>, label: string) => {
  const button = getMoreSheetButtons(tree, label)[0];
  if (!button) throw new Error(`${label} button not found`);
  const text = button.findAll((node) => (
    String(node.type) === 'Text'
    && node.children.includes(label)
  ))[0];
  if (!text) throw new Error(`${label} label not found`);
  return text;
};

const getMoreSheetButtonLabelStyle = (tree: ReturnType<typeof create>, label: string) => {
  return flattenStyle(getMoreSheetButtonLabelNode(tree, label).props.style);
};

const getCaptureButtonInnerStyle = (tree: ReturnType<typeof create>) => {
  const view = tree.root.findAll((node) => (
    String(node.type) === 'View'
    && flattenStyle(node.props.style).backgroundColor === '#3b82f6'
  ))[0];
  if (!view) throw new Error('Capture button inner view not found');
  return flattenStyle(view.props.style);
};

const getCaptureInnerStyleBySize = (tree: ReturnType<typeof create>) => {
  const view = tree.root.findAll((node) => {
    if (String(node.type) !== 'View') return false;
    const s = flattenStyle(node.props.style);
    return s.width === 48 && s.height === 38;
  })[0];
  if (!view) throw new Error('Capture button inner view not found');
  return flattenStyle(view.props.style);
};

const getCaptureIcon = (tree: ReturnType<typeof create>) => {
  const icon = tree.root.findAllByType(Plus)[0];
  if (!icon) throw new Error('Capture plus icon not found');
  return icon;
};

const getCaptureIconColor = (tree: ReturnType<typeof create>) => getCaptureIcon(tree).props.color;

const getMenuButton = (tree: ReturnType<typeof create>) => {
  const button = tree.root.findAllByType(TouchableOpacity).find(
    (node) => node.props.accessibilityLabel === 'Menu'
  );
  if (!button) throw new Error('Menu button not found');
  return button;
};

const getTabButton = (tree: ReturnType<typeof create>, label: string) => {
  const button = tree.root.findAllByType(TouchableOpacity).find(
    (node) => node.props.accessibilityLabel === label
  );
  if (!button) throw new Error(`${label} tab button not found`);
  return button;
};

const getBottomTabLabels = (tree: ReturnType<typeof create>) => {
  const tabLabels = new Set(['Focus', 'Inbox', 'Add task', 'Projects', 'Calendar', 'Contexts', 'Review', 'Menu']);
  return tree.root
    .findAllByType(TouchableOpacity)
    .map((node) => node.props.accessibilityLabel)
    .filter((label): label is string => typeof label === 'string' && tabLabels.has(label));
};

const getBottomTabTextLabels = (tree: ReturnType<typeof create>) => {
  const labels = new Set(['Focus', 'Inbox', 'Add task', 'Projects', 'Calendar', 'Contexts', 'Review', 'Menu']);
  return tree.root
    .findAll((node) => String(node.type) === 'Text')
    .map((node) => node.children.join(''))
    .filter((label) => labels.has(label));
};

const getQuickCaptureSheets = (tree: ReturnType<typeof create>) => (
  tree.root.findAll((node) => String(node.type) === 'QuickCaptureSheet')
);

const getMoreSheetButtons = (tree: ReturnType<typeof create>, label: string) => (
  tree.root.findAll((node) => (
    String(node.type) === 'Pressable'
    && node.props.accessibilityLabel === label
    && node.props.accessibilityRole === 'button'
    && typeof node.props.onPress === 'function'
  ))
);

const getMoreSheetButtonIconName = (tree: ReturnType<typeof create>, label: string) => {
  const button = getMoreSheetButtons(tree, label)[0];
  if (!button) throw new Error(`${label} button not found`);
  const icon = button.findAll((node) => String(node.type) === 'IconSymbol')[0];
  if (!icon) throw new Error(`${label} icon not found`);
  return icon.props.name;
};

const moreDestinationLabels = [
  'Trash',
  'Archived',
  'Done',
  'Reference',
  'Settings',
  'Waiting For',
  'Board View',
  'Projects',
  'Someday',
  'Contexts',
  'Calendar',
];
const moreSheetDestinationLabels = [...moreDestinationLabels, 'Review'];

const hasHiddenAccessibilityAncestor = (node: any) => {
  let parent = node.parent;
  while (parent) {
    if (
      parent.props?.accessibilityElementsHidden
      || parent.props?.importantForAccessibility === 'no-hide-descendants'
    ) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
};

const getVisibleMoreDestinationLabels = (tree: ReturnType<typeof create>) => (
  tree.root
    .findAll((node) => (
      String(node.type) === 'Pressable'
      && node.props.accessibilityRole === 'button'
      && typeof node.props.onPress === 'function'
      && moreSheetDestinationLabels.includes(node.props.accessibilityLabel)
      && !hasHiddenAccessibilityAncestor(node)
    ))
    .map((node) => node.props.accessibilityLabel)
);

const getMoreSheetMenu = (tree: ReturnType<typeof create>) => {
  const menu = tree.root.findAll((node) => (
    String(node.type) === 'Animated.View'
    && node.props.accessibilityRole === 'menu'
  ))[0];
  if (!menu) throw new Error('More sheet menu not found');
  return menu;
};

describe('mobile tab quick capture', () => {
  beforeEach(() => {
    mockRouterPush.mockClear();
    mockRouteQuickCapture.mockClear();
    tabProviderValue.current = null;
    mockUseTaskStore.mockImplementation((selector?: (state: { settings: typeof mockTaskSettings }) => unknown) => {
      const state = { settings: mockTaskSettings };
      return selector ? selector(state) : state;
    });
    mockRestorableRoute.current = null;
    mockTaskSettings.appearance = {};
    mockTaskSettings.features = {};
    mockTaskSettings.gtd.defaultCaptureMethod = 'text';
    mockTaskSettings.gtd.defaultAreaMode = undefined;
    mockTaskSettings.gtd.defaultAreaId = undefined;
    mockTaskSettings.savedSearches = [];
    selectedAreaIdForNewTasksMock.current = null;
    mockThemeTokens.value = { isMaterial: false, roles: null, shape: { large: 16 } };
  });

  it('subscribes the tab navigator only to settings', () => {
    act(() => {
      create(<TabLayout />);
    });

    const selector = mockUseTaskStore.mock.calls[0]?.[0] as
      | ((state: { settings: typeof mockTaskSettings; tasks: unknown[] }) => unknown)
      | undefined;

    expect(selector).toBeTypeOf('function');
    expect(selector?.({ settings: mockTaskSettings, tasks: [{ id: 'unrelated-sync-update' }] }))
      .toBe(mockTaskSettings);
  });

  it('unmounts the quick capture sheet after close so the next plus tap gets a fresh modal', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TabLayout />);
    });

    expect(getQuickCaptureSheets(tree)).toHaveLength(0);

    act(() => {
      getAddTaskButton(tree).props.onPress();
    });

    let sheets = getQuickCaptureSheets(tree);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.props.visible).toBe(true);

    act(() => {
      sheets[0]?.props.onClose();
    });

    expect(getQuickCaptureSheets(tree)).toHaveLength(0);

    act(() => {
      getAddTaskButton(tree).props.onPress();
    });

    sheets = getQuickCaptureSheets(tree);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.props.visible).toBe(true);
  });

  it('routes a returnTo capture through the root capture screen instead of the tab sheet', () => {
    // The tab sheet opens in place with no route change, so a caller that
    // dismissed its own UI expecting a focus event on return (project quick
    // add, #938) would be stranded on its base screen.
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TabLayout />);
    });

    act(() => {
      tabProviderValue.current?.openQuickCapture({
        initialProps: { projectId: 'project-1', status: 'next' },
        returnTo: '/projects-screen?projectId=project-1',
      });
    });

    expect(mockRouteQuickCapture).toHaveBeenCalledWith(expect.objectContaining({
      initialProps: { projectId: 'project-1', status: 'next' },
      returnTo: '/projects-screen?projectId=project-1',
    }));
    expect(getQuickCaptureSheets(tree)).toHaveLength(0);

    // A plain capture still uses the in-place sheet.
    act(() => {
      tabProviderValue.current?.openQuickCapture();
    });

    expect(getQuickCaptureSheets(tree)).toHaveLength(1);
    expect(mockRouteQuickCapture).toHaveBeenCalledTimes(1);
  });

  it('passes the selected area filter into quick capture initial props in active area mode', () => {
    mockTaskSettings.gtd.defaultAreaMode = 'active';
    selectedAreaIdForNewTasksMock.current = 'area-work';
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TabLayout />);
    });

    act(() => {
      getAddTaskButton(tree).props.onPress();
    });

    const sheets = getQuickCaptureSheets(tree);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.props.initialProps).toEqual({ areaId: 'area-work' });
  });

  it('defaults cold tab startup to Focus', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TabLayout />);
    });

    const tabs = tree.root.find((node) => String(node.type) === 'Tabs');
    expect(tabs.props.initialRouteName).toBe('focus');
    expect(getBottomTabLabels(tree).slice(0, 2)).toEqual(['Focus', 'Inbox']);
    expect(getBottomTabTextLabels(tree)).toEqual(['Focus', 'Inbox', 'Review', 'Menu']);
  });

  it('anchors restored stack screens above tabs so Back stays available', () => {
    expect(drawerLayoutSettings).toEqual({ anchor: '(tabs)' });
  });

  it('shrinks mobile header titles before React Navigation truncates them', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TabLayout />);
    });

    const tabs = tree.root.find((node) => String(node.type) === 'Tabs');
    const screenOptions = tabs.props.screenOptions({ route: { name: 'projects' } });
    const headerTitle = screenOptions.headerTitle({ children: 'Projects' });

    expect(headerTitle.props.children).toBe('Projects');
    expect(headerTitle.props.numberOfLines).toBe(1);
    expect(headerTitle.props.adjustsFontSizeToFit).toBe(true);
    expect(headerTitle.props.minimumFontScale).toBe(0.72);
    expect(headerTitle.props.maxFontSizeMultiplier).toBe(1.15);
  });

  it('redirects root cold launch to Focus when no recent session is stored', async () => {
    let tree!: ReturnType<typeof create>;

    // Session restore reads storage asynchronously before redirecting.
    await act(async () => {
      tree = create(<Index />);
    });

    const redirect = tree.root.find((node) => String(node.type) === 'Redirect');
    expect(redirect.props.href).toBe('/focus');
    expect(redirect.props.withAnchor).toBe(true);
  });

  it('anchors a restored Calendar route so iOS Back survives a force-quit restart', async () => {
    mockRestorableRoute.current = { pathname: '/calendar' };
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(<Index />);
    });

    const redirect = tree.root.find((node) => String(node.type) === 'Redirect');
    expect(redirect.props.href).toEqual({ pathname: '/calendar', params: {} });
    expect(redirect.props.withAnchor).toBe(true);
  });

  it('increments the open request id without key-remounting the sheet', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TabLayout />);
    });

    act(() => {
      getAddTaskButton(tree).props.onPress();
    });

    let sheets = getQuickCaptureSheets(tree);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.props.openRequestId).toBe(1);

    act(() => {
      getAddTaskButton(tree).props.onPress();
    });

    sheets = getQuickCaptureSheets(tree);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.props.openRequestId).toBe(2);
  });

  it('keeps the primary capture button prominent and slightly lifted in the bottom bar', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TabLayout />);
    });

    expect(getCaptureButtonInnerStyle(tree)).toEqual(expect.objectContaining({
      width: 48,
      height: 38,
      borderRadius: 10,
    }));
    expect(getCaptureIcon(tree).props.size).toBe(28);

    const transform = flattenStyle(getAddTaskButton(tree).props.style).transform as { translateY: number }[];
    expect(transform[0]?.translateY).toBe(-6);
  });

  it('boosts the capture FAB to the high-emphasis M3 primary role under Material', () => {
    // Capture is Mindwtr's most important action, so under M3 the FAB uses the
    // high-emphasis FAB role (primary/onPrimary), not the deliberately subdued
    // primaryContainer. Other primary buttons stay primaryContainer (canonical),
    // preserving M3's emphasis hierarchy with capture at the top.
    mockThemeTokens.value = {
      isMaterial: true,
      roles: {
        primary: '#AAC7FF',
        onPrimary: '#003063',
        primaryContainer: '#00458B',
        onPrimaryContainer: '#D7E2FF',
      },
      shape: { large: 16 },
    };

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<TabLayout />);
    });

    const inner = getCaptureInnerStyleBySize(tree);
    expect(inner.backgroundColor).toBe('#AAC7FF');
    expect(inner.borderRadius).toBe(16);
    expect(getCaptureIconColor(tree)).toBe('#003063');
  });

  it('opens the restored compact More grid and navigates to Calendar', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TabLayout />);
    });

    expect(getMoreSheetButtons(tree, 'Calendar')).toHaveLength(0);

    act(() => {
      getMenuButton(tree).props.onPress();
    });

    expect(getVisibleMoreDestinationLabels(tree)).toEqual(moreDestinationLabels);
    expect(getMoreSheetButtonIconName(tree, 'Board View')).toBe('square.grid.2x2.fill');
    expect(getMoreSheetButtonIconName(tree, 'Someday')).toBe('arrow.up.circle.fill');
    const trashLabel = getMoreSheetButtonLabelNode(tree, 'Trash');
    expect(trashLabel.props.numberOfLines).toBe(2);
    expect(trashLabel.props.adjustsFontSizeToFit).toBe(true);
    expect(trashLabel.props.maxFontSizeMultiplier).toBe(1);
    expect(flattenStyle(getMoreSheetButtons(tree, 'Trash')[0]?.props.style)).toEqual(expect.objectContaining({
      flex: 1,
      minWidth: 0,
    }));
    expect(flattenStyle(getMoreSheetButtons(tree, 'Trash')[0]?.props.style)).not.toHaveProperty('flexBasis');

    const calendarButtons = getMoreSheetButtons(tree, 'Calendar');
    expect(calendarButtons.length).toBeGreaterThan(0);

    act(() => {
      calendarButtons[0]?.props.onPress();
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/calendar');
    expect(getMoreSheetButtons(tree, 'Calendar')).toHaveLength(0);
  });

  it('hides Board from the More sheet when the Board feature is disabled', () => {
    mockTaskSettings.features = { board: false };
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TabLayout />);
    });
    act(() => {
      getMenuButton(tree).props.onPress();
    });

    expect(getMoreSheetButtons(tree, 'Board View')).toHaveLength(0);
    expect(getVisibleMoreDestinationLabels(tree)).not.toContain('Board View');
  });

  it('swaps a selected quick access view with Review in the More sheet', () => {
    mockTaskSettings.appearance = { mobileQuickAccessView: 'projects' };
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TabLayout />);
    });

    expect(getTabButton(tree, 'Projects')).toBeTruthy();

    act(() => {
      getMenuButton(tree).props.onPress();
    });

    expect(getVisibleMoreDestinationLabels(tree)).toEqual([
      'Trash',
      'Archived',
      'Done',
      'Reference',
      'Settings',
      'Waiting For',
      'Board View',
      'Review',
      'Someday',
      'Contexts',
      'Calendar',
    ]);
    expect(getMoreSheetButtons(tree, 'Projects')).toHaveLength(0);

    const reviewButtons = getMoreSheetButtons(tree, 'Review');
    expect(reviewButtons.length).toBeGreaterThan(0);
    expect(getMoreSheetButtonLabelStyle(tree, 'Review')).toEqual(expect.objectContaining({
      includeFontPadding: false,
    }));
    expect(getMoreSheetButtonLabelStyle(tree, 'Review')).not.toHaveProperty('minHeight');

    act(() => {
      reviewButtons[0]?.props.onPress();
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/review');
  });

  it('closes the More sheet from the menu tab toggle and ignores a short downward drag', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TabLayout />);
    });

    act(() => {
      getMenuButton(tree).props.onPress();
    });
    expect(getVisibleMoreDestinationLabels(tree)).toEqual(moreDestinationLabels);

    act(() => {
      getMenuButton(tree).props.onPress();
    });
    expect(getVisibleMoreDestinationLabels(tree)).toHaveLength(0);

    act(() => {
      getMenuButton(tree).props.onPress();
    });
    const menu = getMoreSheetMenu(tree);
    expect(menu.props.onMoveShouldSetResponder?.({}, { dx: 2, dy: 13 })).toBe(true);

    act(() => {
      menu.props.onResponderRelease?.({}, { dx: 4, dy: 24, vy: 0.2 });
    });
    expect(getVisibleMoreDestinationLabels(tree)).toEqual(moreDestinationLabels);

    act(() => {
      menu.props.onResponderRelease?.({}, { dx: 4, dy: 32, vy: 1 });
    });
    expect(getVisibleMoreDestinationLabels(tree)).toHaveLength(0);
  });

  it('dismisses the full More sheet on a long downward swipe', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TabLayout />);
    });

    act(() => {
      getMenuButton(tree).props.onPress();
    });
    expect(getVisibleMoreDestinationLabels(tree)).toEqual(moreDestinationLabels);

    act(() => {
      getMoreSheetMenu(tree).props.onResponderRelease?.({}, { dx: 4, dy: 240, vy: 0.2 });
    });
    expect(getVisibleMoreDestinationLabels(tree)).toHaveLength(0);
  });
});

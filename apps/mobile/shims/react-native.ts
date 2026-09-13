import React from 'react';

const createHostComponent = (name: string) => {
  const HostComponent = (props: any) => React.createElement(name, props, props.children);
  HostComponent.displayName = name;
  return HostComponent;
};

const renderHostChild = (child: any, key: string) => {
  if (child == null || child === false) return null;
  return React.createElement(React.Fragment, { key }, child);
};

export const StyleSheet = {
  create: <T extends Record<string, unknown>>(styles: T) => styles,
  absoluteFillObject: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
};

export const View = createHostComponent('View');
export const Text = createHostComponent('Text');
export const ScrollView = createHostComponent('ScrollView');
export const FlatList = createHostComponent('FlatList');
export const SectionList = ({
  sections = [],
  renderItem,
  renderSectionHeader,
  keyExtractor,
  ListHeaderComponent,
  ListEmptyComponent,
  children,
  ...props
}: any) => {
  const renderedChildren: React.ReactNode[] = [];

  const headerNode = typeof ListHeaderComponent === 'function'
    ? React.createElement(ListHeaderComponent)
    : ListHeaderComponent;
  const renderedHeader = renderHostChild(headerNode, 'list-header');
  if (renderedHeader) renderedChildren.push(renderedHeader);

  let renderedItemCount = 0;

  sections.forEach((section: any, sectionIndex: number) => {
    const sectionHeaderNode = renderSectionHeader?.({ section });
    const renderedSectionHeader = renderHostChild(sectionHeaderNode, `section-header-${sectionIndex}`);
    if (renderedSectionHeader) renderedChildren.push(renderedSectionHeader);

    (section?.data ?? []).forEach((item: any, itemIndex: number) => {
      renderedItemCount += 1;
      const key = keyExtractor?.(item, itemIndex) ?? `section-${sectionIndex}-item-${itemIndex}`;
      renderedChildren.push(
        React.createElement(React.Fragment, { key }, renderItem?.({ item, index: itemIndex, section }))
      );
    });
  });

  if (renderedItemCount === 0) {
    const emptyNode = typeof ListEmptyComponent === 'function'
      ? React.createElement(ListEmptyComponent)
      : ListEmptyComponent;
    const renderedEmpty = renderHostChild(emptyNode, 'list-empty');
    if (renderedEmpty) renderedChildren.push(renderedEmpty);
  }

  if (children) {
    renderedChildren.push(children);
  }

  return React.createElement('SectionList', props, renderedChildren);
};
export const Modal = createHostComponent('Modal');
export const TouchableOpacity = createHostComponent('TouchableOpacity');
export const Pressable = createHostComponent('Pressable');
export const Switch = createHostComponent('Switch');
export const KeyboardAvoidingView = createHostComponent('KeyboardAvoidingView');
export const Image = createHostComponent('Image');
export const ActivityIndicator = createHostComponent('ActivityIndicator');

export const TextInput = (props: any) =>
  React.createElement('TextInput', props, props.children);

export const Share = {
  share: async () => ({ action: 'dismissedAction' }),
};

export const Alert = {
  alert: () => {},
};

export const AppState = {
  currentState: 'active',
  addEventListener: () => ({ remove: () => {} }),
};

export const AccessibilityInfo = {
  isReduceMotionEnabled: async () => false,
  addEventListener: () => ({ remove: () => {} }),
  announceForAccessibility: (_announcement: string) => {},
};

export const Animated = {
  View: createHostComponent('Animated.View'),
  ScrollView: createHostComponent('Animated.ScrollView'),
  Value: class {
    _value: number;
    constructor(value: number) {
      this._value = value;
    }
    setValue(value: number) {
      this._value = value;
    }
  },
  event: () => () => {},
  timing: (value: any, config: any) => ({
    start: (cb?: () => void) => {
      value?.setValue?.(config?.toValue ?? value?._value ?? 0);
      cb?.();
    },
  }),
};

export const Platform = { OS: 'web', select: (options: any) => options?.web ?? options?.default };
export const I18nManager = { isRTL: false };
export const BackHandler = {
  addEventListener: (..._args: any[]) => ({ remove: () => undefined }),
};

export const AppRegistry = {
  registerHeadlessTask: () => undefined,
};

export const NativeModules = {
  EXDevLauncher: null,
};

export const Dimensions = {
  get: (_dimension?: 'window' | 'screen') => ({ width: 390, height: 844 }),
};

export const useWindowDimensions = () => ({
  ...Dimensions.get('window'),
  fontScale: 1,
  scale: 1,
});

export const Keyboard = {
  addListener: () => ({ remove: () => {} }),
  dismiss: () => {},
  isVisible: () => false,
};

export const PanResponder = {
  create: (config: any) => ({
    panHandlers: {
      onStartShouldSetResponder: (event: any, gestureState: any) =>
        config.onStartShouldSetPanResponder?.(event, gestureState) ?? false,
      onMoveShouldSetResponder: (event: any, gestureState: any) =>
        config.onMoveShouldSetPanResponder?.(event, gestureState) ?? false,
      onResponderMove: (event: any, gestureState: any) =>
        config.onPanResponderMove?.(event, gestureState),
      onResponderRelease: (event: any, gestureState: any) =>
        config.onPanResponderRelease?.(event, gestureState),
      onResponderTerminate: (event: any, gestureState: any) =>
        config.onPanResponderTerminate?.(event, gestureState),
    },
  }),
};

export const TurboModuleRegistry = {
  get: () => null,
};

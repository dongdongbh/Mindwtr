import React from 'react';

const createHostComponent = (name: string) => (props: any) =>
  React.createElement(name, props, props.children);

const renderHostChild = (child: any, key: string) => {
  if (child == null || child === false) return null;
  return React.createElement(React.Fragment, { key }, child);
};

export const StyleSheet = {
  create: <T extends Record<string, unknown>>(styles: T) => styles,
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

export const Animated = {
  View: createHostComponent('Animated.View'),
  ScrollView: createHostComponent('Animated.ScrollView'),
  Value: class {
    _value: number;
    constructor(value: number) {
      this._value = value;
    }
  },
  event: () => () => {},
  timing: () => ({ start: (cb?: () => void) => cb?.() }),
};

export const Platform = { OS: 'web', select: (options: any) => options?.web ?? options?.default };

export const Dimensions = {
  get: () => ({ width: 390, height: 844 }),
};

export const Keyboard = {
  addListener: () => ({ remove: () => {} }),
  dismiss: () => {},
};

export const TurboModuleRegistry = {
  get: () => null,
};

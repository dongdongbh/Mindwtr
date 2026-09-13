import React from 'react';
import { Platform } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareCardModal } from './share-card-modal';

const mocks = vi.hoisted(() => ({
  exportPng: vi.fn().mockResolvedValue('share'),
  keyboardListeners: new Map<string, () => void>(),
  imageKeys: [] as unknown[],
  queryCache: vi.fn().mockResolvedValue({}),
  renderSvg: vi.fn((input: {
    kind: string;
    reflection?: string;
    reviewDate?: string;
    style?: string;
  }) => JSON.stringify(input)),
}));

vi.mock('@mindwtr/core/share-card', () => ({
  SHARE_CARD_REFLECTION_LIMIT: 140,
  renderShareCardSvg: mocks.renderSvg,
}));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Image: { queryCache: mocks.queryCache },
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Keyboard: {
    isVisible: () => false,
    addListener: (event: string, listener: () => void) => {
      mocks.keyboardListeners.set(event, listener);
      return { remove: () => mocks.keyboardListeners.delete(event) };
    },
  },
  Modal: 'Modal',
  Platform: { OS: 'android' },
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('lucide-react-native', () => ({ X: 'X' }));
vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  return {
    default: class MockSvg {},
    Image: 'SvgImage',
    parse: (_xml: string, middleware: (root: any) => any) => {
      const image: any = {
        tag: 'image',
        props: { xlinkHref: 'data:image/png;base64,icon' },
        children: [],
        parent: null,
      };
      const root: any = { tag: 'svg', props: {}, children: [image], parent: null };
      image.parent = root;
      middleware(root);
      return {
        ...root,
        children: [ReactModule.createElement('SvgImage', { ...image.props, testID: 'share-card-icon' })],
      };
    },
    SvgAst: ({ ast, override }: any) => {
      mocks.imageKeys.push(ast?.children[0]?.key);
      return ReactModule.createElement('SvgAst', override, ast?.children);
    },
  };
});
vi.mock('../lib/share-card-export', () => ({
  exportShareCardPng: mocks.exportPng,
  isShareCardDismissal: () => false,
  ShareCardUnavailableError: class ShareCardUnavailableError extends Error {},
}));
vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) => ({
      'shareCard.action': 'Share my reflection',
      'shareCard.close': 'Close',
      'shareCard.defaultHint': 'The preview starts with a suggested reflection. Write your own to make it yours.',
      'shareCard.error': 'Could not create the image. Please try again.',
      'shareCard.generating': 'Preparing image…',
      'shareCard.preview': 'Image preview',
      'shareCard.privacy': 'Only the date and the note you write are included.',
      'shareCard.reflectionLabel': 'What are you taking into next week?',
      'shareCard.reflectionPlaceholder': 'A thought, a decision, or something to make space for.',
      'shareCard.save': 'Save image…',
      'shareCard.saved': 'Image saved',
      'shareCard.share': 'Share…',
      'shareCard.styleLabel': 'Card style',
      'shareCard.styleMinimal': 'Minimal',
      'shareCard.styleReflection': 'Reflection',
      'shareCard.styleRipple': 'Ripple',
      'shareCard.title': 'My weekly reflection',
      'shareCard.unavailable': 'Image sharing is not available on this device.',
    }[key] ?? key),
  }),
}));
vi.mock('../hooks/use-filled-button-colors', () => ({
  useFilledButtonColors: () => ({ backgroundColor: '#2563eb', textColor: '#ffffff' }),
}));
vi.mock('../hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#ffffff',
    border: '#d1d5db',
    cardBg: '#f8fafc',
    danger: '#dc2626',
    onTint: '#ffffff',
    secondaryText: '#475569',
    success: '#15803d',
    text: '#0f172a',
    tint: '#2563eb',
  }),
}));

beforeEach(() => {
  Platform.OS = 'android';
  mocks.keyboardListeners.clear();
  mocks.exportPng.mockReset().mockResolvedValue('share');
  mocks.imageKeys.length = 0;
  mocks.queryCache.mockReset().mockResolvedValue({});
  mocks.renderSvg.mockClear();
  vi.spyOn(Date.prototype, 'toLocaleDateString').mockReturnValue('September 12, 2026');
});

afterEach(() => vi.restoreAllMocks());

describe('ShareCardModal', () => {
  it.each(['android', 'ios'] as const)('keeps the keyboard avoidance frame stable on %s', (platform) => {
    Platform.OS = platform;
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<ShareCardModal visible onClose={() => {}} />); });
    const body = tree.root.find((node) => (node.type as unknown) === 'KeyboardAvoidingView');
    // Padding keeps the measured outer frame stable across keyboard hide and
    // share-sheet cancellation; height avoidance feeds changes back into itself.
    expect(body.props.behavior).toBe('padding');
    expect(body.props.enabled).toBe(platform !== 'android');
    if (platform === 'android') {
      act(() => mocks.keyboardListeners.get('keyboardDidShow')?.());
      expect(body.props.enabled).toBe(true);
      // Native sharing dismisses the keyboard before returning to the composer.
      act(() => mocks.keyboardListeners.get('keyboardDidHide')?.());
      expect(body.props.enabled).toBe(false);
      act(() => mocks.keyboardListeners.get('keyboardDidShow')?.());
      expect(body.props.enabled).toBe(true);
    }
    act(() => tree.unmount());
    expect(mocks.keyboardListeners.size).toBe(0);
  });

  it('renders only on demand with the frozen review date and no reflection by default', () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<ShareCardModal visible={false} onClose={() => {}} />);
    });
    expect(mocks.renderSvg).not.toHaveBeenCalled();

    act(() => tree.update(<ShareCardModal visible onClose={() => {}} />));

    expect(mocks.renderSvg).toHaveBeenLastCalledWith({
      kind: 'review',
      reflection: undefined,
      reviewDate: 'September 12, 2026',
      style: 'reflection',
    }, expect.any(Function), { textLayout: 'native' });
    expect(tree.root.findByProps({ children: 'Only the date and the note you write are included.' })).toBeDefined();
    expect(tree.root.findByProps({
      children: 'The preview starts with a suggested reflection. Write your own to make it yours.',
    })).toBeDefined();
    expect(Date.prototype.toLocaleDateString).toHaveBeenCalledWith('en', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    expect(tree.root.findByProps({ testID: 'share-card-export' }).props.disabled).toBe(true);
    expect(mocks.imageKeys.every((key) => key === 'share-card-icon')).toBe(true);
    act(() => tree.root.findByProps({ testID: 'share-card-icon' }).props.onLoad());
    expect(tree.root.findByProps({ testID: 'share-card-export' }).props.disabled).toBe(false);
  });

  it('caps Unicode reflection text and resets the note and style on every opening', () => {
    let tree!: ReactTestRenderer;
    const render = (visible: boolean) => <ShareCardModal visible={visible} onClose={() => {}} />;
    act(() => {
      tree = create(render(true));
    });
    const longNote = `${'a'.repeat(139)}🙂trailing`;
    act(() => tree.root.findByProps({ testID: 'share-card-reflection' }).props.onChangeText(longNote));
    act(() => tree.root.findByProps({ testID: 'share-card-style-minimal' }).props.onPress());
    const capped = `${'a'.repeat(139)}🙂`;
    expect(tree.root.findByProps({ testID: 'share-card-reflection' }).props.value).toBe(capped);
    expect(tree.root.findAllByProps({
      children: 'The preview starts with a suggested reflection. Write your own to make it yours.',
    })).toHaveLength(0);
    expect(mocks.renderSvg).toHaveBeenLastCalledWith({
      kind: 'review',
      reflection: capped,
      reviewDate: 'September 12, 2026',
      style: 'minimal',
    }, expect.any(Function), { textLayout: 'native' });

    act(() => tree.update(render(false)));
    act(() => tree.update(render(true)));
    expect(tree.root.findByProps({ testID: 'share-card-reflection' }).props.value).toBe('');
    expect(mocks.renderSvg).toHaveBeenLastCalledWith({
      kind: 'review',
      reflection: undefined,
      reviewDate: 'September 12, 2026',
      style: 'reflection',
    }, expect.any(Function), { textLayout: 'native' });
  });

  it('disables every control while exporting and shows a recoverable failure', async () => {
    let resolveExport!: (value: 'share') => void;
    const pendingExport = new Promise<'share'>((resolve) => {
      resolveExport = resolve;
    });
    mocks.exportPng.mockReturnValueOnce(pendingExport);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<ShareCardModal visible onClose={() => {}} />);
    });
    act(() => tree.root.findByProps({ testID: 'share-card-icon' }).props.onLoad());

    act(() => tree.root.findByProps({ testID: 'share-card-export' }).props.onPress());
    expect(tree.root.findByProps({ testID: 'share-card-close' }).props.disabled).toBe(true);
    expect(tree.root.findByProps({ testID: 'share-card-reflection' }).props.editable).toBe(false);
    expect(tree.root.findByProps({ testID: 'share-card-style-ripple' }).props.disabled).toBe(true);
    expect(tree.root.findByProps({ testID: 'share-card-export' }).props.disabled).toBe(true);

    await act(async () => {
      resolveExport('share');
      await pendingExport;
    });
    mocks.exportPng.mockRejectedValueOnce(new Error('capture failed'));
    await act(async () => {
      tree.root.findByProps({ testID: 'share-card-export' }).props.onPress();
      await Promise.resolve();
    });

    expect(tree.root.findByProps({ testID: 'share-card-message' }).props.children)
      .toBe('Could not create the image. Please try again.');
    expect(tree.root.findByProps({ testID: 'share-card-export' }).props.disabled).toBe(false);
  });
});

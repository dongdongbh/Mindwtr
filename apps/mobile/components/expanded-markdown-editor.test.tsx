import React from 'react';
import { Platform, TextInput } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { ExpandedMarkdownEditor } from './expanded-markdown-editor';

vi.mock('@mindwtr/core', async () => {
  const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  const storeState = {
    _allTasks: [],
    tasks: [],
    projects: [],
  };
  const useTaskStore = Object.assign((selector?: (state: typeof storeState) => unknown) => {
    return selector ? selector(storeState) : storeState;
  }, {
    getState: () => storeState,
  });
  return {
    ...actual,
    useTaskStore,
  };
});

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#000',
    cardBg: '#111',
    inputBg: '#111',
    filterBg: '#222',
    border: '#333',
    text: '#fff',
    secondaryText: '#aaa',
    icon: '#aaa',
    tint: '#3b82f6',
  }),
}));

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('expo-linking', () => ({
  openURL: vi.fn(),
}));

vi.mock('expo-router', () => ({
  router: {
    push: vi.fn(),
    navigate: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  },
}));

const flattenStyle = (style: any): Record<string, any> => {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
  }
  return style ?? {};
};

const withPlatform = (os: typeof Platform.OS, run: () => void) => {
  const originalPlatformOs = Platform.OS;
  Object.defineProperty(Platform, 'OS', {
    configurable: true,
    value: os,
  });
  try {
    run();
  } finally {
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: originalPlatformOs,
    });
  }
};

describe('ExpandedMarkdownEditor', () => {
  it.each(['()', '[]', '``'])('deletes an empty %s pair after stale native echoes', (pair) => {
    withPlatform('android', () => {
      for (const prefix of ['', 'note ']) {
        const onChange = vi.fn();
        let tree!: renderer.ReactTestRenderer;
        act(() => {
          tree = renderer.create(
            <ExpandedMarkdownEditor
              isOpen onClose={vi.fn()} value={prefix} onChange={onChange}
              title="Description" placeholder="Description" t={(key) => key} initialMode="edit"
              selection={{ start: prefix.length, end: prefix.length }}
              onSelectionChange={vi.fn()} canUndo={false} onUndo={() => undefined}
            />
          );
        });
        const input = () => tree.root.findByType(TextInput);
        const rawInsertion = prefix + pair[0];
        act(() => { input().props.onChangeText(rawInsertion); });
        expect(input().props.value).toBe(prefix + pair);
        act(() => { input().props.onChangeText(rawInsertion); });
        act(() => { input().props.onChangeText(rawInsertion); });
        expect(input().props.value).toBe(prefix + pair);

        const preventDefault = vi.fn();
        act(() => {
          input().props.onKeyPress({ nativeEvent: { key: 'Backspace' }, preventDefault });
          input().props.onChangeText(rawInsertion);
        });
        expect(input().props.value).toBe(rawInsertion);
        expect(onChange).toHaveBeenLastCalledWith(rawInsertion);
        act(() => {
          input().props.onKeyPress({ nativeEvent: { key: 'Backspace' }, preventDefault });
          input().props.onChangeText(prefix);
        });
        expect(input().props.value).toBe(prefix);
        expect(onChange).toHaveBeenLastCalledWith(prefix);
        expect(preventDefault).not.toHaveBeenCalled();
        act(() => { tree.unmount(); });
      }
    });
  });

  it('enables native spell checking in edit mode', () => {
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <ExpandedMarkdownEditor
          isOpen
          onClose={vi.fn()}
          value="Fix teh typo"
          onChange={vi.fn()}
          title="Description"
          placeholder="Description"
          t={(key) => key}
          initialMode="edit"
          selection={{ start: 0, end: 0 }}
          onSelectionChange={vi.fn()}
          canUndo={false}
          onUndo={() => undefined}
        />
      );
    });

    const input = tree!.root.findByType(TextInput);

    expect(input.props.spellCheck).toBe(true);
    expect(input.props.autoCorrect).toBe(true);
    expect(input.props.autoCapitalize).toBe('sentences');
    expect(input.props.autoComplete).toBe('off');
    expect(input.props.importantForAutofill).toBe('no');
    expect(input.props.inputMode).toBe('text');
    expect(input.props.textContentType).toBe('none');
    expect(input.props.keyboardType).toBe('default');

    act(() => {
      tree!.unmount();
    });
  });

  it('keeps paired text when Android sends a delayed raw replacement after key press', () => {
    const onChange = vi.fn();
    const onSelectionChange = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <ExpandedMarkdownEditor
          isOpen
          onClose={vi.fn()}
          value="read docs"
          onChange={onChange}
          title="Description"
          placeholder="Description"
          t={(key) => key}
          initialMode="edit"
          selection={{ start: 5, end: 9 }}
          onSelectionChange={onSelectionChange}
          canUndo={false}
          onUndo={() => undefined}
        />
      );
    });

    act(() => {
      tree!.root.findByType(TextInput).props.onChangeText('read [');
    });

    expect(onChange).toHaveBeenCalledWith('read [docs]');
    expect(onSelectionChange).toHaveBeenCalledWith({ start: 6, end: 10 });

    act(() => {
      tree!.root.findByType(TextInput).props.onChangeText('read [');
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(tree!.root.findByType(TextInput).props.value).toBe('read [docs]');

    act(() => {
      tree!.unmount();
    });
  });

  it('keeps paired text when Android sends a duplicate native pair insertion', () => {
    const onChange = vi.fn();
    const onSelectionChange = vi.fn();
    let tree: renderer.ReactTestRenderer;

    withPlatform('android', () => {
      act(() => {
        tree = renderer.create(
          <ExpandedMarkdownEditor
            isOpen
            onClose={vi.fn()}
            value=""
            onChange={onChange}
            title="Description"
            placeholder="Description"
            t={(key) => key}
            initialMode="edit"
            selection={{ start: 0, end: 0 }}
            onSelectionChange={onSelectionChange}
            canUndo={false}
            onUndo={() => undefined}
          />
        );
      });

      act(() => {
        tree!.root.findByType(TextInput).props.onChangeText('(');
      });

      expect(onChange).toHaveBeenCalledWith('()');
      expect(onSelectionChange).toHaveBeenCalledWith({ start: 1, end: 1 });

      act(() => {
        tree!.root.findByType(TextInput).props.onChangeText('(');
      });

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(tree!.root.findByType(TextInput).props.value).toBe('()');

      act(() => {
        tree!.root.findByType(TextInput).props.onChangeText('(())');
      });

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(tree!.root.findByType(TextInput).props.value).toBe('()');

      act(() => {
        tree!.unmount();
      });
    });
  });

  it('temporarily controls Android selection after nested list continuation rewrites', () => {
    const onChange = vi.fn();
    const onSelectionChange = vi.fn();
    let tree: renderer.ReactTestRenderer;

    withPlatform('android', () => {
      act(() => {
        tree = renderer.create(
          <ExpandedMarkdownEditor
            isOpen
            onClose={vi.fn()}
            value="  - item"
            onChange={onChange}
            title="Description"
            placeholder="Description"
            t={(key) => key}
            initialMode="edit"
            selection={{ start: 8, end: 8 }}
            onSelectionChange={onSelectionChange}
            canUndo={false}
            onUndo={() => undefined}
          />
        );
      });

      expect(tree!.root.findByType(TextInput).props.selection).toBeUndefined();

      act(() => {
        tree!.root.findByType(TextInput).props.onChangeText('  - item\n');
      });

      const input = tree!.root.findByType(TextInput);

      expect(onChange).toHaveBeenCalledWith('  - item\n  - ');
      expect(onSelectionChange).toHaveBeenCalledWith({ start: 13, end: 13 });
      expect(input.props.value).toBe('  - item\n  - ');
      expect(input.props.selection).toEqual({ start: 13, end: 13 });

      act(() => {
        tree!.unmount();
      });
    });
  });

  it('wraps selected text in a fenced code block when native input replaces it with triple backticks', () => {
    const onChange = vi.fn();
    const onSelectionChange = vi.fn();
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <ExpandedMarkdownEditor
          isOpen
          onClose={vi.fn()}
          value="run tests"
          onChange={onChange}
          title="Description"
          placeholder="Description"
          t={(key) => key}
          initialMode="edit"
          selection={{ start: 0, end: 9 }}
          onSelectionChange={onSelectionChange}
          canUndo={false}
          onUndo={() => undefined}
        />
      );
    });

    act(() => {
      tree!.root.findByType(TextInput).props.onChangeText('```');
    });

    expect(onChange).toHaveBeenCalledWith('```\nrun tests\n```');
    expect(onSelectionChange).toHaveBeenCalledWith({ start: 4, end: 13 });
    expect(tree!.root.findByType(TextInput).props.value).toBe('```\nrun tests\n```');

    act(() => {
      tree!.unmount();
    });
  });

  it('keeps the fullscreen edit field tall when the keyboard toolbar is visible', () => {
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <ExpandedMarkdownEditor
          isOpen
          onClose={vi.fn()}
          value={'1. List\n2. Hhh\n3.\n\n- list\njshs'}
          onChange={vi.fn()}
          title="Description"
          headerTitle="Reserve PT SOS"
          placeholder="Description"
          t={(key) => key}
          initialMode="edit"
          selection={{ start: 0, end: 0 }}
          onSelectionChange={vi.fn()}
          canUndo={false}
          onUndo={() => undefined}
        />
      );
    });

    const input = tree!.root.findByType(TextInput);

    act(() => {
      input.props.onFocus();
    });

    const editSurfaceStyle = flattenStyle(input.parent?.props.style);

    expect(editSurfaceStyle.paddingBottom).toBe(64);

    act(() => {
      tree!.unmount();
    });
  });
});

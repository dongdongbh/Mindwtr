import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addTask: vi.fn(async () => ({ success: true }) as { success: boolean }),
  back: vi.fn(),
}));

vi.mock('@mindwtr/core', async () => {
  const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  return {
    ...actual,
    useTaskStore: (selector: (state: { addTask: typeof mocks.addTask }) => unknown) =>
      selector({ addTask: mocks.addTask }),
  };
});

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: mocks.back }),
}));

vi.mock('react-native-safe-area-context', async () => {
  const { View } = await vi.importActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
  };
});

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#000', cardBg: '#111', text: '#fff', secondaryText: '#aaa',
    border: '#333', tint: '#3b82f6', onTint: '#fff',
  }),
}));

vi.mock('@/hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { large: 16 } }),
}));

import MindSweepModalScreen from '../app/mind-sweep-modal';

const findByTestId = (tree: renderer.ReactTestRenderer, testID: string) =>
  tree.root.findByProps({ testID });


const countHostsByTestId = (tree: renderer.ReactTestRenderer, testID: string) =>
  tree.root.findAll((node) => typeof node.type === 'string' && node.props.testID === testID).length;

describe('MindSweepModalScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the intro step with scope options and starts the flow', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<MindSweepModalScreen />);
    });

    expect(findByTestId(tree, 'mind-sweep-scope-work')).toBeDefined();
    renderer.act(() => {
      findByTestId(tree, 'mind-sweep-start').props.onPress();
    });
    expect(findByTestId(tree, 'mind-sweep-group-title').props.children)
      .toBe('mindSweep.group.homeStuff.title');
  });

  it('captures typed items into the inbox', async () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<MindSweepModalScreen />);
    });
    renderer.act(() => {
      findByTestId(tree, 'mind-sweep-start').props.onPress();
    });

    renderer.act(() => {
      findByTestId(tree, 'mind-sweep-input').props.onChangeText('Call the plumber');
    });
    await renderer.act(async () => {
      await findByTestId(tree, 'mind-sweep-add').props.onPress();
    });

    expect(mocks.addTask).toHaveBeenCalledWith('Call the plumber', { status: 'inbox' });
    expect(countHostsByTestId(tree, 'mind-sweep-captured-item')).toBe(1);
  });

  it('keeps a rejected item out of the captured list and shows the failure', async () => {
    mocks.addTask.mockResolvedValueOnce({ success: false });
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<MindSweepModalScreen />);
    });
    renderer.act(() => {
      findByTestId(tree, 'mind-sweep-start').props.onPress();
    });

    renderer.act(() => {
      findByTestId(tree, 'mind-sweep-input').props.onChangeText('Call the plumber');
    });
    await renderer.act(async () => {
      await findByTestId(tree, 'mind-sweep-add').props.onPress();
    });

    expect(findByTestId(tree, 'mind-sweep-add-failed')).toBeDefined();
    expect(countHostsByTestId(tree, 'mind-sweep-captured-item')).toBe(0);
    expect(findByTestId(tree, 'mind-sweep-input').props.value).toBe('Call the plumber');
  });

  it('walks work scope groups to the summary and closes', async () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<MindSweepModalScreen />);
    });
    renderer.act(() => {
      findByTestId(tree, 'mind-sweep-scope-work').props.onPress();
    });
    renderer.act(() => {
      findByTestId(tree, 'mind-sweep-start').props.onPress();
    });
    expect(findByTestId(tree, 'mind-sweep-group-title').props.children)
      .toBe('mindSweep.group.commitments.title');

    for (let i = 0; i < 4; i += 1) {
      renderer.act(() => {
        findByTestId(tree, 'mind-sweep-next').props.onPress();
      });
    }
    expect(findByTestId(tree, 'mind-sweep-summary')).toBeDefined();
    renderer.act(() => {
      findByTestId(tree, 'mind-sweep-finish').props.onPress();
    });
    expect(mocks.back).toHaveBeenCalled();
  });
});

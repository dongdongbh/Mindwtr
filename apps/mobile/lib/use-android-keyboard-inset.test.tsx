import React from 'react';
import { Dimensions, Keyboard, Platform, Text, type KeyboardEvent } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAndroidKeyboardInset, useKeyboardInset } from './use-android-keyboard-inset';
import { measureAndroidModalKeyboardInset } from './android-modal-keyboard';
import { logInfo } from './app-log';

vi.mock('./android-modal-keyboard', () => ({ measureAndroidModalKeyboardInset: vi.fn() }));
vi.mock('./app-log', () => ({ logInfo: vi.fn().mockResolvedValue(undefined) }));

const originalPlatformOs = Platform.OS;
const frameEvent = (height: number, screenY = Dimensions.get('screen').height - height): KeyboardEvent => ({
  duration: 0, easing: 'keyboard', endCoordinates: { screenX: 0, screenY, height, width: 360 },
});

const setPlatform = (os: typeof Platform.OS) => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
};

function Probe({ active }: { active?: boolean }) {
  const inset = useAndroidKeyboardInset(active);
  return <Text>{`inset:${inset}`}</Text>;
}

function CrossPlatformProbe({ active }: { active?: boolean }) {
  const inset = useKeyboardInset(active);
  return <Text>{`inset:${inset}`}</Text>;
}

const insetText = (tree: ReturnType<typeof create>): string => {
  const node = tree.root.findByType(Text);
  return String(node.props.children);
};

afterEach(() => {
  setPlatform(originalPlatformOs);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useAndroidKeyboardInset', () => {
  it('replaces the reporter zero-height activity event with settled modal-window measurements', async () => {
    setPlatform('android');
    vi.useFakeTimers();
    vi.spyOn(Dimensions, 'get').mockImplementation((kind) => ({
      height: kind === 'screen' ? 800 : 748, width: 360, scale: 3, fontScale: 1,
    }));
    const listeners = new Map<string, Parameters<typeof Keyboard.addListener>[1]>();
    const subscribe = Keyboard.addListener.bind(Keyboard);
    vi.spyOn(Keyboard, 'addListener').mockImplementation((event, callback) => {
      listeners.set(event, callback);
      return subscribe(event, callback);
    });
    const inputRef = React.createRef<import('react-native').TextInput>();
    // The input is a native boundary; this test only needs its mounted identity.
    inputRef.current = {} as import('react-native').TextInput;
    function ModalProbe({ active = true }: { active?: boolean }) {
      return <Text>{`inset:${useAndroidKeyboardInset(active, inputRef)}`}</Text>;
    }
    vi.mocked(measureAndroidModalKeyboardInset).mockResolvedValueOnce(0).mockResolvedValue(283);
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<ModalProbe />); });
    act(() => {
      listeners.get('keyboardDidShow')?.(frameEvent(0, 756));
    });
    expect(insetText(tree)).toBe('inset:44');
    await act(async () => { await vi.advanceTimersByTimeAsync(480); });
    expect(insetText(tree)).toBe('inset:283');
    expect(measureAndroidModalKeyboardInset).toHaveBeenLastCalledWith(inputRef.current);
    expect(measureAndroidModalKeyboardInset).toHaveBeenCalledTimes(4);
    expect(logInfo).toHaveBeenCalledWith('Quick capture modal IME inset measured', {
      scope: 'quick-capture', force: true, extra: {
        releaseCheck: 'v1.3.8/quick-capture-modal-ime', eventInset: 44, nativeInset: 283, outcome: 'measured',
      },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(measureAndroidModalKeyboardInset).toHaveBeenCalledTimes(4);
    act(() => { tree.unmount(); });
  });

  it.each(['hide', 'inactive', 'new-frame'])('ignores an old native response after %s', async (action) => {
    setPlatform('android');
    vi.useFakeTimers();
    const listeners = new Map<string, Parameters<typeof Keyboard.addListener>[1]>();
    const subscribe = Keyboard.addListener.bind(Keyboard);
    vi.spyOn(Keyboard, 'addListener').mockImplementation((event, callback) => {
      listeners.set(event, callback);
      return subscribe(event, callback);
    });
    const inputRef = { current: {} as import('react-native').TextInput };
    function ModalProbe({ active = true }: { active?: boolean }) {
      return <Text>{`inset:${useAndroidKeyboardInset(active, inputRef)}`}</Text>;
    }
    let resolve!: (inset: number) => void;
    vi.mocked(measureAndroidModalKeyboardInset).mockReturnValue(new Promise((done) => { resolve = done; }));
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<ModalProbe />); });
    act(() => { listeners.get('keyboardDidShow')?.(frameEvent(44)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => {
      if (action === 'hide') listeners.get('keyboardDidHide')?.(frameEvent(0));
      if (action === 'inactive') tree.update(<ModalProbe active={false} />);
      if (action === 'new-frame') listeners.get('keyboardDidChangeFrame')?.(frameEvent(150));
    });
    await act(async () => { resolve(283); });
    expect(insetText(tree)).toBe(action === 'new-frame' ? 'inset:150' : 'inset:0');
    act(() => { tree.unmount(); });
  });

  it('tracks the measured keyboard height on Android and resets on hide', () => {
    setPlatform('android');
    const listeners = new Map<string, (event?: any) => void>();
    vi.spyOn(Keyboard, 'addListener').mockImplementation((event: string, cb: any) => {
      listeners.set(event, cb);
      return { remove: vi.fn() } as any;
    });

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<Probe active />);
    });

    expect(insetText(tree)).toBe('inset:0');

    act(() => {
      listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 320 } });
    });
    expect(insetText(tree)).toBe('inset:320');

    act(() => {
      listeners.get('keyboardDidHide')?.();
    });
    expect(insetText(tree)).toBe('inset:0');
  });

  it('does not attach listeners or report an inset on iOS', () => {
    setPlatform('ios');
    const addListener = vi.spyOn(Keyboard, 'addListener');

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<Probe active />);
    });

    expect(addListener).not.toHaveBeenCalled();
    expect(insetText(tree)).toBe('inset:0');
  });

  it('stays at zero while inactive', () => {
    setPlatform('android');
    const addListener = vi.spyOn(Keyboard, 'addListener');

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<Probe active={false} />);
    });

    expect(addListener).not.toHaveBeenCalled();
    expect(insetText(tree)).toBe('inset:0');
  });
});

describe('useKeyboardInset', () => {
  it('tracks the keyboard frame on iOS via the will* events and reads offscreen frames as zero', () => {
    setPlatform('ios');
    vi.spyOn(Dimensions, 'get').mockReturnValue({ height: 800, width: 400, scale: 2, fontScale: 1 });
    const listeners = new Map<string, (event?: any) => void>();
    vi.spyOn(Keyboard, 'addListener').mockImplementation((event: string, cb: any) => {
      listeners.set(event, cb);
      return { remove: vi.fn() } as any;
    });

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CrossPlatformProbe active />);
    });

    expect(listeners.has('keyboardWillShow')).toBe(true);
    expect(listeners.has('keyboardWillChangeFrame')).toBe(true);
    expect(listeners.has('keyboardWillHide')).toBe(true);

    act(() => {
      listeners.get('keyboardWillShow')?.({ endCoordinates: { screenY: 500, height: 300 } });
    });
    expect(insetText(tree)).toBe('inset:300');

    // A frame change (predictive bar toggled) updates from the new top edge.
    act(() => {
      listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: { screenY: 540, height: 300 } });
    });
    expect(insetText(tree)).toBe('inset:260');

    // A frame change that slides the keyboard offscreen must read 0 even
    // though endCoordinates.height still reports the keyboard's size.
    act(() => {
      listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: { screenY: 800, height: 300 } });
    });
    expect(insetText(tree)).toBe('inset:0');

    act(() => {
      listeners.get('keyboardWillShow')?.({ endCoordinates: { screenY: 500, height: 300 } });
      listeners.get('keyboardWillHide')?.();
    });
    expect(insetText(tree)).toBe('inset:0');
  });

  it('keeps the Android did* events and defensive frame math', () => {
    setPlatform('android');
    const listeners = new Map<string, (event?: any) => void>();
    vi.spyOn(Keyboard, 'addListener').mockImplementation((event: string, cb: any) => {
      listeners.set(event, cb);
      return { remove: vi.fn() } as any;
    });

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CrossPlatformProbe active />);
    });

    expect(listeners.has('keyboardDidShow')).toBe(true);

    act(() => {
      listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 320 } });
    });
    expect(insetText(tree)).toBe('inset:320');

    act(() => {
      listeners.get('keyboardDidHide')?.();
    });
    expect(insetText(tree)).toBe('inset:0');
  });

  it('stays at zero while inactive', () => {
    setPlatform('ios');
    const addListener = vi.spyOn(Keyboard, 'addListener');

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CrossPlatformProbe active={false} />);
    });

    expect(addListener).not.toHaveBeenCalled();
    expect(insetText(tree)).toBe('inset:0');
  });
});

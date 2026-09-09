import React, { memo } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { QuickCaptureProvider, useQuickCapture, type QuickCaptureOptions } from './quick-capture-context';

describe('QuickCaptureProvider', () => {
  it('does not invalidate consumers when only the value wrapper changes', () => {
    const onRender = vi.fn();
    const openQuickCapture = vi.fn();
    const Consumer = memo(function Consumer() {
      onRender(useQuickCapture());
      return null;
    });
    const render = () => (
      <QuickCaptureProvider value={{ openQuickCapture }}>
        <Consumer />
      </QuickCaptureProvider>
    );
    let tree!: ReactTestRenderer;
    act(() => { tree = create(render()); });
    const initialCount = onRender.mock.calls.length;
    act(() => { tree.update(render()); });
    act(() => { tree.update(render()); });
    expect(onRender).toHaveBeenCalledTimes(initialCount);
    act(() => { tree.unmount(); });
  });

  it('propagates a replaced action and preserves capture options', () => {
    const firstAction = vi.fn();
    const nextAction = vi.fn();
    let controls!: ReturnType<typeof useQuickCapture>;
    const Consumer = memo(function Consumer() {
      controls = useQuickCapture();
      return null;
    });
    const render = (openQuickCapture: typeof firstAction) => (
      <QuickCaptureProvider value={{ openQuickCapture }}>
        <Consumer />
      </QuickCaptureProvider>
    );
    let tree!: ReactTestRenderer;
    act(() => { tree = create(render(firstAction)); });
    const initialControls = controls;
    act(() => { tree.update(render(nextAction)); });
    expect(controls).not.toBe(initialControls);
    const options: QuickCaptureOptions = {
      initialProps: { areaId: 'active-area' },
      initialValue: 'Example capture',
      autoRecord: true,
      returnTo: '/inbox',
    };
    controls.openQuickCapture(options);
    controls.openQuickCapture();
    expect(firstAction).not.toHaveBeenCalled();
    expect(nextAction).toHaveBeenNthCalledWith(1, options);
    expect(nextAction).toHaveBeenNthCalledWith(2);
    act(() => { tree.unmount(); });
  });
});

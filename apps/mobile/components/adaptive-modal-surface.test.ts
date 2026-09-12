import { describe, expect, it, vi } from 'vitest';

import { resolveAdaptiveWindow } from '@/lib/adaptive-window';
import { resolveAdaptiveModalSurfaceStyle } from './adaptive-modal-surface';

vi.mock('@/components/adaptive-window-context', () => ({
  useAdaptiveWindow: vi.fn(),
}));

describe('resolveAdaptiveModalSurfaceStyle', () => {
  it('leaves ordinary compact sheets on their existing layout path', () => {
    const layout = resolveAdaptiveWindow({ width: 390, height: 844, platform: 'android' });
    expect(resolveAdaptiveModalSurfaceStyle(layout, 'sheet')).toBeNull();
  });

  it('centers an expanded editor without changing its mounted component', () => {
    const layout = resolveAdaptiveWindow({ width: 1000, height: 700, platform: 'android' });
    expect(resolveAdaptiveModalSurfaceStyle(layout, 'editor')).toMatchObject({
      height: 700,
      left: 70,
      position: 'absolute',
      top: 0,
      width: 860,
    });
  });

  it('contains a sheet in the unobstructed pane when a hinge separates the window', () => {
    const layout = resolveAdaptiveWindow({
      width: 900,
      height: 674,
      platform: 'android',
      nativeSnapshot: {
        width: 900,
        height: 674,
        features: [{
          bounds: { left: 446, top: 0, right: 454, bottom: 674 },
          orientation: 'vertical',
          state: 'half-opened',
          isSeparating: true,
          occlusionType: 'full',
        }],
      },
    });
    const style = resolveAdaptiveModalSurfaceStyle(layout, 'sheet');

    expect(style).toMatchObject({ marginBottom: 0, marginLeft: 12, maxHeight: 674, width: 414 });
  });

  it('keeps a tabletop sheet in the bottom-action pane near compact navigation', () => {
    const layout = resolveAdaptiveWindow({
      width: 674,
      height: 841,
      platform: 'android',
      nativeSnapshot: {
        width: 674,
        height: 841,
        features: [{
          bounds: { left: 0, top: 418, right: 674, bottom: 423 },
          orientation: 'horizontal',
          state: 'half-opened',
          isSeparating: true,
          occlusionType: 'full',
        }],
      },
    });

    expect(resolveAdaptiveModalSurfaceStyle(layout, 'sheet')).toMatchObject({
      marginBottom: 0,
      maxHeight: 410,
      width: 650,
    });
  });

  it('anchors an expanded sheet near the rail and mirrors the anchor in RTL', () => {
    const ltr = resolveAdaptiveWindow({ width: 1280, height: 800, platform: 'android' });
    expect(resolveAdaptiveModalSurfaceStyle(ltr, 'sheet')).toMatchObject({
      marginLeft: 100,
      width: 680,
    });

    const rtl = resolveAdaptiveWindow({
      width: 1280,
      height: 800,
      isRtl: true,
      platform: 'android',
    });
    expect(resolveAdaptiveModalSurfaceStyle(rtl, 'sheet')).toMatchObject({
      marginLeft: 500,
      width: 680,
    });
  });
});

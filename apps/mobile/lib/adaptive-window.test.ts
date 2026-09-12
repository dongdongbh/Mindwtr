import { describe, expect, it } from 'vitest';

import {
  ADAPTIVE_HINGE_ACTION_GAP,
  getAdaptiveWindowDiagnostic,
  resolveAdaptiveWindow,
} from './adaptive-window';

const snapshot = (
  width: number,
  height: number,
  features: NonNullable<Parameters<typeof resolveAdaptiveWindow>[0]['nativeSnapshot']>['features'] = [],
) => ({ width, height, features });

describe('resolveAdaptiveWindow', () => {
  it.each([
    { name: 'ordinary phone portrait', width: 390, height: 844 },
    { name: 'unfolded Fold portrait below the width threshold', width: 674, height: 841 },
    { name: 'short wide multi-window', width: 900, height: 470 },
  ])('keeps $name compact', ({ width, height }) => {
    expect(resolveAdaptiveWindow({ width, height, platform: 'android' }).mode).toBe('compact');
  });

  it('uses an expanded rail for a sufficiently large Fold landscape window', () => {
    const layout = resolveAdaptiveWindow({
      width: 841,
      height: 674,
      platform: 'android',
      nativeSnapshot: snapshot(841, 674),
    });

    expect(layout.mode).toBe('expanded');
    expect(layout.navigationWidth).toBe(88);
    expect(layout.navigationPlacement).toBe('left');
  });

  it('requires extra content width when the font scale is large', () => {
    expect(resolveAdaptiveWindow({
      width: 900,
      height: 674,
      fontScale: 1.35,
      platform: 'android',
    }).mode).toBe('compact');
    expect(resolveAdaptiveWindow({
      width: 1040,
      height: 674,
      fontScale: 1.35,
      platform: 'android',
    }).mode).toBe('expanded');
  });

  it('places the rail on the logical start edge in RTL', () => {
    const layout = resolveAdaptiveWindow({
      width: 900,
      height: 674,
      isRtl: true,
      platform: 'android',
    });

    expect(layout.navigationPlacement).toBe('right');
  });

  it('treats a nonseparating flat crease as normal content', () => {
    const layout = resolveAdaptiveWindow({
      width: 900,
      height: 674,
      platform: 'android',
      nativeSnapshot: snapshot(900, 674, [{
        bounds: { left: 449, top: 0, right: 451, bottom: 674 },
        orientation: 'vertical',
        state: 'flat',
        isSeparating: false,
        occlusionType: 'none',
      }]),
    });

    expect(layout.activeFeature).toBeNull();
    expect(layout.foregroundFrame).toEqual({ x: 0, y: 0, width: 900, height: 674 });
  });

  it('keeps foreground actions in one pane around a separating vertical hinge', () => {
    const layout = resolveAdaptiveWindow({
      width: 900,
      height: 674,
      platform: 'android',
      nativeSnapshot: snapshot(900, 674, [{
        bounds: { left: 446, top: 0, right: 454, bottom: 674 },
        orientation: 'vertical',
        state: 'half-opened',
        isSeparating: true,
        occlusionType: 'full',
      }]),
    });

    expect(layout.foregroundFrame.x).toBe(454 + ADAPTIVE_HINGE_ACTION_GAP);
    expect(layout.foregroundFrame.width).toBe(900 - 454 - ADAPTIVE_HINGE_ACTION_GAP);
    expect(layout.navigationActionFrame).toEqual({ x: 0, y: 0, width: 438, height: 674 });
  });

  it('moves compact bottom navigation away from a separating vertical hinge', () => {
    const layout = resolveAdaptiveWindow({
      width: 674,
      height: 841,
      platform: 'android',
      nativeSnapshot: snapshot(674, 841, [{
        bounds: { left: 333, top: 0, right: 341, bottom: 841 },
        orientation: 'vertical',
        state: 'half-opened',
        isSeparating: true,
        occlusionType: 'full',
      }]),
    });

    const navigationCenter = layout.foregroundFrame.x + (layout.foregroundFrame.width / 2);
    expect(layout.mode).toBe('compact');
    expect(navigationCenter).toBeGreaterThan(341 + ADAPTIVE_HINGE_ACTION_GAP);
    expect(layout.navigationActionFrame).toEqual(layout.foregroundFrame);
  });

  it('keeps foreground actions above a horizontal separating hinge', () => {
    const layout = resolveAdaptiveWindow({
      width: 674,
      height: 841,
      platform: 'android',
      nativeSnapshot: snapshot(674, 841, [{
        bounds: { left: 0, top: 418, right: 674, bottom: 423 },
        orientation: 'horizontal',
        state: 'half-opened',
        isSeparating: true,
        occlusionType: 'full',
      }]),
    });

    expect(layout.mode).toBe('compact');
    expect(layout.foregroundFrame).toEqual({
      x: 0,
      y: 0,
      width: 674,
      height: 418 - ADAPTIVE_HINGE_ACTION_GAP,
    });
    expect(layout.navigationActionFrame).toEqual({
      x: 0,
      y: 423 + ADAPTIVE_HINGE_ACTION_GAP,
      width: 674,
      height: 841 - 423 - ADAPTIVE_HINGE_ACTION_GAP,
    });
  });

  it('keeps a centered tabletop Fold compact when neither pane can contain the rail', () => {
    const layout = resolveAdaptiveWindow({
      width: 841,
      height: 674,
      platform: 'android',
      nativeSnapshot: snapshot(841, 674, [{
        bounds: { left: 0, top: 333, right: 841, bottom: 341 },
        orientation: 'horizontal',
        state: 'half-opened',
        isSeparating: true,
        occlusionType: 'full',
      }]),
    });

    expect(layout.mode).toBe('compact');
    expect(layout.navigationFrame).toEqual({ x: 0, y: 0, width: 841, height: 325 });
  });

  it('contains an eligible expanded tabletop rail inside the larger pane', () => {
    const layout = resolveAdaptiveWindow({
      width: 1000,
      height: 1000,
      platform: 'android',
      nativeSnapshot: snapshot(1000, 1000, [{
        bounds: { left: 0, top: 600, right: 1000, bottom: 608 },
        orientation: 'horizontal',
        state: 'half-opened',
        isSeparating: true,
        occlusionType: 'full',
      }]),
    });

    expect(layout.mode).toBe('expanded');
    expect(layout.navigationFrame).toEqual({ x: 0, y: 0, width: 1000, height: 592 });
    expect(layout.navigationActionFrame).toEqual(layout.navigationFrame);
  });

  it('ignores a stale native snapshot after a resize', () => {
    const layout = resolveAdaptiveWindow({
      width: 900,
      height: 674,
      platform: 'android',
      nativeSnapshot: snapshot(390, 844, [{
        bounds: { left: 190, top: 0, right: 200, bottom: 844 },
        orientation: 'vertical',
        state: 'half-opened',
        isSeparating: true,
        occlusionType: 'full',
      }]),
    });

    expect(layout.activeFeature).toBeNull();
    expect(layout.nativeSnapshot).toBeNull();
  });

  it('retains and clips same-width native hinge geometry when the IME shrinks the root', () => {
    const layout = resolveAdaptiveWindow({
      width: 900,
      height: 400,
      platform: 'android',
      nativeSnapshot: snapshot(900, 674, [{
        bounds: { left: 446, top: 0, right: 454, bottom: 674 },
        orientation: 'vertical',
        state: 'half-opened',
        isSeparating: true,
        occlusionType: 'full',
      }]),
    });

    expect(layout.mode).toBe('compact');
    expect(layout.nativeSnapshot).not.toBeNull();
    expect(layout.activeFeature?.orientation).toBe('vertical');
    expect(layout.foregroundFrame).toMatchObject({ x: 462, height: 400 });
  });

  it('does not constrain foreground content around a hinge clipped below the IME viewport', () => {
    const layout = resolveAdaptiveWindow({
      width: 674,
      height: 400,
      platform: 'android',
      nativeSnapshot: snapshot(674, 841, [{
        bounds: { left: 0, top: 418, right: 674, bottom: 423 },
        orientation: 'horizontal',
        state: 'half-opened',
        isSeparating: true,
        occlusionType: 'full',
      }]),
    });

    expect(layout.nativeSnapshot).not.toBeNull();
    expect(layout.activeFeature).toBeNull();
    expect(layout.foregroundFrame).toEqual({ x: 0, y: 0, width: 674, height: 400 });
  });

  it('keeps compact actions usable above a tabletop hinge when the IME leaves a tiny bottom pane', () => {
    const layout = resolveAdaptiveWindow({
      width: 841,
      height: 430,
      platform: 'android',
      nativeSnapshot: snapshot(841, 674, [{
        bounds: { left: 0, top: 400, right: 841, bottom: 420 },
        orientation: 'horizontal',
        state: 'half-opened',
        isSeparating: true,
        occlusionType: 'full',
      }]),
    });

    expect(layout.mode).toBe('compact');
    expect(layout.navigationActionFrame).toEqual({ x: 0, y: 0, width: 841, height: 392 });
  });

  it('reports only native-backed layout and posture diagnostics', () => {
    const fallback = resolveAdaptiveWindow({ width: 900, height: 674, platform: 'android' });
    expect(getAdaptiveWindowDiagnostic(fallback)).toBeNull();

    const nativeBacked = resolveAdaptiveWindow({
      width: 900,
      height: 674,
      platform: 'android',
      nativeSnapshot: snapshot(900, 674, [{
        bounds: { left: 446, top: 0, right: 454, bottom: 674 },
        orientation: 'vertical',
        state: 'half-opened',
        isSeparating: true,
        occlusionType: 'full',
      }]),
    });
    expect(getAdaptiveWindowDiagnostic(nativeBacked)).toEqual({ count: 1, reason: 'expanded-book' });
  });
});

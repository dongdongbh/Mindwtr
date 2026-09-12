import type {
  AndroidFoldingFeature,
  AndroidWindowLayoutSnapshot,
} from '../modules/android-window-layout';

export const EXPANDED_NAV_MIN_WIDTH = 840;
export const EXPANDED_NAV_MIN_USABLE_HEIGHT = 480;
export const EXPANDED_CONTENT_MIN_WIDTH = 600;
export const ADAPTIVE_HINGE_ACTION_GAP = 8;
export const COMPACT_ACTION_PANE_MIN_HEIGHT = 260;

export type AdaptiveWindowMode = 'compact' | 'expanded';
export type LogicalNavigationPlacement = 'left' | 'right';

export type AdaptiveWindowInsets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type AdaptiveWindowFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AdaptiveWindowInput = {
  width: number;
  height: number;
  fontScale?: number;
  insets?: Partial<AdaptiveWindowInsets>;
  isRtl?: boolean;
  platform?: 'android' | 'other';
  nativeSnapshot?: AndroidWindowLayoutSnapshot | null;
};

export type AdaptiveWindowLayout = {
  width: number;
  height: number;
  fontScale: number;
  insets: AdaptiveWindowInsets;
  usableWidth: number;
  usableHeight: number;
  mode: AdaptiveWindowMode;
  isExpanded: boolean;
  navigationPlacement: LogicalNavigationPlacement;
  navigationWidth: number;
  navigationFrame: AdaptiveWindowFrame;
  navigationActionFrame: AdaptiveWindowFrame;
  activeFeature: AndroidFoldingFeature | null;
  foregroundFrame: AdaptiveWindowFrame;
  nativeSnapshot: AndroidWindowLayoutSnapshot | null;
};

export type AdaptiveWindowDiagnostic = {
  count: number;
  reason: `${AdaptiveWindowMode}-${'flat' | 'book' | 'tabletop'}`;
};

const DEFAULT_INSETS: AdaptiveWindowInsets = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
};

const finiteNonNegative = (value: unknown, fallback = 0) => (
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback
);

const positiveDimension = (value: unknown, fallback: number) => {
  const normalized = finiteNonNegative(value, fallback);
  return normalized > 0 ? normalized : fallback;
};

const normalizeInsets = (insets?: Partial<AdaptiveWindowInsets>): AdaptiveWindowInsets => ({
  top: finiteNonNegative(insets?.top),
  right: finiteNonNegative(insets?.right),
  bottom: finiteNonNegative(insets?.bottom),
  left: finiteNonNegative(insets?.left),
});

const isFeatureActive = (feature: AndroidFoldingFeature) => (
  feature.isSeparating || feature.occlusionType === 'full'
);

const featureIntersectionArea = (
  feature: AndroidFoldingFeature,
  width: number,
  height: number,
) => {
  const left = Math.max(0, Math.min(width, feature.bounds.left));
  const right = Math.max(left, Math.min(width, feature.bounds.right));
  const top = Math.max(0, Math.min(height, feature.bounds.top));
  const bottom = Math.max(top, Math.min(height, feature.bounds.bottom));
  const measuredWidth = right - left;
  const measuredHeight = bottom - top;

  // Separating features can be represented as a zero-width or zero-height line.
  return feature.orientation === 'vertical'
    ? Math.max(1, measuredWidth) * Math.max(0, measuredHeight)
    : Math.max(0, measuredWidth) * Math.max(1, measuredHeight);
};

const featureIntersectsWindow = (
  feature: AndroidFoldingFeature,
  width: number,
  height: number,
) => {
  if (feature.orientation === 'vertical') {
    return feature.bounds.left <= width
      && feature.bounds.right >= 0
      && feature.bounds.top < height
      && feature.bounds.bottom > 0;
  }
  return feature.bounds.top <= height
    && feature.bounds.bottom >= 0
    && feature.bounds.left < width
    && feature.bounds.right > 0;
};

export const findActiveFoldingFeature = (
  snapshot: AndroidWindowLayoutSnapshot | null | undefined,
  width: number,
  height: number,
): AndroidFoldingFeature | null => {
  if (!snapshot) return null;
  const features = snapshot.features.filter((feature) => (
    isFeatureActive(feature) && featureIntersectsWindow(feature, width, height)
  ));
  if (features.length === 0) return null;

  return [...features].sort((left, right) => (
    featureIntersectionArea(right, width, height) - featureIntersectionArea(left, width, height)
  ))[0] ?? null;
};

const splitFrameAroundFeature = (
  frame: AdaptiveWindowFrame,
  feature: AndroidFoldingFeature,
  navigationPlacement: LogicalNavigationPlacement,
): AdaptiveWindowFrame => {
  const frameRight = frame.x + frame.width;
  const frameBottom = frame.y + frame.height;

  if (feature.orientation === 'vertical') {
    const featureLeft = Math.max(frame.x, Math.min(frameRight, feature.bounds.left));
    const featureRight = Math.max(featureLeft, Math.min(frameRight, feature.bounds.right));
    const leftFrame = {
      x: frame.x,
      y: frame.y,
      width: Math.max(0, featureLeft - ADAPTIVE_HINGE_ACTION_GAP - frame.x),
      height: frame.height,
    };
    const rightX = Math.min(frameRight, featureRight + ADAPTIVE_HINGE_ACTION_GAP);
    const rightFrame = {
      x: rightX,
      y: frame.y,
      width: Math.max(0, frameRight - rightX),
      height: frame.height,
    };
    if (leftFrame.width === rightFrame.width) {
      return navigationPlacement === 'left' ? rightFrame : leftFrame;
    }
    return leftFrame.width > rightFrame.width ? leftFrame : rightFrame;
  }

  const featureTop = Math.max(frame.y, Math.min(frameBottom, feature.bounds.top));
  const featureBottom = Math.max(featureTop, Math.min(frameBottom, feature.bounds.bottom));
  const topFrame = {
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: Math.max(0, featureTop - ADAPTIVE_HINGE_ACTION_GAP - frame.y),
  };
  const bottomY = Math.min(frameBottom, featureBottom + ADAPTIVE_HINGE_ACTION_GAP);
  const bottomFrame = {
    x: frame.x,
    y: bottomY,
    width: frame.width,
    height: Math.max(0, frameBottom - bottomY),
  };
  return topFrame.height >= bottomFrame.height ? topFrame : bottomFrame;
};

const frameForNavigationActions = (
  frame: AdaptiveWindowFrame,
  feature: AndroidFoldingFeature,
  navigationPlacement: LogicalNavigationPlacement,
  isExpanded: boolean,
): AdaptiveWindowFrame => {
  const frameRight = frame.x + frame.width;
  const frameBottom = frame.y + frame.height;
  if (feature.orientation === 'vertical') {
    if (!isExpanded) return splitFrameAroundFeature(frame, feature, navigationPlacement);
    const featureLeft = Math.max(frame.x, Math.min(frameRight, feature.bounds.left));
    const featureRight = Math.max(featureLeft, Math.min(frameRight, feature.bounds.right));
    if (navigationPlacement === 'left') {
      return {
        x: frame.x,
        y: frame.y,
        width: Math.max(0, featureLeft - ADAPTIVE_HINGE_ACTION_GAP - frame.x),
        height: frame.height,
      };
    }
    const rightX = Math.min(frameRight, featureRight + ADAPTIVE_HINGE_ACTION_GAP);
    return {
      x: rightX,
      y: frame.y,
      width: Math.max(0, frameRight - rightX),
      height: frame.height,
    };
  }

  if (isExpanded) return splitFrameAroundFeature(frame, feature, navigationPlacement);
  const featureBottom = Math.max(frame.y, Math.min(frameBottom, feature.bounds.bottom));
  const bottomY = Math.min(frameBottom, featureBottom + ADAPTIVE_HINGE_ACTION_GAP);
  const bottomFrame = {
    x: frame.x,
    y: bottomY,
    width: frame.width,
    height: Math.max(0, frameBottom - bottomY),
  };
  return bottomFrame.height >= COMPACT_ACTION_PANE_MIN_HEIGHT
    ? bottomFrame
    : splitFrameAroundFeature(frame, feature, navigationPlacement);
};

export const resolveAdaptiveWindow = ({
  width: inputWidth,
  height: inputHeight,
  fontScale: inputFontScale = 1,
  insets: inputInsets = DEFAULT_INSETS,
  isRtl = false,
  platform = 'other',
  nativeSnapshot = null,
}: AdaptiveWindowInput): AdaptiveWindowLayout => {
  const width = positiveDimension(inputWidth, 390);
  const height = positiveDimension(inputHeight, 844);
  const fontScale = Math.max(1, positiveDimension(inputFontScale, 1));
  const insets = normalizeInsets(inputInsets);
  const navigationPlacement = isRtl ? 'right' : 'left';
  const navigationWidth = fontScale > 1.15 ? 104 : 88;
  const usableWidth = Math.max(0, width - insets.left - insets.right);
  const baseUsableHeight = Math.max(0, height - insets.top - insets.bottom);
  const dimensionsMatchSnapshot = nativeSnapshot ? (() => {
    const widthMatches = Math.abs(nativeSnapshot.width - width) <= 48;
    const orientationMatches = (nativeSnapshot.width >= nativeSnapshot.height) === (width >= height);
    // adjustResize can shorten the React root while WindowMetrics and folding
    // feature coordinates correctly remain relative to the full activity window.
    const isVerticallyClippedViewport = widthMatches && height < nativeSnapshot.height - 48;
    return widthMatches && (orientationMatches || isVerticallyClippedViewport);
  })() : false;
  const safeNativeSnapshot = platform === 'android' && dimensionsMatchSnapshot ? nativeSnapshot : null;
  const activeFeature = findActiveFoldingFeature(safeNativeSnapshot, width, height);
  const featureWidth = activeFeature?.orientation === 'vertical'
    ? Math.max(0, activeFeature.bounds.right - activeFeature.bounds.left) + ADAPTIVE_HINGE_ACTION_GAP * 2
    : 0;
  const safeFrame = {
    x: insets.left,
    y: insets.top,
    width: usableWidth,
    height: baseUsableHeight,
  };
  const foregroundFrame = activeFeature
    ? splitFrameAroundFeature(safeFrame, activeFeature, navigationPlacement)
    : safeFrame;
  // A side rail may use the full safe height around a vertical hinge. Around a
  // horizontal/tabletop hinge it must fit in one contiguous pane, both for the
  // expanded eligibility decision and for its rendered frame.
  const navigationFrame = activeFeature?.orientation === 'horizontal'
    ? foregroundFrame
    : safeFrame;
  const usableHeight = navigationFrame.height;
  const scaledContentMinimum = EXPANDED_CONTENT_MIN_WIDTH * Math.min(fontScale, 1.35);
  const expandedContentWidth = usableWidth - navigationWidth - featureWidth;
  const isExpanded = platform === 'android'
    && width >= EXPANDED_NAV_MIN_WIDTH
    && usableHeight >= EXPANDED_NAV_MIN_USABLE_HEIGHT
    && expandedContentWidth >= scaledContentMinimum;
  const navigationActionFrame = activeFeature
    ? frameForNavigationActions(safeFrame, activeFeature, navigationPlacement, isExpanded)
    : safeFrame;

  return {
    width,
    height,
    fontScale,
    insets,
    usableWidth,
    usableHeight,
    mode: isExpanded ? 'expanded' : 'compact',
    isExpanded,
    navigationPlacement,
    navigationWidth,
    navigationFrame,
    navigationActionFrame,
    activeFeature,
    foregroundFrame,
    nativeSnapshot: safeNativeSnapshot,
  };
};

export const DEFAULT_ADAPTIVE_WINDOW = resolveAdaptiveWindow({
  width: 390,
  height: 844,
});

export const getAdaptiveWindowDiagnostic = (
  layout: AdaptiveWindowLayout,
): AdaptiveWindowDiagnostic | null => {
  if (!layout.nativeSnapshot) return null;
  const activeFeatures = layout.nativeSnapshot.features.filter(isFeatureActive);
  const posture = activeFeatures.some((feature) => feature.orientation === 'horizontal')
    ? 'tabletop'
    : activeFeatures.some((feature) => feature.orientation === 'vertical')
      ? 'book'
      : 'flat';
  return {
    count: activeFeatures.length,
    reason: `${layout.mode}-${posture}`,
  };
};

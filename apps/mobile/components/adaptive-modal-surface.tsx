import React from 'react';
import { View, type ViewProps, type ViewStyle } from 'react-native';

import { useAdaptiveWindow } from '@/components/adaptive-window-context';
import type { AdaptiveWindowFrame, AdaptiveWindowLayout } from '@/lib/adaptive-window';

export type AdaptiveModalSurfaceVariant = 'editor' | 'sheet';

const variantMaximumWidth: Record<AdaptiveModalSurfaceVariant, number> = {
  editor: 860,
  sheet: 680,
};

export const resolveAdaptiveModalSurfaceStyle = (
  adaptiveWindow: AdaptiveWindowLayout,
  variant: AdaptiveModalSurfaceVariant,
): ViewStyle | null => {
  if (!adaptiveWindow.isExpanded && !adaptiveWindow.activeFeature) return null;

  const frame: AdaptiveWindowFrame = variant === 'sheet'
    ? adaptiveWindow.navigationActionFrame
    : adaptiveWindow.foregroundFrame;
  const horizontalInset = variant === 'sheet' ? 12 : 0;
  const width = Math.min(
    Math.max(0, frame.width - horizontalInset * 2),
    variantMaximumWidth[variant],
  );
  const centeredLeft = frame.x + Math.max(horizontalInset, (frame.width - width) / 2);
  const expandedSheetPreferredLeft = adaptiveWindow.navigationPlacement === 'left'
    ? frame.x + adaptiveWindow.navigationWidth + horizontalInset
    : frame.x + frame.width - adaptiveWindow.navigationWidth - horizontalInset - width;
  const maximumInsetLeft = Math.max(
    frame.x + horizontalInset,
    frame.x + frame.width - width - horizontalInset,
  );
  const left = variant === 'sheet' && adaptiveWindow.isExpanded
    ? Math.max(frame.x + horizontalInset, Math.min(maximumInsetLeft, expandedSheetPreferredLeft))
    : centeredLeft;

  if (variant === 'sheet') {
    return {
      alignSelf: 'flex-start',
      marginLeft: left,
      marginBottom: Math.max(0, adaptiveWindow.height - (frame.y + frame.height)),
      maxHeight: frame.height,
      width,
    };
  }

  return {
    position: 'absolute',
    left,
    top: frame.y,
    width,
    height: frame.height,
  };
};

export function AdaptiveModalSurface({
  variant,
  style,
  ...props
}: ViewProps & { variant: AdaptiveModalSurfaceVariant }) {
  const adaptiveWindow = useAdaptiveWindow();
  const adaptiveStyle = React.useMemo(
    () => resolveAdaptiveModalSurfaceStyle(adaptiveWindow, variant),
    [adaptiveWindow, variant],
  );

  return <View {...props} style={[style, adaptiveStyle]} />;
}

import React from 'react';
import { I18nManager, Platform, useWindowDimensions } from 'react-native';

import {
  resolveAdaptiveWindow,
  type AdaptiveWindowLayout,
} from '@/lib/adaptive-window';

const AdaptiveWindowContext = React.createContext<AdaptiveWindowLayout | undefined>(undefined);

export function AdaptiveWindowContextProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: AdaptiveWindowLayout;
}) {
  return (
    <AdaptiveWindowContext.Provider value={value}>
      {children}
    </AdaptiveWindowContext.Provider>
  );
}

/** Dimension-only safety fallback for consumers rendered without the app's root provider. */
export function useAdaptiveWindow(): AdaptiveWindowLayout {
  const context = React.useContext(AdaptiveWindowContext);
  const dimensions = useWindowDimensions();
  const fallback = React.useMemo(() => resolveAdaptiveWindow({
    width: dimensions.width,
    height: dimensions.height,
    fontScale: dimensions.fontScale,
    isRtl: I18nManager.isRTL,
    platform: Platform.OS === 'android' ? 'android' : 'other',
  }), [
    dimensions.fontScale,
    dimensions.height,
    dimensions.width,
  ]);
  return context ?? fallback;
}

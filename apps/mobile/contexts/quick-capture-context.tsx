import React, { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Task } from '@mindwtr/core';

export type QuickCaptureOptions = {
  initialProps?: Partial<Task>;
  initialValue?: string;
  autoRecord?: boolean;
  returnTo?: string;
};

type QuickCaptureContextValue = {
  openQuickCapture: (options?: QuickCaptureOptions) => void;
};

const QuickCaptureContext = createContext<QuickCaptureContextValue | null>(null);

export function QuickCaptureProvider({ value, children }: { value: QuickCaptureContextValue; children: ReactNode }) {
  const contextValue = useMemo(() => ({ openQuickCapture: value.openQuickCapture }), [value.openQuickCapture]);
  return (
    <QuickCaptureContext.Provider value={contextValue}>
      {children}
    </QuickCaptureContext.Provider>
  );
}

export function useQuickCapture(): QuickCaptureContextValue {
  const ctx = useContext(QuickCaptureContext);
  if (!ctx) {
    throw new Error('useQuickCapture must be used within QuickCaptureProvider');
  }
  return ctx;
}

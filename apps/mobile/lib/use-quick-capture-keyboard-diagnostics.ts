import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { Dimensions, Keyboard, Platform, type KeyboardEvent, type TextInput } from 'react-native';
import { isLoggingEnabled, logInfo } from './app-log';

const captureRun = Date.now();
let nextCaptureAttempt = 0;
const MAX_LINES = 40;
const SETTLE_MS = 450;
type Phase = 'open' | 'modal-shown' | 'auto-focus-request' | 'input-focus' | 'input-blur'
  | 'ime-show' | 'ime-change' | 'ime-hide' | 'inset-applied' | 'settled' | 'close';
type Attempt = { number: number; started: number; lines: number; timer?: ReturnType<typeof setTimeout>; measurement: number };
type Options = {
  visible: boolean;
  openRequestId?: number;
  inputRef: RefObject<TextInput | null>;
  appliedInset: number;
  avoidanceEnabled: boolean;
  expanded: boolean;
  autoRecord: boolean;
};
const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
const loggingEnabled = () => {
  try { return isLoggingEnabled(); } catch { return false; }
};

/** Observe the existing focus/inset path without changing keyboard behavior. */
export function useQuickCaptureKeyboardDiagnostics(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const attemptRef = useRef<Attempt | null>(null);
  const emit = useCallback((attempt: Attempt, phase: Phase, extra: Record<string, unknown> = {}) => {
    if (attemptRef.current !== attempt || !loggingEnabled()
      || attempt.lines >= (phase === 'close' ? MAX_LINES : MAX_LINES - 1)) return;
    attempt.lines += 1;
    try {
      const state = latest.current;
      const input = state.inputRef.current;
      const window = Dimensions.get('window');
      const screen = Dimensions.get('screen');
      const metrics = typeof Keyboard.metrics === 'function' ? Keyboard.metrics() : undefined;
      void logInfo('Quick capture IME phase', { scope: 'quick-capture', extra: {
        releaseCheck: 'v1.3.5/quick-capture-ime', captureRun, captureAttempt: attempt.number,
        phase, elapsedMs: Math.max(0, Date.now() - attempt.started),
        appliedInset: numeric(state.appliedInset), avoidanceEnabled: state.avoidanceEnabled,
        expanded: state.expanded, autoRecord: state.autoRecord,
        inputMounted: Boolean(input), focusTracked: input?.isFocused?.() ?? false,
        windowWidth: numeric(window.width), windowHeight: numeric(window.height),
        screenWidth: numeric(screen.width), screenHeight: numeric(screen.height),
        imeVisible: typeof Keyboard.isVisible === 'function' ? Keyboard.isVisible() : null,
        imeMetricsY: numeric(metrics?.screenY), imeMetricsHeight: numeric(metrics?.height),
        imeMetricsX: numeric(metrics?.screenX), imeMetricsWidth: numeric(metrics?.width),
        ...extra,
      } }).catch(() => undefined);
    } catch {
      // Optional diagnostics must never interrupt the focus request.
    }
  }, []);
  const settle = useCallback((attempt: Attempt) => {
    if (attemptRef.current !== attempt || !loggingEnabled() || attempt.lines >= MAX_LINES - 1) return;
    if (attempt.timer !== undefined) clearTimeout(attempt.timer);
    const measurement = ++attempt.measurement;
    attempt.timer = setTimeout(() => {
      attempt.timer = undefined;
      if (attemptRef.current !== attempt || !loggingEnabled()) return;
      // Baseline survives a missing native measurement callback.
      emit(attempt, 'settled', { outcome: 'baseline' });
      try {
        latest.current.inputRef.current?.measureInWindow?.((x, y, width, height) => {
          if (attempt.measurement !== measurement) return;
          emit(attempt, 'settled', {
            outcome: 'measured', inputX: numeric(x), inputY: numeric(y),
            inputWidth: numeric(width), inputHeight: numeric(height), inputBottom: numeric(y + height),
          });
        });
      } catch {
        // The baseline still records settlement if native measurement is unavailable.
      }
    }, SETTLE_MS);
  }, [emit]);

  useLayoutEffect(() => {
    if (Platform.OS !== 'android' || !options.visible || !loggingEnabled()) return;
    const attempt: Attempt = { number: ++nextCaptureAttempt, started: Date.now(), lines: 0, measurement: 0 };
    attemptRef.current = attempt;
    emit(attempt, 'open');
    settle(attempt);
    const subscriptions: { remove: () => void }[] = [];
    for (const [eventName, phase] of [
      ['keyboardDidShow', 'ime-show'], ['keyboardDidChangeFrame', 'ime-change'], ['keyboardDidHide', 'ime-hide'],
    ]) {
      try {
        if (typeof Keyboard.addListener !== 'function') break;
        subscriptions.push(Keyboard.addListener(eventName as 'keyboardDidShow', (event: KeyboardEvent) => {
          const frame = event?.endCoordinates;
          emit(attempt, phase as Phase, {
            imeEventY: numeric(frame?.screenY), imeEventHeight: numeric(frame?.height),
            imeEventX: numeric(frame?.screenX), imeEventWidth: numeric(frame?.width),
          });
          settle(attempt);
        }));
      } catch {
        // A missing native event capability must not prevent opening the sheet.
      }
    }
    return () => {
      emit(attempt, 'close');
      attemptRef.current = null;
      if (attempt.timer !== undefined) clearTimeout(attempt.timer);
      subscriptions.forEach((subscription) => {
        try { subscription.remove(); } catch { /* Continue releasing the remaining listeners. */ }
      });
    };
  }, [options.visible, options.openRequestId, emit, settle]);

  useEffect(() => {
    const attempt = attemptRef.current;
    if (!attempt) return;
    emit(attempt, 'inset-applied');
    settle(attempt);
  }, [options.appliedInset, options.avoidanceEnabled, options.expanded, emit, settle]);

  const observe = useCallback((phase: Phase, extra: Record<string, unknown> = {}) => {
    if (!options.visible || !latest.current.visible || latest.current.openRequestId !== options.openRequestId) return;
    const attempt = attemptRef.current;
    if (!attempt) return;
    emit(attempt, phase, extra);
    settle(attempt);
  }, [options.visible, options.openRequestId, emit, settle]);
  return {
    onModalShow: useCallback(() => observe('modal-shown'), [observe]),
    onAutoFocusRequest: useCallback((afterModalShow = false) => observe('auto-focus-request', afterModalShow
      ? { releaseCheck: 'v1.3.7/quick-capture-focus-after-show' } : {}), [observe]),
    onInputFocus: useCallback(() => observe('input-focus'), [observe]),
    onInputBlur: useCallback(() => observe('input-blur'), [observe]),
  };
}

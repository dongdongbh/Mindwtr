import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { Keyboard, Platform, type TextInput } from 'react-native';

export type AndroidQuickCaptureExpandPhase = 'idle' | 'hiding' | 'expanded';

type KeyboardSubscription = { remove: () => void };

type UseAndroidQuickCaptureExpandParams = {
  clearInitialFocusTimer: () => void;
  fallbackMs: number;
  inputRef: RefObject<TextInput | null>;
  setKeyboardAvoidingEnabled: Dispatch<SetStateAction<boolean>>;
  setOptionsExpanded: Dispatch<SetStateAction<boolean>>;
};

export function useAndroidQuickCaptureExpand({
  clearInitialFocusTimer,
  fallbackMs,
  inputRef,
  setKeyboardAvoidingEnabled,
  setOptionsExpanded,
}: UseAndroidQuickCaptureExpandParams) {
  const [phase, setPhase] = useState<AndroidQuickCaptureExpandPhase>('idle');
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardHideSubRef = useRef<KeyboardSubscription | null>(null);
  const keyboardShowSubRef = useRef<KeyboardSubscription | null>(null);

  const clearAndroidOptionsExpand = useCallback(() => {
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    if (keyboardHideSubRef.current) {
      keyboardHideSubRef.current.remove();
      keyboardHideSubRef.current = null;
    }
    if (keyboardShowSubRef.current) {
      keyboardShowSubRef.current.remove();
      keyboardShowSubRef.current = null;
    }
    setPhase('idle');
  }, []);

  const expandAfterKeyboardHidden = useCallback(() => {
    clearAndroidOptionsExpand();
    setKeyboardAvoidingEnabled(false);
    setOptionsExpanded(true);
    setPhase('expanded');
    if (Platform.OS === 'android') {
      keyboardShowSubRef.current = Keyboard.addListener('keyboardDidShow', () => {
        setKeyboardAvoidingEnabled(true);
      });
    }
  }, [clearAndroidOptionsExpand, setKeyboardAvoidingEnabled, setOptionsExpanded]);

  const requestAndroidOptionsExpand = useCallback(() => {
    clearAndroidOptionsExpand();
    clearInitialFocusTimer();

    const keyboardWasVisible = Keyboard.isVisible();
    inputRef.current?.blur();
    Keyboard.dismiss();

    if (!keyboardWasVisible) {
      expandAfterKeyboardHidden();
      return;
    }

    setPhase('hiding');
    keyboardHideSubRef.current = Keyboard.addListener('keyboardDidHide', expandAfterKeyboardHidden);

    fallbackTimerRef.current = setTimeout(expandAfterKeyboardHidden, fallbackMs);
  }, [clearAndroidOptionsExpand, clearInitialFocusTimer, expandAfterKeyboardHidden, fallbackMs, inputRef]);

  const collapseAndroidOptions = useCallback(() => {
    clearAndroidOptionsExpand();
    setKeyboardAvoidingEnabled(true);
    setOptionsExpanded(false);
  }, [clearAndroidOptionsExpand, setKeyboardAvoidingEnabled, setOptionsExpanded]);

  useEffect(() => clearAndroidOptionsExpand, [clearAndroidOptionsExpand]);

  return {
    androidOptionsExpandPhase: Platform.OS === 'android' ? phase : 'idle',
    clearAndroidOptionsExpand,
    collapseAndroidOptions,
    requestAndroidOptionsExpand,
  };
}

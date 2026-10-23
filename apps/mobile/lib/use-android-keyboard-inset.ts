import { useEffect, useState, type RefObject } from 'react';
import { Dimensions, Keyboard, Platform, type TextInput } from 'react-native';

import { getAndroidKeyboardFrame } from './android-keyboard-frame';
import { measureAndroidModalKeyboardInset } from './android-modal-keyboard';
import { logInfo } from './app-log';

/**
 * Track the on-screen Android keyboard inset (its height in px) while `active`.
 *
 * Transparent React Native modals run in their own Android window that does not
 * resize for the soft keyboard, so any sheet or popup that floats content above
 * the keyboard has to measure the inset itself and lift its content by that
 * amount. Returns 0 on iOS (where KeyboardAvoidingView / automatic insets handle
 * it) and whenever the keyboard is closed, so callers can apply the value as
 * `paddingBottom` unconditionally.
 */
/**
 * Cross-platform keyboard inset for overlays that render OUTSIDE a
 * KeyboardAvoidingView — absolute-fill picker layers in transparent modals sit
 * under the keyboard on iOS exactly like they do on Android, because nothing
 * above them resizes (#891). iOS listens to the keyboardWill* events so the
 * padding lands together with the keyboard animation, and derives the inset
 * from the keyboard frame's top edge (`screenY`), which correctly reads 0 when
 * a frame-change slides the keyboard offscreen. Android keeps the existing
 * keyboardDid* + defensive frame math (will* events never fire there).
 */
export function useKeyboardInset(active = true): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (!active) {
      setInset(0);
      return;
    }
    if (typeof Keyboard?.addListener !== 'function') return;
    const applyFrame = (event: { endCoordinates?: { screenY?: number; height?: number } }) => {
      if (Platform.OS === 'android') {
        setInset(getAndroidKeyboardFrame(event).inset);
        return;
      }
      const screenY = event.endCoordinates?.screenY;
      if (typeof screenY === 'number') {
        setInset(Math.max(0, Dimensions.get('window').height - screenY));
        return;
      }
      setInset(Math.max(0, event.endCoordinates?.height ?? 0));
    };
    const reset = () => setInset(0);
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const changeEvent = Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidChangeFrame';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const subscriptions = [
      Keyboard.addListener(showEvent, applyFrame),
      Keyboard.addListener(changeEvent, applyFrame),
      Keyboard.addListener(hideEvent, reset),
    ];
    return () => {
      subscriptions.forEach((subscription) => subscription.remove());
    };
  }, [active]);

  return inset;
}

export function useAndroidKeyboardInset(active = true, inputRef?: RefObject<TextInput | null>): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!active) {
      setInset(0);
      return;
    }
    if (typeof Keyboard?.addListener !== 'function') return;
    let revision = 0;
    let timers: ReturnType<typeof setTimeout>[] = [];
    const cancelMeasurements = () => {
      revision += 1;
      timers.forEach(clearTimeout);
      timers = [];
    };
    const applyFrame = (event: { endCoordinates?: { screenY?: number; height?: number } }) => {
      cancelMeasurements();
      const eventInset = getAndroidKeyboardFrame(event).inset;
      setInset(eventInset);
      if (!inputRef) return;
      const currentRevision = revision;
      let lastAppliedSample = -1;
      // The activity event can precede the dialog's IME animation; re-read that
      // dialog's insets through settlement instead of inventing a keyboard height.
      const delays = [0, 80, 240, 480];
      timers = delays.map((delay, sample) => setTimeout(() => {
        const input = inputRef.current;
        if (!input) return;
        void measureAndroidModalKeyboardInset(input).then((nativeInset) => {
          if (revision !== currentRevision || inputRef.current !== input || nativeInset === null
            || sample < lastAppliedSample) return;
          lastAppliedSample = sample;
          setInset(nativeInset);
          if (sample === delays.length - 1) {
            void logInfo('Quick capture modal IME inset measured', { scope: 'quick-capture', force: true, extra: {
              releaseCheck: 'v1.3.8/quick-capture-modal-ime', eventInset, nativeInset, outcome: 'measured',
            } }).catch(() => undefined);
          }
        });
      }, delay));
    };
    const reset = () => {
      cancelMeasurements();
      setInset(0);
    };
    const showSub = Keyboard.addListener('keyboardDidShow', applyFrame);
    const changeSub = Keyboard.addListener('keyboardDidChangeFrame', applyFrame);
    const hideSub = Keyboard.addListener('keyboardDidHide', reset);
    return () => {
      cancelMeasurements();
      showSub.remove();
      changeSub.remove();
      hideSub.remove();
    };
  }, [active, inputRef]);

  return inset;
}

import { useEffect, useState, type RefObject } from 'react';
import { Dimensions, Keyboard, Platform, type TextInput } from 'react-native';

import { getAndroidKeyboardFrame } from './android-keyboard-frame';
import { measureAndroidModalKeyboardInset } from './android-modal-keyboard';
import { logInfo } from './app-log';


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
    let measurementRevision = 0;
    let measurementTimers: ReturnType<typeof setTimeout>[] = [];
    const cancelMeasurements = () => {
      measurementRevision += 1;
      measurementTimers.forEach(clearTimeout);
      measurementTimers = [];
    };
    const applyFrame = (event: { endCoordinates?: { screenY?: number; height?: number } }) => {
      cancelMeasurements();
      const eventInset = getAndroidKeyboardFrame(event).inset;
      setInset(eventInset);
      if (!inputRef) return;
      const frameMeasurementRevision = measurementRevision;
      let lastAppliedSampleIndex = -1;


      const modalImeSettlementDelaysMs = [0, 80, 240, 480];
      measurementTimers = modalImeSettlementDelaysMs.map((delayMs, sampleIndex) => setTimeout(() => {
        const input = inputRef.current;
        if (!input) return;
        void measureAndroidModalKeyboardInset(input).then((nativeInset) => {
          if (measurementRevision !== frameMeasurementRevision || inputRef.current !== input || nativeInset === null
            || sampleIndex < lastAppliedSampleIndex) return;
          lastAppliedSampleIndex = sampleIndex;
          setInset(nativeInset);
          if (sampleIndex === modalImeSettlementDelaysMs.length - 1) {
            void logInfo('Quick capture modal IME inset measured', { scope: 'quick-capture', force: true, extra: {
              releaseCheck: 'v1.3.8/quick-capture-modal-ime', eventInset, nativeInset, outcome: 'measured',
            } }).catch(() => undefined);
          }
        });
      }, delayMs));
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

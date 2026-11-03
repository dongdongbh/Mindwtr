import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Dimensions, Keyboard, type ScrollView, type TextInput } from 'react-native';


const CLEARANCE_RATIO = 0.18;

const MIN_CLEARANCE = 56;
const NO_SPACE = { inset: 0, padding: 0 };


export function usePreviewChecklistKeyboard(
  scrollRef: RefObject<ScrollView | null>,
  inputRef: RefObject<TextInput | null>,
) {
  const [space, setSpace] = useState(NO_SPACE);
  const spaceRef = useRef(NO_SPACE);
  const offsetRef = useRef(0);
  const keyboardTopRef = useRef<number | null>(null);
  const focusedRef = useRef(false);
  const generationRef = useRef(0);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const cancelPending = useCallback(() => {
    generationRef.current += 1;
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  const revealInput = useCallback(() => {
    const scroll = scrollRef.current;
    const input = inputRef.current;
    const keyboardTop = keyboardTopRef.current;
    if (!focusedRef.current || keyboardTop == null || !scroll || !input) return;
    const generation = generationRef.current;
    const isCurrent = () => focusedRef.current && generation === generationRef.current;
    scroll.getNativeScrollRef()?.measureInWindow((_x, scrollY, _width, scrollHeight) => {
      if (!isCurrent() || !Number.isFinite(scrollY) || !Number.isFinite(scrollHeight)) return;


      const inset = Math.max(0, scrollY + scrollHeight - keyboardTop);
      const visibleBottom = Math.min(scrollY + scrollHeight, keyboardTop);
      const visibleHeight = Math.max(0, visibleBottom - scrollY);
      if (!visibleHeight) return;
      const clearance = Math.max(visibleHeight * CLEARANCE_RATIO, MIN_CLEARANCE);


      const padding = inset + clearance;
      if (spaceRef.current.inset !== inset || spaceRef.current.padding !== padding) {
        spaceRef.current = { inset, padding };
        setSpace(spaceRef.current);
        return;
      }
      input.measureInWindow((_ix, inputY, _iw, inputHeight) => {
        if (!isCurrent() || !Number.isFinite(inputY) || !Number.isFinite(inputHeight)) return;
        const overlap = inputY + inputHeight + clearance - visibleBottom;
        const delta = overlap > 0 ? overlap : Math.min(0, inputY - scrollY);
        if (!delta) return;
        const y = Math.max(0, offsetRef.current + delta);
        offsetRef.current = y;
        scroll.scrollTo({ y, animated: false });
      });
    });
  }, [inputRef, scrollRef]);

  const scheduleReveal = useCallback(() => {
    cancelPending();
    if (!focusedRef.current) return;


    timersRef.current = [0, 180, 360].map((delay) => setTimeout(revealInput, delay));
  }, [cancelPending, revealInput]);

  const clearInset = useCallback(() => {
    cancelPending();
    spaceRef.current = NO_SPACE;
    setSpace(NO_SPACE);
  }, [cancelPending]);

  useEffect(() => {
    const updateFrame = (event: { endCoordinates?: { screenY?: number; height?: number } }) => {
      const coordinates = event.endCoordinates;
      const screenHeight = Dimensions.get('screen').height;
      const top = coordinates?.screenY ?? (screenHeight - (coordinates?.height ?? 0));
      if (!Number.isFinite(top) || top >= screenHeight) {
        keyboardTopRef.current = null;
        clearInset();
        return;
      }


      if (focusedRef.current && keyboardTopRef.current != null && top > keyboardTopRef.current) return;
      keyboardTopRef.current = top;
      scheduleReveal();
    };
    const hide = () => {
      keyboardTopRef.current = null;
      clearInset();
    };
    const subscriptions = [


      Keyboard.addListener('keyboardWillShow', updateFrame),
      Keyboard.addListener('keyboardDidShow', updateFrame),
      Keyboard.addListener('keyboardWillChangeFrame', updateFrame),
      Keyboard.addListener('keyboardDidChangeFrame', updateFrame),
      Keyboard.addListener('keyboardDidHide', hide),
    ];
    return () => {
      focusedRef.current = false;
      cancelPending();
      subscriptions.forEach((subscription) => subscription.remove());
    };
  }, [cancelPending, clearInset, scheduleReveal]);

  useEffect(scheduleReveal, [space, scheduleReveal]);

  return {
    bottomInset: space.inset,

    contentBottomPadding: space.padding,
    onFocus: () => {
      focusedRef.current = true;
      scheduleReveal();
    },
    onBlur: () => {
      focusedRef.current = false;
      clearInset();
    },
    onLayout: scheduleReveal,
    onScroll: (event: { nativeEvent: { contentOffset: { y: number } } }) => {
      offsetRef.current = event.nativeEvent.contentOffset.y;
    },
  };
}

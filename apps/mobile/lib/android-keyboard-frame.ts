import { Dimensions } from 'react-native';


export function getAndroidKeyboardFrame(event: {
  endCoordinates?: { screenY?: number; height?: number };
}) {
  const windowHeight = Dimensions.get('window').height;
  const screenHeight = Dimensions.get('screen').height;
  const endCoords = event.endCoordinates;
  const eventScreenY = typeof endCoords?.screenY === 'number' ? endCoords.screenY : undefined;
  const eventHeight = typeof endCoords?.height === 'number' ? endCoords.height : undefined;
  const keyboardTop = eventScreenY ?? (typeof eventHeight === 'number' ? Math.max(0, screenHeight - eventHeight) : windowHeight);
  const screenInset = typeof eventScreenY === 'number' ? Math.max(0, screenHeight - eventScreenY) : 0;
  const windowInset = typeof eventScreenY === 'number' ? Math.max(0, windowHeight - eventScreenY) : 0;
  const heightInset = typeof eventHeight === 'number' ? Math.max(0, eventHeight) : 0;
  const inset = Math.max(screenInset, windowInset, heightInset);

  return {
    keyboardTop,
    inset,
    visible: inset > 0 || keyboardTop < windowHeight,
  };
}

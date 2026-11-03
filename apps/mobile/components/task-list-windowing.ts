import { Platform } from 'react-native';


export const TASK_LIST_WINDOWING_PROPS = {
  initialNumToRender: 12,
  maxToRenderPerBatch: 12,
  windowSize: 5,
  updateCellsBatchingPeriod: 50,
  removeClippedSubviews: false,
} as const;

const REMOVE_CLIPPED_SUBVIEWS_MIN_ITEMS = 15;


export function shouldRemoveClippedSubviews(itemCount: number): boolean {
  return Platform.OS === 'android' && itemCount >= REMOVE_CLIPPED_SUBVIEWS_MIN_ITEMS;
}

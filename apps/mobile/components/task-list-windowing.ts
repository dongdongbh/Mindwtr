import { Platform } from 'react-native';

/**
 * One home for the FlatList windowing numbers every task list is tuned with.
 *
 * These are #766 perf tuning, not defaults: they were arrived at on low-end
 * Android hardware and had been copy-pasted verbatim into nine list sites, so
 * re-tuning meant finding and editing all nine. Spread this instead, and
 * override individual props where a list genuinely differs (the project reorder
 * list renders a wider window because dragging scrolls past the visible rows;
 * the main task list clips subviews once it is long enough to pay for it).
 *
 * Changing a number here changes scroll behaviour on device — verify against
 * `docs/performance/budgets.md`, not a unit test: react-test-renderer has no
 * layout engine and will happily agree with any value.
 */
export const TASK_LIST_WINDOWING_PROPS = {
  initialNumToRender: 12,
  maxToRenderPerBatch: 12,
  windowSize: 5,
  updateCellsBatchingPeriod: 50,
  removeClippedSubviews: false,
} as const;

const REMOVE_CLIPPED_SUBVIEWS_MIN_ITEMS = 15;

/**
 * The only sanctioned way to turn clipping on for a list.
 *
 * iOS never clips. Fabric's RCTViewComponentView moves clipped children out of
 * the native view tree into its own array, and when the prop flips back to
 * false it never puts them back — so the native subviews are short of the
 * shadow tree, and the next mount transaction unmounts a child at an index
 * that no longer exists and aborts the app. A list whose length crosses the
 * threshold (filter a long Done list down to a few rows) flips the prop and
 * hits exactly that: duplicated rows first, then a crash (#949, #969).
 * Android's ReactViewGroup re-attaches clipped children on the way back, so it
 * keeps the #766 scroll win.
 */
export function shouldRemoveClippedSubviews(itemCount: number): boolean {
  return Platform.OS === 'android' && itemCount >= REMOVE_CLIPPED_SUBVIEWS_MIN_ITEMS;
}

const DEFAULT_WIDGET_HEIGHT_DP = 180;
const EXTRA_ITEM_HEIGHT_STEP_DP = 70;
const MIN_VISIBLE_WIDGET_ITEMS = 3;
const ANDROID_WIDGET_CHROME_HEIGHT_DP = 110;
const ANDROID_COMPACT_WIDGET_CHROME_HEIGHT_DP = 118;
const ANDROID_FIRST_ITEM_HEIGHT_DP = 24;
const ANDROID_ADDITIONAL_ITEM_HEIGHT_DP = 20;
const ANDROID_MIN_VISIBLE_WIDGET_ITEMS = 4;
const ANDROID_COMPACT_MIN_VISIBLE_WIDGET_ITEMS = 3;
const ANDROID_COMPACT_SHORT_WIDGET_MIN_VISIBLE_ITEMS = 2;
const ANDROID_COMPACT_WIDGET_MAX_WIDTH_DP = 200;
const MAX_VISIBLE_WIDGET_ITEMS = 8;

const toFiniteNumber = (value: unknown): number => {
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
};

export const getAdaptiveWidgetTaskLimit = (widgetHeightDp: number): number => {
    const height = toFiniteNumber(widgetHeightDp);
    if (height <= 0) return MIN_VISIBLE_WIDGET_ITEMS;

    const extra = Math.floor(Math.max(0, height - DEFAULT_WIDGET_HEIGHT_DP) / EXTRA_ITEM_HEIGHT_STEP_DP);
    const next = MIN_VISIBLE_WIDGET_ITEMS + extra;
    return Math.max(MIN_VISIBLE_WIDGET_ITEMS, Math.min(MAX_VISIBLE_WIDGET_ITEMS, next));
};

export type AndroidWidgetLayoutMode = 'compact' | 'standard';

export const getAndroidWidgetLayoutMode = (widgetWidthDp: number): AndroidWidgetLayoutMode => {
    const width = toFiniteNumber(widgetWidthDp);
    if (width > 0 && width <= ANDROID_COMPACT_WIDGET_MAX_WIDTH_DP) {
        return 'compact';
    }
    return 'standard';
};

export const getAdaptiveAndroidWidgetTaskLimit = (widgetHeightDp: number, widgetWidthDp?: number): number => {
    const height = toFiniteNumber(widgetHeightDp);
    const layoutMode = getAndroidWidgetLayoutMode(widgetWidthDp ?? 0);
    const chromeHeight = layoutMode === 'compact'
        ? ANDROID_COMPACT_WIDGET_CHROME_HEIGHT_DP
        : ANDROID_WIDGET_CHROME_HEIGHT_DP;
    const minVisible = layoutMode === 'compact'
        ? (height > 0 && height < DEFAULT_WIDGET_HEIGHT_DP
            ? ANDROID_COMPACT_SHORT_WIDGET_MIN_VISIBLE_ITEMS
            : ANDROID_COMPACT_MIN_VISIBLE_WIDGET_ITEMS)
        : ANDROID_MIN_VISIBLE_WIDGET_ITEMS;

    if (height <= 0) return minVisible;

    const available = Math.max(0, height - chromeHeight);
    if (available <= 0) return minVisible;

    let visibleItems = 0;
    let remainingHeight = available;
    if (remainingHeight >= ANDROID_FIRST_ITEM_HEIGHT_DP) {
        visibleItems += 1;
        remainingHeight -= ANDROID_FIRST_ITEM_HEIGHT_DP;
    }
    if (remainingHeight > 0) {
        visibleItems += Math.floor(remainingHeight / ANDROID_ADDITIONAL_ITEM_HEIGHT_DP);
    }

    return Math.max(
        minVisible,
        Math.min(MAX_VISIBLE_WIDGET_ITEMS, visibleItems),
    );
};

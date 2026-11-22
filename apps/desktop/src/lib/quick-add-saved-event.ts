import type { LinkTitleCapture } from './link-title';

export const QUICK_ADD_MAIN_WINDOW_LABEL = 'main';
export const QUICK_ADD_SAVED_EVENT = 'quick-add-saved';

export type QuickAddSavedEvent = { savedAt: string; linkCapture?: LinkTitleCapture };

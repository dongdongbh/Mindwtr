import { invokeNative } from './tauri-invoke';

export const QUICK_ADD_WINDOW_PARAM = 'quickAddWindow';

export function isQuickAddWindowLocation(location: Pick<Location, 'search'> = window.location): boolean {
    const params = new URLSearchParams(location.search);
    const value = params.get(QUICK_ADD_WINDOW_PARAM);
    return value === '1' || value?.toLowerCase() === 'true';
}


export const consumeQuickAddPending = (target: string): Promise<boolean> => (
    invokeNative<boolean>('consume_quick_add_pending', { target })
);


export const hideQuickAddWindow = (): Promise<void> => invokeNative<void>('hide_quick_add_window');

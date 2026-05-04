export const QUICK_ADD_WINDOW_PARAM = 'quickAddWindow';

export function isQuickAddWindowLocation(location: Pick<Location, 'search'> = window.location): boolean {
    const params = new URLSearchParams(location.search);
    const value = params.get(QUICK_ADD_WINDOW_PARAM);
    return value === '1' || value?.toLowerCase() === 'true';
}

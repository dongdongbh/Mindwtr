import { format } from 'date-fns';


export const CALENDAR_VIEW_PARAM = 'calendarView';
export const CALENDAR_DATE_PARAM = 'calendarDate';
export const CALENDAR_MONTH_PARAM = 'calendarMonth';


export function stageCalendarDropLanding(now: Date = new Date()): void {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const currentView = url.searchParams.get(CALENDAR_VIEW_PARAM);
    const landingView = currentView === 'schedule' ? 'week' : currentView;

    if (landingView) {
        url.searchParams.set(CALENDAR_VIEW_PARAM, landingView);
    }
    url.searchParams.set(CALENDAR_MONTH_PARAM, format(now, 'yyyy-MM'));


    if (landingView && landingView !== 'month') {
        url.searchParams.set(CALENDAR_DATE_PARAM, format(now, 'yyyy-MM-dd'));
    } else {
        url.searchParams.delete(CALENDAR_DATE_PARAM);
    }
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

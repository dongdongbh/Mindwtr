export type AppAnnouncementAction =
    | {
        type: 'url';
        label: string;
        url: string;
    }
    | {
        type: 'feedback';
        label: string;
    };

export type AppAnnouncement = {
    id: string;
    title: string;
    body: string;
    dismissLabel?: string;
    action?: AppAnnouncementAction;
};

export const APP_ANNOUNCEMENT_DISMISSED_VALUE = 'dismissed';

export const DONATION_PROMPT_ANNOUNCEMENT: AppAnnouncement = {
    id: 'support-mindwtr-one-time-v1',
    title: 'Keep Mindwtr free and independent',
    body: 'Mindwtr has no ads, tracking, or paywalls. It is built by one person and supported by people who find it useful. If it helps you stay clear, a small donation helps keep it improving.',
    dismissLabel: 'Maybe later',
    action: {
        type: 'url',
        label: 'Support Mindwtr',
        url: 'https://mindwtr.app/donate?src=app_prompt',
    },
};


export const ACTIVE_APP_ANNOUNCEMENT: AppAnnouncement | null = null;

export function getAnnouncementDismissalStorageKey(id: string): string {
    return `mindwtr:announcement-dismissed:${id.trim()}`;
}

export function shouldShowAppAnnouncement(
    announcement: AppAnnouncement | null | undefined,
    dismissedValue: string | null | undefined,
): announcement is AppAnnouncement {
    if (!announcement) return false;
    if (!announcement.id.trim() || !announcement.title.trim() || !announcement.body.trim()) return false;
    return dismissedValue !== APP_ANNOUNCEMENT_DISMISSED_VALUE;
}

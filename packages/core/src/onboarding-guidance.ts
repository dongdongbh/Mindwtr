
import { getDocsGuideUrl, type DocsSection } from './docs-guidance';

export type OnboardingTopic = 'inbox-project' | 'focus' | 'scheduling' | 'details';

export const ONBOARDING_TOPIC_COPY = {
    'inbox-project': { title: 'inbox.title', body: 'inbox.projectHint' },
    focus: { title: 'agenda.title', body: 'onboarding.focusHint' },
    scheduling: { title: 'taskEdit.scheduling', body: 'onboarding.schedulingHint' },
    details: { title: 'taskEdit.details', body: 'onboarding.detailsHint' },
} as const;


export function getOnboardingGuideUrl(topic: OnboardingTopic, platform: 'desktop' | 'mobile', language?: string): string {
    const sections: Record<OnboardingTopic, DocsSection> = platform === 'mobile'
        ? { 'inbox-project': 'mobile-inbox', focus: 'mobile-focus', scheduling: 'mobile-scheduling', details: 'mobile-details' }
        : { 'inbox-project': 'desktop-inbox', focus: 'desktop-focus', scheduling: 'desktop-scheduling', details: 'desktop-details' };
    return getDocsGuideUrl(`use/${platform}`, language, sections[topic]);
}

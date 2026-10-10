import { describe, expect, it } from 'vitest';

import { buildFeedbackSubmissionPayload } from './feedback';
import { FEEDBACK_MESSAGE_MAX_LENGTH, getFeedbackMessageMaxLength, getFeedbackDraftState, planFeedbackSubmit, resolveAndroidInstallerSource } from './about-settings-model';
import { getTranslator, resolveI18nText } from './i18n';

const t = getTranslator('en');
const tr = (key: string) => resolveI18nText(t, key, {});
const draft = { category: 'bug' as const, message: 'Hi', email: '', location: '' as const, includeDiagnostics: false };

describe('the feedback modal\'s rules', () => {
    it('refuses an email longer than the endpoint accepts in the modal, not after Send', () => {
        const email = `${'a'.repeat(250)}@example.com`;
        expect(getFeedbackDraftState({ tr, isConfigured: true, message: 'Hi', email, status: 'idle', error: null }))
            .toMatchObject({ canSubmit: false, visibleError: tr('settings.feedbackInvalidEmail') });
        expect(planFeedbackSubmit({ ...draft, email }, tr)).toEqual({ error: tr('settings.feedbackInvalidEmail') });
    });

    it('keeps a bug\'s place inside the endpoint\'s 4,000 characters', () => {
        const where = { ...draft, location: 'sync' as const };
        const room = getFeedbackMessageMaxLength(where, tr);
        expect(room).toBe(FEEDBACK_MESSAGE_MAX_LENGTH - `${tr('settings.feedbackWhereMessagePrefix')}: ${tr('settings.feedbackWhereSync')}\n\n`.length);
        expect(getFeedbackMessageMaxLength(draft, tr)).toBe(FEEDBACK_MESSAGE_MAX_LENGTH);
        // A full message, then a place picked: what goes still fits, and the endpoint accepts it.
        const plan = planFeedbackSubmit({ ...where, message: 'x'.repeat(FEEDBACK_MESSAGE_MAX_LENGTH) }, tr);
        if ('error' in plan) throw new Error(plan.error);
        expect(plan.input.message.length).toBe(FEEDBACK_MESSAGE_MAX_LENGTH);
        expect(buildFeedbackSubmissionPayload(plan.input)).toMatchObject({ ok: true });
    });
});

describe('the Android installer source', () => {
    it('reads a Play install from its installer, so an empty referrer (a testing-track install) is still Play', () => {
        expect(resolveAndroidInstallerSource('', 'com.android.vending')).toBe('play-store');
        expect(resolveAndroidInstallerSource(null, 'com.android.vending')).toBe('play-store');
        expect(resolveAndroidInstallerSource('utm_source=google-play', null)).toBe('play-store');
        expect(resolveAndroidInstallerSource('', null)).toBe('sideload');
        expect(resolveAndroidInstallerSource('', 'com.google.android.packageinstaller')).toBe('sideload');
    });
});

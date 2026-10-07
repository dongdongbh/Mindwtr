import { describe, expect, it } from 'vitest';

import { buildFeedbackSubmissionPayload } from './feedback';
import { getFeedbackDraftState, planFeedbackSubmit } from './about-settings-model';
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
});

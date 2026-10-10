import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore } from '@mindwtr/core';

import { LanguageProvider } from './contexts/language-context';
import { useUiStore } from './store/ui-store';
import * as appLog from './lib/app-log';

type SettingsModule = typeof import('./components/views/SettingsView');
type ReviewModule = typeof import('./components/views/ReviewView');

const lazyViews = vi.hoisted(() => {
    let resolveSettings!: (module: SettingsModule) => void;
    let resolveReview!: (module: ReviewModule) => void;

    return {
        settings: new Promise<SettingsModule>((resolve) => {
            resolveSettings = resolve;
        }),
        review: new Promise<ReviewModule>((resolve) => {
            resolveReview = resolve;
        }),
        resolveSettings: (module: SettingsModule) => resolveSettings(module),
        resolveReview: (module: ReviewModule) => resolveReview(module),
    };
});

// This regression exercises the real App/Layout transition boundary. Keep the
// initial page small so unrelated calendar-grid rendering and role queries do
// not consume the test's timeout under CI coverage instrumentation.
vi.mock('./components/views/CalendarView', () => ({
    CalendarView: () => React.createElement('h1', null, 'Calendar'),
}));

vi.mock('./components/views/SettingsView', () => lazyViews.settings);
vi.mock('./components/views/ReviewView', () => lazyViews.review);

import App from './App';

const renderApp = () => render(
    <LanguageProvider>
        <App />
    </LanguageProvider>
);

const getContentWrapper = (container: HTMLElement) => (
    container.querySelector('[data-main-content] > div')
);

describe('App deferred navigation layout', () => {
    afterEach(() => vi.restoreAllMocks());
    beforeEach(() => {
        vi.spyOn(appLog, 'logInfo').mockResolvedValue(null);
        window.localStorage.clear();
        window.history.replaceState(null, '', '?view=calendar');
        useTaskStore.setState((state) => ({
            ...state,
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            _allTasks: [],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            _tasksById: new Map(),
            _projectsById: new Map(),
            _sectionsById: new Map(),
            _areasById: new Map(),
            settings: { diagnostics: { loggingEnabled: true } },
            isLoading: false,
            error: null,
        }));
        useUiStore.setState((state) => ({
            ...state,
            projectView: { selectedProjectId: null },
            toasts: [],
        }));
    });

    it('keeps rendered geometry during suspended navigation and commits only the latest view', async () => {
        const { container, getByRole } = renderApp();
        const content = () => getContentWrapper(container);
        const getContentHeading = (name: string) => within(content() as HTMLElement).getByRole('heading', { name });
        const queryContentHeading = (name: string) => within(content() as HTMLElement).queryByRole('heading', { name });

        expect(getContentHeading('Calendar')).toBeInTheDocument();
        expect(content()).toHaveClass('max-w-screen-2xl');

        const settingsButton = getByRole('button', { name: 'Settings' });
        fireEvent.click(settingsButton);

        expect(settingsButton).toHaveAttribute('aria-current', 'page');
        expect(getContentHeading('Calendar')).toBeInTheDocument();
        expect(content()).toHaveClass('max-w-screen-2xl');
        expect(content()).not.toHaveClass('max-w-none');

        const reviewButton = getByRole('button', { name: 'Review' });
        fireEvent.click(reviewButton);

        expect(reviewButton).toHaveAttribute('aria-current', 'page');
        expect(getContentHeading('Calendar')).toBeInTheDocument();
        expect(content()).toHaveClass('max-w-screen-2xl');
        const navigation = () => vi.mocked(appLog.logInfo).mock.calls
            .filter(([, context]) => context?.scope === 'renderer-navigation')
            .map(([, context]) => context!.extra!);
        expect(navigation().map((entry) => [entry.stage, entry.nextView])).toEqual([
            ['requested', 'settings'], ['requested', 'review'],
        ]);

        await act(async () => {
            lazyViews.resolveSettings({
                SettingsView: () => React.createElement('h1', null, 'Deferred Settings'),
            } as SettingsModule);
            await lazyViews.settings;
        });

        expect(queryContentHeading('Deferred Settings')).not.toBeInTheDocument();
        expect(getContentHeading('Calendar')).toBeInTheDocument();
        expect(content()).toHaveClass('max-w-screen-2xl');
        expect(navigation().every((entry) => entry.stage === 'requested')).toBe(true);

        await act(async () => {
            lazyViews.resolveReview({
                ReviewView: () => React.createElement('h1', null, 'Deferred Review'),
            } as ReviewModule);
            await lazyViews.review;
        });

        await waitFor(() => {
            expect(getContentHeading('Deferred Review')).toBeInTheDocument();
            expect(content()).toHaveClass('max-w-6xl');
            expect(content()).not.toHaveClass('max-w-screen-2xl');
        });
        const committed = navigation().filter((entry) => entry.stage === 'content-committed');
        expect(committed).toHaveLength(1);
        expect(committed[0]).toMatchObject({ actualView: 'review', nextView: 'review', navigationSequence: navigation()[1].navigationSequence });
    }, 20_000);
});

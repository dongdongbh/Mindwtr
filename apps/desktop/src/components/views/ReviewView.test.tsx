import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReviewView } from './ReviewView';
import { LanguageProvider } from '../../contexts/language-context';

const renderWithProviders = (ui: React.ReactElement) => {
    return render(
        <LanguageProvider>
            {ui}
        </LanguageProvider>
    );
};

// Mock store
vi.mock('@focus-gtd/core', async () => {
    const actual = await vi.importActual('@focus-gtd/core');
    return {
        ...actual,
        useTaskStore: () => ({
            tasks: [],
            projects: [],
        }),
    };
});

// Mock TaskItem to simplify testing
vi.mock('../TaskItem', () => ({
    TaskItem: ({ task }: { task: import('@focus-gtd/core').Task }) => <div data-testid="task-item">{task.title}</div>,
}));

describe('ReviewView', () => {
    it('starts at the intro step', () => {
        renderWithProviders(<ReviewView />);
        expect(screen.getByText('Time for your Weekly Review')).toBeInTheDocument();
        expect(screen.getByText('Start Review')).toBeInTheDocument();
    });

    it('navigates through the wizard steps', () => {
        renderWithProviders(<ReviewView />);

        // Intro -> Inbox
        fireEvent.click(screen.getByText('Start Review'));
        expect(screen.getByText('Process Inbox')).toBeInTheDocument();
        expect(screen.getByText('Inbox Zero Goal')).toBeInTheDocument();

        // Inbox -> Calendar
        fireEvent.click(screen.getByText('Next Step'));
        expect(screen.getByText('Review Calendar')).toBeInTheDocument();
        expect(screen.getByText('Past 14 Days')).toBeInTheDocument();

        // Calendar -> Waiting For
        fireEvent.click(screen.getByText('Next Step'));
        expect(screen.getByText('Waiting For')).toBeInTheDocument();

        // Waiting For -> Projects
        fireEvent.click(screen.getByText('Next Step'));
        expect(screen.getByText('Review Projects')).toBeInTheDocument();

        // Projects -> Someday/Maybe
        fireEvent.click(screen.getByText('Next Step'));
        expect(screen.getByText('Someday/Maybe')).toBeInTheDocument();

        // Someday/Maybe -> Completed
        fireEvent.click(screen.getByText('Next Step'));
        expect(screen.getByText('Review Complete!')).toBeInTheDocument();
        expect(screen.getByText('Finish')).toBeInTheDocument();
    });

    it('can navigate back', () => {
        renderWithProviders(<ReviewView />);

        // Go to Inbox
        fireEvent.click(screen.getByText('Start Review'));
        expect(screen.getByText('Process Inbox')).toBeInTheDocument();

        // Go back to Intro
        fireEvent.click(screen.getByText('Back'));
        expect(screen.getByText('Time for your Weekly Review')).toBeInTheDocument();
    });
});

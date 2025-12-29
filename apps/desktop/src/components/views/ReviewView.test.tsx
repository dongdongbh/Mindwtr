import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ReviewView } from './ReviewView';
import { LanguageProvider } from '../../contexts/language-context';

const renderWithProviders = (ui: React.ReactElement) => {
    return render(
        <LanguageProvider>
            {ui}
        </LanguageProvider>
    );
};

// Mock TaskItem to simplify testing
vi.mock('../TaskItem', () => ({
    TaskItem: ({ task }: { task: { title: string } }) => <div data-testid="task-item">{task.title}</div>,
}));

describe('ReviewView', () => {
    it('renders the review list with a guide button', () => {
        const { getByText } = renderWithProviders(<ReviewView />);
        expect(getByText('Review')).toBeInTheDocument();
        expect(getByText('Weekly Review')).toBeInTheDocument();
    });

    it('navigates through the wizard steps', () => {
        const { getByText } = renderWithProviders(<ReviewView />);

        // Open guide
        fireEvent.click(getByText('Weekly Review'));
        expect(getByText('Time for your Weekly Review')).toBeInTheDocument();

        // Intro -> Inbox
        fireEvent.click(getByText('Start Review'));
        expect(getByText('Process Inbox')).toBeInTheDocument();
        expect(getByText('Inbox Zero Goal')).toBeInTheDocument();

        // Inbox -> Calendar
        fireEvent.click(getByText('Next Step'));
        expect(getByText('AI insight')).toBeInTheDocument();

        // AI -> Calendar
        fireEvent.click(getByText('Next Step'));
        expect(getByText('Review Calendar')).toBeInTheDocument();
        expect(getByText('Past 14 Days')).toBeInTheDocument();

        // Calendar -> Waiting For
        fireEvent.click(getByText('Next Step'));
        expect(getByText('Waiting For')).toBeInTheDocument();

        // Waiting For -> Projects
        fireEvent.click(getByText('Next Step'));
        expect(getByText('Review Projects')).toBeInTheDocument();

        // Projects -> Someday/Maybe
        fireEvent.click(getByText('Next Step'));
        expect(getByText('Someday/Maybe')).toBeInTheDocument();

        // Someday/Maybe -> Completed
        fireEvent.click(getByText('Next Step'));
        expect(getByText('Review Complete!')).toBeInTheDocument();
        expect(getByText('Finish')).toBeInTheDocument();
    });

    it('can navigate back', () => {
        const { getByText } = renderWithProviders(<ReviewView />);

        // Open guide
        fireEvent.click(getByText('Weekly Review'));
        expect(getByText('Time for your Weekly Review')).toBeInTheDocument();

        // Go to Inbox
        fireEvent.click(getByText('Start Review'));
        expect(getByText('Process Inbox')).toBeInTheDocument();

        // Go back to Intro
        fireEvent.click(getByText('Back'));
        expect(getByText('Time for your Weekly Review')).toBeInTheDocument();
    });
});

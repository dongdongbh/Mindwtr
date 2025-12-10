import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';
import { LanguageProvider } from './contexts/language-context';

const renderWithProviders = (ui: React.ReactElement) => {
    return render(
        <LanguageProvider>
            {ui}
        </LanguageProvider>
    );
};

vi.mock('@focus-gtd/core', async () => {
    const actual = await vi.importActual('@focus-gtd/core');
    return {
        ...actual,
        useTaskStore: () => ({
            tasks: [],
            projects: [],
            addProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
            addTask: vi.fn(),
            updateTask: vi.fn(),
            deleteTask: vi.fn(),
            moveTask: vi.fn(),
            fetchData: vi.fn(),
        }),
        flushPendingSave: vi.fn().mockResolvedValue(undefined),
    };
});

// Mock Layout
vi.mock('./components/Layout', () => ({
    Layout: ({ children }: { children: React.ReactNode }) => <div data-testid="layout">{children}</div>,
}));

// Mock electronAPI
// Mock electronAPI
Object.defineProperty(window, 'electronAPI', {
    value: {
        saveData: vi.fn(),
        getData: vi.fn().mockResolvedValue({ tasks: [], projects: [], settings: {} }),
    },
    writable: true,
});

describe('App', () => {
    it('renders Inbox by default', () => {
        renderWithProviders(<App />);
        expect(screen.getByText('Inbox')).toBeInTheDocument();
    });

    it('renders Sidebar navigation', () => {
        renderWithProviders(<App />);
        expect(screen.getByTestId('layout')).toBeInTheDocument();
    });
});

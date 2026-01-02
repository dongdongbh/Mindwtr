import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import App from './App';
import { LanguageProvider } from './contexts/language-context';

const renderWithProviders = (ui: React.ReactElement) => {
    return render(
        <LanguageProvider>
            {ui}
        </LanguageProvider>
    );
};

// Mock Layout
vi.mock('./components/Layout', () => ({
    Layout: ({ children }: { children: React.ReactNode }) => <div data-testid="layout">{children}</div>,
}));

// Mock electronAPI
// Mock electronAPI
Object.defineProperty(window, 'electronAPI', {
    value: {
        saveData: vi.fn(),
        getData: vi.fn().mockResolvedValue({ tasks: [], projects: [], areas: [], settings: {} }),
    },
    writable: true,
});

describe('App', () => {
    it('renders Inbox by default', () => {
        const { getByText } = renderWithProviders(<App />);
        expect(getByText('Inbox')).toBeInTheDocument();
    });

    it('renders Sidebar navigation', () => {
        const { getByTestId } = renderWithProviders(<App />);
        expect(getByTestId('layout')).toBeInTheDocument();
    });
});

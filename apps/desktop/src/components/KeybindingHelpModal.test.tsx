import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { KeybindingHelpModal } from './KeybindingHelpModal';
import { GLOBAL_QUICK_ADD_SHORTCUT_DEFAULT } from '../lib/global-quick-add-shortcut';

describe('KeybindingHelpModal', () => {
    const renderModal = (style: 'vim' | 'emacs') => {
        return render(
            <KeybindingHelpModal
                style={style}
                onClose={vi.fn()}
                currentView="inbox"
                quickAddShortcut={GLOBAL_QUICK_ADD_SHORTCUT_DEFAULT}
                t={(key) => key}
            />
        );
    };

    it('shows complete vim keybinding help entries', () => {
        const { getByText, queryByText } = renderModal('vim');

        expect(getByText('Ctrl+, / Cmd+,')).toBeInTheDocument();
        expect(getByText('Ctrl-b / Cmd-b')).toBeInTheDocument();
        expect(getByText('Ctrl+\\ / Cmd+\\')).toBeInTheDocument();
        expect(getByText('Ctrl+Shift+D / Cmd+Shift+D')).toBeInTheDocument();
        expect(getByText('Ctrl+Shift+C / Cmd+Shift+C')).toBeInTheDocument();
        expect(getByText('F11')).toBeInTheDocument();
        expect(getByText('gi')).toBeInTheDocument();
        expect(getByText('a1-a9')).toBeInTheDocument();
        expect(getByText('a0')).toBeInTheDocument();
        expect(getByText('dd')).toBeInTheDocument();
        expect(queryByText('Alt-i')).not.toBeInTheDocument();
    });

    it('shows complete emacs keybinding help entries', () => {
        const { getByText, queryByText } = renderModal('emacs');

        expect(getByText('Ctrl+, / Cmd+,')).toBeInTheDocument();
        expect(getByText('Ctrl-h / Ctrl-?')).toBeInTheDocument();
        expect(getByText('Alt-i')).toBeInTheDocument();
        expect(getByText('Alt-A')).toBeInTheDocument();
        expect(getByText('Ctrl-n / Ctrl-p / ↑ / ↓')).toBeInTheDocument();
        expect(getByText('F11')).toBeInTheDocument();
        expect(queryByText('gi')).not.toBeInTheDocument();
    });
});

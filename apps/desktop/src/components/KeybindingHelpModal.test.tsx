import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { KeybindingHelpModal } from './KeybindingHelpModal';
import { GLOBAL_QUICK_ADD_SHORTCUT_DEFAULT } from '../lib/global-quick-add-shortcut';

describe('KeybindingHelpModal', () => {
    const renderModal = (style: 'vim' | 'emacs' | 'standard') => {
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
        expect(getByText('Ctrl+Alt+S / Cmd+Option+S')).toBeInTheDocument();
        expect(getByText('Ctrl-b / Cmd-b')).toBeInTheDocument();
        expect(getByText('Ctrl+\\ / Cmd+\\')).toBeInTheDocument();
        expect(getByText('Ctrl+Shift+D / Cmd+Shift+D')).toBeInTheDocument();
        expect(getByText('Ctrl+Shift+C / Cmd+Shift+C')).toBeInTheDocument();
        expect(getByText('F11')).toBeInTheDocument();
        expect(getByText('a')).toBeInTheDocument();
        expect(getByText('Global quick add')).toBeInTheDocument();
        expect(getByText('In-app quick add')).toBeInTheDocument();
        expect(getByText('gi')).toBeInTheDocument();
        expect(getByText('1-9 / Shift+A 1-9')).toBeInTheDocument();
        expect(getByText('0 / Shift+A 0')).toBeInTheDocument();
        expect(getByText('dd')).toBeInTheDocument();
        expect(getByText('gT')).toBeInTheDocument();
        expect(queryByText('Alt-i')).not.toBeInTheDocument();
    });

    it('shows complete emacs keybinding help entries', () => {
        const { getByText, queryByText } = renderModal('emacs');

        expect(getByText('Ctrl+, / Cmd+,')).toBeInTheDocument();
        expect(getByText('Ctrl+Alt+S / Cmd+Option+S')).toBeInTheDocument();
        expect(getByText('Ctrl-h / Ctrl-?')).toBeInTheDocument();
        expect(getByText('a')).toBeInTheDocument();
        expect(getByText('Global quick add')).toBeInTheDocument();
        expect(getByText('In-app quick add')).toBeInTheDocument();
        expect(getByText('Alt-i')).toBeInTheDocument();
        expect(getByText('Alt-A')).toBeInTheDocument();
        expect(getByText('Alt-T')).toBeInTheDocument();
        expect(getByText('Ctrl-n / Ctrl-p / ↑ / ↓')).toBeInTheDocument();
        expect(getByText('F11')).toBeInTheDocument();
        expect(queryByText('gi')).not.toBeInTheDocument();
    });

    it('shows Standard focus and rename shortcuts', () => {
        const { getByText } = renderModal('standard');

        expect(getByText('S').parentElement).toHaveTextContent("Add to today's focus");
        expect(getByText('F2').parentElement).toHaveTextContent('Rename task');
    });
});

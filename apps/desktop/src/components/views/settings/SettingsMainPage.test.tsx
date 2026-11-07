import { act, fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const fontMocks = vi.hoisted(() => ({
    canListInstalledFonts: vi.fn(() => false),
    loadInstalledFontFamilies: vi.fn(async () => [] as string[]),
}));

vi.mock('../../../lib/font-family', () => fontMocks);

import { useUiStore } from '../../../store/ui-store';
import { en } from '../../../../../../packages/core/src/i18n/locales/en';
import { zhHans } from '../../../../../../packages/core/src/i18n/locales/zh-Hans';
import { buildSettingsLabels, getEnglishSettingsLabels } from './labels';
import { SettingsMainPage, type SettingsMainPageProps } from './SettingsMainPage';

const baseProps: SettingsMainPageProps = {
    t: getEnglishSettingsLabels(),
    translate: (key) => en[key] ?? key,
    themeMode: 'system',
    onThemeChange: vi.fn(),
    densityMode: 'comfortable',
    onDensityChange: vi.fn(),
    areaFilterStyle: 'list',
    onAreaFilterStyleChange: vi.fn(),
    textSizeMode: 'default',
    onTextSizeChange: vi.fn(),
    fontFamily: '',
    onFontFamilyChange: vi.fn(),
    showTaskAge: false,
    onShowTaskAgeChange: vi.fn(),
    language: 'en',
    onLanguageChange: vi.fn(),
    weekStart: 'sunday',
    onWeekStartChange: vi.fn(),
    dateFormat: 'system',
    onDateFormatChange: vi.fn(),
    calendarSystem: 'gregorian',
    showCalendarSystem: false,
    onCalendarSystemChange: vi.fn(),
    timeFormat: 'system',
    onTimeFormatChange: vi.fn(),
    globalQuickAddShortcut: 'Control+Alt+M',
    onGlobalQuickAddShortcutChange: vi.fn(),
    undoNotificationsEnabled: true,
    onUndoNotificationsChange: vi.fn(),
    languages: [{ id: 'en', native: 'English' }],
};

describe('SettingsMainPage', () => {
    it('updates shortcut option labels when the active translation changes', () => {
        const translateChinese = (key: string) => zhHans[key] ?? key;
        const { getByRole, queryByRole, rerender } = render(<SettingsMainPage {...baseProps} isFlatpak />);
        expect(getByRole('option', { name: 'Disabled (Flatpak default)' })).toHaveValue('disabled');

        rerender(
            <SettingsMainPage
                {...baseProps}
                isFlatpak
                language="zh"
                t={buildSettingsLabels(translateChinese)}
                translate={translateChinese}
            />,
        );
        expect(getByRole('option', { name: '禁用（Flatpak 默认）' })).toHaveValue('disabled');
        expect(getByRole('option', { name: 'Ctrl+Shift+A（旧版）' })).toHaveValue('CommandOrControl+Shift+A');
        expect(queryByRole('option', { name: 'Disabled (Flatpak default)' })).not.toBeInTheDocument();
    });

    it('shows native language names without translation-coverage labels', () => {
        const { getByRole } = render(
            <SettingsMainPage
                {...baseProps}
                languages={[
                    { id: 'en', native: 'English' },
                    { id: 'sv', native: 'Svenska' },
                    { id: 'nl', native: 'Nederlands' },
                ]}
            />,
        );

        const options = Array.from(getByRole('combobox', { name: 'Language' }).querySelectorAll('option'))
            .map((option) => option.textContent);
        expect(options).toEqual(['English', 'Svenska', 'Nederlands']);
    });

    it('shows only the native name for the selected language', () => {
        const { getAllByText } = render(
            <SettingsMainPage
                {...baseProps}
                language="nl"
                languages={[{ id: 'nl', native: 'Nederlands' }]}
            />,
        );

        expect(getAllByText('Nederlands')).toHaveLength(2);
    });

    it('shows the Flatpak quick add command and disables app-owned shortcut selection', () => {
        const { getByRole, getByText } = render(
            <SettingsMainPage
                {...baseProps}
                isFlatpak
            />,
        );

        expect(getByText('Flatpak custom shortcut command')).toBeInTheDocument();
        expect(getByText('flatpak run tech.dongdongbh.mindwtr --quick-add')).toBeInTheDocument();
        expect(getByRole('combobox', { name: 'Global quick add shortcut' })).toBeDisabled();
    });

    it('offers Saturday as a week start option', () => {
        const onWeekStartChange = vi.fn();
        const { getAllByText, getByRole } = render(
            <SettingsMainPage
                {...baseProps}
                weekStart="saturday"
                onWeekStartChange={onWeekStartChange}
            />,
        );

        fireEvent.click(getByRole('button', { name: /Regional formats/ }));
        expect(getAllByText('Saturday').length).toBeGreaterThan(0);
        fireEvent.change(getByRole('combobox', { name: 'Week starts on' }), {
            target: { value: 'monday' },
        });

        expect(onWeekStartChange).toHaveBeenCalledWith('monday');
    });

    it('only renders the calendar system selector when enabled', () => {
        const onCalendarSystemChange = vi.fn();
        const hidden = render(<SettingsMainPage {...baseProps} />);
        expect(hidden.queryByText('Calendar system')).toBeNull();
        hidden.unmount();

        const { getByRole, getByText } = render(
            <SettingsMainPage
                {...baseProps}
                showCalendarSystem
                calendarSystem="jalali"
                onCalendarSystemChange={onCalendarSystemChange}
            />,
        );

        fireEvent.click(getByRole('button', { name: /Regional formats/ }));
        expect(getByText('Calendar system')).toBeInTheDocument();
        fireEvent.change(getByRole('combobox', { name: 'Calendar system' }), {
            target: { value: 'gregorian' },
        });

        expect(onCalendarSystemChange).toHaveBeenCalledWith('gregorian');
    });

    it('offers the condensed density preset', () => {
        const onDensityChange = vi.fn();
        const { getByRole } = render(
            <SettingsMainPage
                {...baseProps}
                densityMode="condensed"
                onDensityChange={onDensityChange}
            />,
        );

        const select = getByRole('combobox', { name: 'Density' });
        expect(select).toHaveValue('condensed');

        fireEvent.change(select, {
            target: { value: 'compact' },
        });

        expect(onDensityChange).toHaveBeenCalledWith('compact');
    });

    it('switches the sidebar area filter to chips', () => {
        const onAreaFilterStyleChange = vi.fn();
        const { getByRole } = render(
            <SettingsMainPage
                {...baseProps}
                onAreaFilterStyleChange={onAreaFilterStyleChange}
            />,
        );

        const select = getByRole('combobox', { name: 'Area filter style' });
        expect(select).toHaveValue('list');

        fireEvent.change(select, {
            target: { value: 'chips' },
        });

        expect(onAreaFilterStyleChange).toHaveBeenCalledWith('chips');
    });

    it('offers the small text size preset', () => {
        const onTextSizeChange = vi.fn();
        const { getByRole } = render(
            <SettingsMainPage
                {...baseProps}
                textSizeMode="small"
                onTextSizeChange={onTextSizeChange}
            />,
        );

        const select = getByRole('combobox', { name: 'Text size' });
        expect(select).toHaveValue('small');

        fireEvent.change(select, {
            target: { value: 'large' },
        });

        expect(onTextSizeChange).toHaveBeenCalledWith('large');
    });

    it('browses and searches the installed fonts, applying only an exact pick (#1244)', async () => {
        let resolveFonts!: (fonts: string[]) => void;
        fontMocks.canListInstalledFonts.mockReturnValue(true);
        fontMocks.loadInstalledFontFamilies.mockReturnValue(new Promise((resolve) => { resolveFonts = resolve; }));
        const onFontFamilyChange = vi.fn();
        const { getByLabelText, getByRole, queryByRole } = render(
            <SettingsMainPage {...baseProps} fontFamily="Inter" onFontFamilyChange={onFontFamilyChange} />,
        );
        const listedFonts = () => within(getByRole('listbox')).getAllByRole('option').map((option) => option.textContent);


        await act(async () => { resolveFonts(['Inter', 'Roboto']); });
        const input = getByRole('combobox', { name: 'Font' }) as HTMLInputElement;


        fireEvent.focus(input);
        expect(getByRole('option', { name: 'Roboto' })).toBeInTheDocument();
        expect(input.value).toBe('');
        expect(input.placeholder).toBe('Inter');
        expect(listedFonts()).toEqual(['App default', 'Inter', 'Roboto']);

        fireEvent.change(input, { target: { value: 'rob' } });
        expect(listedFonts()).toEqual(['Roboto']);
        expect(onFontFamilyChange).not.toHaveBeenCalled();

        fireEvent.mouseDown(within(getByRole('listbox')).getByRole('option', { name: 'Roboto' }));
        expect(onFontFamilyChange).toHaveBeenLastCalledWith('Roboto');


        onFontFamilyChange.mockClear();
        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: 'zzz' } });
        fireEvent.blur(input);
        expect(onFontFamilyChange).not.toHaveBeenCalled();
        expect((getByLabelText('Font') as HTMLInputElement).value).toBe('Inter');
        expect(queryByRole('listbox')).toBeNull();


        fireEvent.focus(input);
        fireEvent.mouseDown(within(getByRole('listbox')).getByRole('option', { name: 'App default' }));
        expect(onFontFamilyChange).toHaveBeenLastCalledWith('');
    });

    it('opens the full installed-font list when it loads after the field was focused', async () => {
        let resolveFonts!: (fonts: string[]) => void;
        fontMocks.canListInstalledFonts.mockReturnValue(true);
        fontMocks.loadInstalledFontFamilies.mockReturnValue(new Promise((resolve) => { resolveFonts = resolve; }));
        const onFontFamilyChange = vi.fn();
        const { getByRole, findByRole } = render(
            <SettingsMainPage {...baseProps} fontFamily="Inter" onFontFamilyChange={onFontFamilyChange} />,
        );

        const input = getByRole('combobox', { name: 'Font' }) as HTMLInputElement;
        fireEvent.focus(input);
        expect(input).toHaveValue('Inter');
        await act(async () => { resolveFonts(['Inter', 'Roboto']); });

        expect(await findByRole('option', { name: 'Roboto' })).toBeInTheDocument();
        expect(input).toHaveValue('');
        expect(input.placeholder).toBe('Inter');
        expect(onFontFamilyChange).not.toHaveBeenCalled();
    });

    it('keeps typed text or a saved font when the list loads after typing or blur', async () => {
        let resolveFonts!: (fonts: string[]) => void;
        fontMocks.canListInstalledFonts.mockReturnValue(true);
        fontMocks.loadInstalledFontFamilies.mockReturnValue(new Promise((resolve) => { resolveFonts = resolve; }));
        const onFontFamilyChange = vi.fn();
        const view = render(
            <SettingsMainPage {...baseProps} fontFamily="Inter" onFontFamilyChange={onFontFamilyChange} />,
        );

        const input = view.getByRole('combobox', { name: 'Font' }) as HTMLInputElement;
        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: 'rob' } });
        await act(async () => { resolveFonts(['Inter', 'Roboto']); });
        expect(input).toHaveValue('rob');
        expect(view.getByRole('option', { name: 'Roboto' })).toBeInTheDocument();
        expect(onFontFamilyChange).not.toHaveBeenCalled();
        view.unmount();

        fontMocks.loadInstalledFontFamilies.mockReturnValue(new Promise((resolve) => { resolveFonts = resolve; }));
        const blurred = render(
            <SettingsMainPage {...baseProps} fontFamily="Inter" onFontFamilyChange={onFontFamilyChange} />,
        );
        const blurredInput = blurred.getByRole('combobox', { name: 'Font' }) as HTMLInputElement;
        fireEvent.focus(blurredInput);
        fireEvent.blur(blurredInput);
        await act(async () => { resolveFonts(['Inter', 'Roboto']); });
        expect(blurredInput).toHaveValue('Inter');
        expect(blurred.queryByRole('listbox')).toBeNull();
        expect(onFontFamilyChange).not.toHaveBeenCalled();
    });

    it('keeps a chosen font that the list no longer offers (#1244)', async () => {


        fontMocks.canListInstalledFonts.mockReturnValue(true);
        fontMocks.loadInstalledFontFamilies.mockResolvedValue(['Inter', 'Roboto']);
        const onFontFamilyChange = vi.fn();
        const { findByRole, getByLabelText } = render(
            <SettingsMainPage {...baseProps} fontFamily="Ink Free" onFontFamilyChange={onFontFamilyChange} />,
        );

        const input = await findByRole('combobox', { name: 'Font' }) as HTMLInputElement;
        expect(input.value).toBe('Ink Free');
        fireEvent.focus(input);
        fireEvent.blur(input);
        expect(onFontFamilyChange).not.toHaveBeenCalled();
        expect((getByLabelText('Font') as HTMLInputElement).value).toBe('Ink Free');
    });

    it('falls back to a typed name when no font list is available (#1244)', () => {
        fontMocks.canListInstalledFonts.mockReturnValue(false);
        const onFontFamilyChange = vi.fn();
        const { getByLabelText } = render(
            <SettingsMainPage {...baseProps} fontFamily="" onFontFamilyChange={onFontFamilyChange} />,
        );

        const input = getByLabelText('Font') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'Inter' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onFontFamilyChange).toHaveBeenLastCalledWith('Inter');
    });

    it('offers one History toggle for the merged Done and Archived sidebar entry', () => {
        useUiStore.setState({ hiddenSidebarViews: [] });
        const { getByRole, queryByRole, unmount } = render(<SettingsMainPage {...baseProps} />);

        fireEvent.click(getByRole('button', { name: /Sidebar views/ }));
        expect(queryByRole('button', { name: 'Done' })).toBeNull();
        expect(queryByRole('button', { name: 'Archived' })).toBeNull();
        expect(getByRole('button', { name: 'History' })).toHaveAttribute('aria-pressed', 'true');

        fireEvent.click(getByRole('button', { name: 'History' }));
        expect(useUiStore.getState().hiddenSidebarViews).toEqual(expect.arrayContaining(['done', 'archived']));
        expect(getByRole('button', { name: 'History' })).toHaveAttribute('aria-pressed', 'false');
        unmount();


        useUiStore.setState({ hiddenSidebarViews: ['archived'] });
        const second = render(<SettingsMainPage {...baseProps} />);
        fireEvent.click(second.getByRole('button', { name: /Sidebar views/ }));
        expect(second.getByRole('button', { name: 'History' })).toHaveAttribute('aria-pressed', 'true');
    });
});

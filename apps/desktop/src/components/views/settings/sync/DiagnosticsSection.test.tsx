import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DiagnosticsSection } from './DiagnosticsSection';

const baseProps: Parameters<typeof DiagnosticsSection>[0] = {
    t: {
        diagnostics: 'Diagnostics',
        diagnosticsDesc: 'Help troubleshoot issues.',
        analyticsHeartbeat: 'Opt out of diagnostics',
        analyticsHeartbeatDesc: 'Diagnostics are anonymous and help improve Mindwtr.',
        debugLogging: 'Debug logging',
        debugLoggingDesc: 'Record errors locally.',
        logFile: 'Log file',
        clearLog: 'Clear log',
        saveLog: 'Save log',
    } as any,
    analyticsHeartbeatAvailable: true,
    analyticsHeartbeatEnabled: true,
    loggingEnabled: false,
    logPath: '',
    onAnalyticsHeartbeatChange: vi.fn(),
    onToggleLogging: vi.fn(),
    onClearLog: vi.fn(),
    onSaveLog: vi.fn(),
};

describe('DiagnosticsSection', () => {
    it('renders the default sending state as not opted out', () => {
        const onAnalyticsHeartbeatChange = vi.fn();
        const { getByRole } = render(
            <DiagnosticsSection
                {...baseProps}
                analyticsHeartbeatEnabled
                onAnalyticsHeartbeatChange={onAnalyticsHeartbeatChange}
            />
        );

        const optOutSwitch = getByRole('switch', { name: 'Opt out of diagnostics' });

        expect(optOutSwitch).toHaveAttribute('aria-checked', 'false');
        fireEvent.click(optOutSwitch);
        expect(onAnalyticsHeartbeatChange).toHaveBeenCalledWith(false);
    });

    it('renders disabled diagnostics as opted out', () => {
        const onAnalyticsHeartbeatChange = vi.fn();
        const { getByRole } = render(
            <DiagnosticsSection
                {...baseProps}
                analyticsHeartbeatEnabled={false}
                onAnalyticsHeartbeatChange={onAnalyticsHeartbeatChange}
            />
        );

        const optOutSwitch = getByRole('switch', { name: 'Opt out of diagnostics' });

        expect(optOutSwitch).toHaveAttribute('aria-checked', 'true');
        fireEvent.click(optOutSwitch);
        expect(onAnalyticsHeartbeatChange).toHaveBeenCalledWith(true);
    });


    it('offers Save log next to Clear log', () => {
        const onSaveLog = vi.fn();
        const { getByRole } = render(<DiagnosticsSection {...baseProps} onSaveLog={onSaveLog} />);

        fireEvent.click(getByRole('button', { name: 'Save log' }));
        expect(onSaveLog).toHaveBeenCalledTimes(1);
    });
});

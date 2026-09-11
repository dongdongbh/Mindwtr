import { Alert, type AlertButton } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmMobileSandboxEntry, requestMobileSandboxEntry } from './sandbox-entry-confirmation';

describe('mobile sandbox entry confirmation', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('does nothing when the user cancels', () => {
        const onEnter = vi.fn();
        const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => undefined);

        confirmMobileSandboxEntry((key) => key, onEnter);

        const buttons = alert.mock.calls[0]?.[2] as AlertButton[];
        expect(buttons[0]).toMatchObject({ text: 'common.cancel', style: 'cancel' });
        buttons[0].onPress?.();
        expect(onEnter).not.toHaveBeenCalled();
    });

    it('starts the transition only after the user chooses Enter', () => {
        const onEnter = vi.fn();
        const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => undefined);

        confirmMobileSandboxEntry((key) => key, onEnter);

        expect(onEnter).not.toHaveBeenCalled();
        expect(alert).toHaveBeenCalledWith(
            'sandbox.confirmTitle',
            'sandbox.confirmDescription',
            expect.any(Array),
        );
        const buttons = alert.mock.calls[0]?.[2] as AlertButton[];
        buttons[1].onPress?.();
        expect(buttons[1].text).toBe('sandbox.enter');
        expect(onEnter).toHaveBeenCalledTimes(1);
    });

    it('does not open the confirmation or enter while a Data operation is already busy', () => {
        const onEnter = vi.fn();
        const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => undefined);

        expect(requestMobileSandboxEntry((key) => key, onEnter, () => true)).toBe(false);

        expect(alert).not.toHaveBeenCalled();
        expect(onEnter).not.toHaveBeenCalled();
    });

    it('does not enter when a Data operation starts while confirmation is open', () => {
        let busy = false;
        const onEnter = vi.fn();
        const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => undefined);

        expect(requestMobileSandboxEntry((key) => key, onEnter, () => busy)).toBe(true);
        busy = true;
        const buttons = alert.mock.calls[0]?.[2] as AlertButton[];
        buttons[1].onPress?.();

        expect(onEnter).not.toHaveBeenCalled();
    });
});

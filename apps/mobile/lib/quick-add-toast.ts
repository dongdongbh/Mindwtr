import type { ToastOptions } from '@/contexts/toast-context';


export function showInvalidDateCommandToast(
    showToast: (options: ToastOptions) => void,
    t: (key: string) => string,
    invalidDateCommands: readonly string[],
): void {
    showToast({
        title: t('common.notice'),
        message: `${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`,
        tone: 'warning',
        durationMs: 4200,
    });
}

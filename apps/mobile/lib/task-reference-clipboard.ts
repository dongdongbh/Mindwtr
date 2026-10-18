import * as Clipboard from 'expo-clipboard';
import { tFallback } from '@mindwtr/core';

import type { ToastOptions } from '../contexts/toast-context';

export async function copyTaskReference(
    taskId: string,
    kind: 'link' | 'id',
    t: (key: string) => string,
    showToast: (options: ToastOptions) => void,
): Promise<void> {
    try {
        await Clipboard.setStringAsync(kind === 'link'
            ? `mindwtr://open?task=${encodeURIComponent(taskId)}` : taskId);
        showToast({ message: tFallback(t, 'list.taskCopied', 'Task copied to clipboard'), tone: 'success' });
    } catch {
        showToast({ message: tFallback(t, 'list.taskCopyFailed', 'Could not copy task'), tone: 'error' });
    }
}

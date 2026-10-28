import { useCallback, useEffect, useState } from 'react';
import { flushPendingSave, useTaskStore } from '@mindwtr/core';

import { useLanguage } from '../../contexts/language-context';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { reportError } from '../../lib/report-error';
import {
    listWorkspaces,
    WORKSPACES_CHANGED_EVENT,
    switchWorkspace,
    workspaceDisplayName,
    WorkspaceSaveError,
    type WorkspaceInfo,
    type WorkspaceList,
} from '../../lib/workspaces';
import { useUiStore } from '../../store/ui-store';

/**
 * The workspace list plus the one switch flow both the sidebar switcher and
 * Settings use: confirm, save pending changes, then restart into the new
 * workspace (#1473).
 */
export function useWorkspaces() {
    const { t } = useLanguage();
    const showToast = useUiStore((state) => state.showToast);
    const { requestConfirmation, confirmModal } = useConfirmDialog();
    const [list, setList] = useState<WorkspaceList | null>(null);
    const [switching, setSwitching] = useState(false);

    const refresh = useCallback(async () => {
        try {
            setList(await listWorkspaces());
        } catch {
            // Sandbox mode and web builds have no workspaces.
            setList(null);
        }
    }, []);

    useEffect(() => {
        void refresh();
        // Settings and the sidebar each hold a list; a change in one refreshes both.
        window.addEventListener(WORKSPACES_CHANGED_EVENT, refresh);
        return () => window.removeEventListener(WORKSPACES_CHANGED_EVENT, refresh);
    }, [refresh]);

    const nameOf = useCallback(
        (workspace: WorkspaceInfo) => workspaceDisplayName(workspace, t('workspaces.defaultName')),
        [t],
    );

    const switchTo = useCallback(async (workspace: WorkspaceInfo) => {
        setSwitching(true);
        try {
            // After its retries the store drops a failed save, so the flush
            // itself succeeds; a failure still recorded means unsaved changes.
            await switchWorkspace(workspace.id, async () => {
                await flushPendingSave();
                if (useTaskStore.getState().persistenceFailure !== null) {
                    throw new Error('A save failed earlier');
                }
            });
        } catch (error) {
            setSwitching(false);
            if (error instanceof WorkspaceSaveError) {
                showToast(t('workspaces.saveFailed'), 'error');
            } else {
                reportError('Workspace switch failed', error, { userMessage: t('workspaces.failed') });
            }
        }
    }, [showToast, t]);

    const requestSwitch = useCallback(async (workspace: WorkspaceInfo, options?: { title?: string; cancelLabel?: string }) => {
        if (switching || workspace.id === list?.activeId) return;
        const confirmed = await requestConfirmation({
            title: options?.title ?? t('workspaces.switchTitle'),
            description: t('workspaces.switchDesc').replace('{{name}}', nameOf(workspace)),
            confirmLabel: t('workspaces.switchNow'),
            cancelLabel: options?.cancelLabel ?? t('common.cancel'),
        });
        if (confirmed) await switchTo(workspace);
    }, [list?.activeId, nameOf, requestConfirmation, switchTo, switching, t]);

    return { list, refresh, nameOf, requestSwitch, requestConfirmation, confirmModal, switching };
}

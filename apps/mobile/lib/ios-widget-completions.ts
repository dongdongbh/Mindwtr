import { isSandboxMode } from '@mindwtr/core';
import { Platform } from 'react-native';

import { acknowledgePendingCompletion, claimPendingCompletions } from '../modules/ios-widget';
import { logError, logInfo } from './app-log';
import { applyPendingCompletion } from './pending-captures';
import { buildWidgetCompletionToken } from './widget-completion-token';

type CompletionDeps = Parameters<typeof applyPendingCompletion>[1] & {
    flushPendingSave: () => Promise<void>;
    refreshWidgets: () => Promise<boolean>;
};


export async function ingestIosWidgetCompletions(deps: CompletionDeps): Promise<number> {
    if (Platform.OS !== 'ios' || isSandboxMode()) return 0;
    const pending = await claimPendingCompletions();
    let count = 0;
    for (const completion of pending) {
        if (isSandboxMode()) break;
        try {
            const task = (deps.getTasks?.() ?? deps.tasks).find(({ id }) => id === completion.taskId);
            const stale = task && !task.deletedAt && !task.purgedAt
                && task.status !== 'done' && task.status !== 'archived'
                && buildWidgetCompletionToken(task) !== completion.token;


            const tappedAt = completion.createdAt > 0 && completion.createdAt <= Date.now()
                ? new Date(completion.createdAt).toISOString()
                : undefined;
            const outcome = stale ? 'stale' : await applyPendingCompletion({
                kind: 'complete', id: completion.id, taskId: completion.taskId,
                ...(tappedAt ? { completedAt: tappedAt } : {}),
            }, deps);
            if (!outcome) continue;
            if (isSandboxMode()) break;


            await deps.flushPendingSave();
            if (isSandboxMode()) break;
            if (!await deps.refreshWidgets()) continue;
            if (isSandboxMode()) break;
            await acknowledgePendingCompletion(completion.id);
            count += 1;
            void logInfo('iOS widget completion ingested', {
                scope: 'widget',
                extra: { releaseCheck: 'v1.3.0/ios-widget-checkoff', outcome },
            });
        } catch (error) {


            void logError(error, { scope: 'widget', extra: { message: 'iOS widget completion ingest failed' } });
        }
    }
    if (count > 0) {
        void logInfo('iOS widget parity completions ingested', {
            scope: 'widget',
            extra: {
                releaseCheck: 'v1.3.1/ios-widget-parity',
                count: String(count),
            },
        });
    }
    return count;
}

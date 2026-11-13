import { Check } from 'lucide-react';
import { useState } from 'react';
import { useTaskById } from '@mindwtr/core';
import { useLanguage } from '../../../contexts/language-context';
import { useInboxSessionTaskIds } from '../../../contexts/inbox-session-context';

function CompletedInboxTask({ taskId }: { taskId: string }) {
    const task = useTaskById(taskId);
    if (!task || task.status !== 'done' || task.deletedAt) return null;
    return (
        <li className="flex items-start gap-2 px-3 py-2 text-sm text-muted-foreground">
            <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="break-words line-through">{task.title}</span>
        </li>
    );
}

export function InboxSessionRecap() {
    const [expanded, setExpanded] = useState(false);
    const taskIds = useInboxSessionTaskIds();
    const { t } = useLanguage();
    if (taskIds.length === 0) return null;
    return (
        <details
            className="mx-3 mt-4 rounded-lg border border-border/60"
            data-testid="inbox-session-recap"
            open={expanded}
            onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
            <summary className="cursor-pointer rounded px-3 py-2 text-sm font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                {t('inbox.completedInSession')} ({taskIds.length})
            </summary>
            {expanded && <ul className="border-t border-border/60">
                {taskIds.map((id) => <CompletedInboxTask key={id} taskId={id} />)}
            </ul>}
        </details>
    );
}

import { useState } from 'react';
import { checklistProjectBlockReason, type Task } from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import { Dialog, DialogBody, DialogFooter } from './ui/Dialog';
import { Button } from './ui/Button';

export function TaskProjectConversionDialog({ task, onConfirm, onClose }: {
    task: Task; onConfirm: (title: string, expand: boolean) => Promise<void>; onClose: () => void;
}) {
    const { t } = useLanguage();
    const [title, setTitle] = useState(task.title);
    const [expand, setExpand] = useState(false);
    const [busy, setBusy] = useState(false);
    const blocked = checklistProjectBlockReason(task);
    return <Dialog label={t('task.createProjectFromTask')} onClose={busy ? () => {} : onClose}>
        <DialogBody className="p-6 space-y-4">
            <h2 className="font-semibold">{t('task.createProjectFromTask')}</h2>
            <label className="block">{t('projects.projectName')}
                <input autoFocus value={title} onChange={event => setTitle(event.target.value)} disabled={busy}
                    className="mt-2 w-full rounded border border-border bg-background p-2" />
            </label>
            <label className="flex items-center gap-3 min-h-11">
                <input type="checkbox" checked={expand} disabled={busy || (!!blocked && !expand)}
                    onChange={event => setExpand(event.target.checked)} />{t('task.expandChecklist')}
            </label>
            <p className="text-sm text-muted-foreground">{t(expand ? 'task.expandChecklistDescription' : 'task.keepChecklistDescription')}</p>
            {blocked && <p className="text-sm text-muted-foreground">{t(blocked)}</p>}
        </DialogBody>
        <DialogFooter className="p-6 flex justify-end gap-2">
            <Button variant="secondary" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
            <Button disabled={busy || !title.trim() || (expand && !!blocked)} onClick={async () => {
                setBusy(true);
                try { await onConfirm(title.trim(), expand); } finally { setBusy(false); }
            }}>{t('task.createProjectFromTask')}</Button>
        </DialogFooter>
    </Dialog>;
}

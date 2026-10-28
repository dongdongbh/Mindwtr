import { useState } from 'react';
import { FolderOpen } from 'lucide-react';

import { useLanguage } from '../../../contexts/language-context';
import { reportError } from '../../../lib/report-error';
import { cn } from '../../../lib/utils';
import {
    createWorkspace,
    deleteWorkspace,
    updateWorkspace,
    type WorkspaceInfo,
} from '../../../lib/workspaces';
import { useWorkspaces } from '../../workspaces/use-workspaces';

const WORKSPACE_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6'];

function ColorPicker({ value, onChange, label }: { value: string | null; onChange: (color: string | null) => void; label: string }) {
    return (
        <div className="flex items-center gap-1.5" role="radiogroup" aria-label={label}>
            {WORKSPACE_COLORS.map((color) => (
                <button
                    key={color}
                    type="button"
                    role="radio"
                    aria-checked={value === color}
                    aria-label={color}
                    onClick={() => onChange(value === color ? null : color)}
                    className={cn(
                        'h-5 w-5 rounded-full border-2 focus:outline-none focus:ring-2 focus:ring-primary/40',
                        value === color ? 'border-foreground' : 'border-transparent',
                    )}
                    style={{ backgroundColor: color }}
                />
            ))}
        </div>
    );
}

type EditState = { id: string; name: string; color: string | null };

/**
 * Settings > Data: the workspace list (#1473). Add, rename, switch and delete;
 * the sidebar switcher only appears once a second workspace exists.
 */
export function SettingsWorkspacesSection() {
    const { t } = useLanguage();
    const { list, refresh, nameOf, requestSwitch, requestConfirmation, confirmModal, switching } = useWorkspaces();
    const [newName, setNewName] = useState('');
    const [newColor, setNewColor] = useState<string | null>(null);
    const [editing, setEditing] = useState<EditState | null>(null);
    const [busy, setBusy] = useState(false);

    if (!list) return null;

    const run = async <T,>(label: string, action: () => Promise<T>): Promise<T | null> => {
        setBusy(true);
        try {
            return await action();
        } catch (error) {
            reportError(label, error, { userMessage: t('workspaces.failed') });
            return null;
        } finally {
            setBusy(false);
            await refresh();
        }
    };

    const handleAdd = async () => {
        const name = newName.trim();
        if (!name || busy) return;
        const created = await run('Workspace create failed', async () => {
            const workspace = await createWorkspace(name, newColor);
            setNewName('');
            setNewColor(null);
            return workspace;
        });
        if (created) {
            await requestSwitch(created, {
                title: t('workspaces.createdTitle'),
                cancelLabel: t('workspaces.later'),
            });
        }
    };

    const handleRename = async () => {
        if (!editing || !editing.name.trim() || busy) return;
        const { id, name, color } = editing;
        await run('Workspace rename failed', async () => {
            await updateWorkspace(id, name.trim(), color);
            setEditing(null);
        });
    };

    const handleDelete = async (workspace: WorkspaceInfo) => {
        const confirmed = await requestConfirmation({
            title: t('workspaces.deleteTitle').replace('{{name}}', nameOf(workspace)),
            description: t('workspaces.deleteDesc'),
            confirmLabel: t('common.delete'),
            cancelLabel: t('common.cancel'),
        });
        if (!confirmed) return;
        await run('Workspace delete failed', () => deleteWorkspace(workspace.id));
    };

    const disabled = busy || switching;

    return (
        <section className="space-y-3" data-settings-workspaces>
            <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                    <FolderOpen className="h-4 w-4 text-primary" aria-hidden="true" />
                    {t('workspaces.title')}
                </h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('workspaces.description')}</p>
            </div>
            {!list.available ? (
                <p className="text-xs text-muted-foreground" role="status">
                    {t(list.unreadable ? 'workspaces.unreadable' : 'workspaces.unavailable')}
                </p>
            ) : (
                <>
                    <ul className="divide-y divide-border rounded-lg border border-border">
                        {list.workspaces.map((workspace) => {
                            const isActive = workspace.id === list.activeId;
                            const isEditing = editing?.id === workspace.id;
                            return (
                                <li key={workspace.id} className="space-y-2 p-3" data-workspace-row={workspace.id}>
                                    {isEditing && editing ? (
                                        <div className="flex flex-wrap items-center gap-2">
                                            <input
                                                autoFocus
                                                value={editing.name}
                                                maxLength={64}
                                                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                                                onKeyDown={(event) => {
                                                    if (event.key === 'Enter') void handleRename();
                                                    if (event.key === 'Escape') setEditing(null);
                                                }}
                                                aria-label={t('workspaces.namePlaceholder')}
                                                placeholder={t('workspaces.namePlaceholder')}
                                                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm"
                                            />
                                            <ColorPicker
                                                value={editing.color}
                                                onChange={(color) => setEditing({ ...editing, color })}
                                                label={t('workspaces.title')}
                                            />
                                            <button
                                                type="button"
                                                onClick={() => void handleRename()}
                                                disabled={disabled || !editing.name.trim()}
                                                className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                                            >
                                                {t('common.save')}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setEditing(null)}
                                                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                                            >
                                                {t('common.cancel')}
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                                                <span
                                                    className={cn('inline-block h-2.5 w-2.5 shrink-0 rounded-full', !workspace.color && 'bg-muted-foreground/40')}
                                                    style={workspace.color ? { backgroundColor: workspace.color } : undefined}
                                                    aria-hidden="true"
                                                />
                                                <span className="truncate">{nameOf(workspace)}</span>
                                                {isActive && (
                                                    <span className="rounded-full bg-primary/10 px-2 text-[11px] font-semibold text-primary">
                                                        {t('workspaces.open')}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="flex shrink-0 items-center gap-1.5">
                                                {!isActive && (
                                                    <button
                                                        type="button"
                                                        onClick={() => void requestSwitch(workspace)}
                                                        disabled={disabled}
                                                        className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                                                        data-workspace-switch
                                                    >
                                                        {t('workspaces.switch')}
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => setEditing({ id: workspace.id, name: nameOf(workspace), color: workspace.color })}
                                                    disabled={disabled}
                                                    className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-60"
                                                >
                                                    {t('common.rename')}
                                                </button>
                                                {!isActive && !workspace.isDefault && (
                                                    <button
                                                        type="button"
                                                        onClick={() => void handleDelete(workspace)}
                                                        disabled={disabled}
                                                        className="rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-60"
                                                        data-workspace-delete
                                                    >
                                                        {t('common.delete')}
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                    <p className="break-all text-[11px] text-muted-foreground">
                                        {t('workspaces.dataFolder')}: <span className="select-text font-mono">{workspace.dataDir}</span>
                                    </p>
                                </li>
                            );
                        })}
                    </ul>
                    <div className="flex flex-wrap items-center gap-2">
                        <input
                            value={newName}
                            maxLength={64}
                            onChange={(event) => setNewName(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') void handleAdd();
                            }}
                            aria-label={t('workspaces.namePlaceholder')}
                            placeholder={t('workspaces.namePlaceholder')}
                            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm"
                            data-workspace-name-input
                        />
                        <ColorPicker value={newColor} onChange={setNewColor} label={t('workspaces.title')} />
                        <button
                            type="button"
                            onClick={() => void handleAdd()}
                            disabled={disabled || !newName.trim()}
                            className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                            data-workspace-add
                        >
                            {t('workspaces.add')}
                        </button>
                    </div>
                    <p className="text-[11px] leading-5 text-muted-foreground">{t('workspaces.cliHint')}</p>
                </>
            )}
            {confirmModal}
        </section>
    );
}

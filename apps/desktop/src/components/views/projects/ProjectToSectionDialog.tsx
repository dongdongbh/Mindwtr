import { getProjectAccentColor } from '@mindwtr/core';
import { useId, useMemo, useState } from 'react';
import {
    createProjectToSectionPreviewer,
    formatI18nTemplate,
    prepareProjectToSection,
    tFallback,
    useTaskStore,
    type Project,
} from '@mindwtr/core';
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '../../ui/Dialog';

type Prepared = Extract<ReturnType<typeof prepareProjectToSection>, { ok: true }>;
type Success = Extract<Awaited<ReturnType<ReturnType<typeof useTaskStore.getState>['convertProjectToSection']>>, { success: true }>;

export function ProjectToSectionDialog({ source, projects, onCancel, onSuccess, t }: {
    source: Project;
    projects: Project[];
    onCancel: () => void;
    onSuccess: (result: Success) => void;
    t: (key: string) => string;
}) {
    const titleId = useId();
    const [destinationId, setDestinationId] = useState('');
    const [name, setName] = useState(source.title);
    const [prepared, setPrepared] = useState<Prepared | null>(null);
    const [busy, setBusy] = useState(false);
    const [retryOnly, setRetryOnly] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Typing the section name re-renders; rebuild the destination list only when its inputs change.
    const { _allProjects, _allSections, _allTasks } = useTaskStore.getState();
    const previewDestination = useMemo(() => createProjectToSectionPreviewer({ _allProjects, _allSections, _allTasks }, source.id),
        [_allProjects, _allSections, _allTasks, source.id]);
    const destinations = useMemo(() => projects.filter((project) => previewDestination(project.id).ok),
        [projects, previewDestination]);
    const preview = destinationId ? previewDestination(destinationId) : null;
    const shownPreview = prepared?.preview ?? (preview?.ok ? preview : null);
    const destination = prepared?.command.destination ?? projects.find((project) => project.id === destinationId);
    const sourceForSummary = prepared?.command.source.before ?? source;
    const destinationArea = destination?.areaId
        ? useTaskStore.getState().areas.find((area) => area.id === destination.areaId)
        : undefined;
    const label = tFallback(t, 'projects.convertToSection', 'Convert to section…');
    const blocked = (reason: string) => tFallback(t, `projects.convertBlocked.${reason}`, reason);

    const confirm = () => {
        const next = prepareProjectToSection(useTaskStore.getState(), source.id, destinationId, name);
        if (!next.ok) { setError(blocked(next.reason)); return; }
        setPrepared(next);
        setError(null);
    };
    const save = async () => {
        if (!prepared || busy) return;
        setBusy(true);
        setError(null);
        try {
            const result = await useTaskStore.getState().convertProjectToSection(prepared.command);
            if (result.success) { onSuccess(result); return; }
            setError(tFallback(t, `projects.convertFailure.${result.reason}`, result.reason));
            if (result.reason === 'save-failed') setRetryOnly(true);
            else setPrepared(null);
        } catch {
            setError(tFallback(t, 'projects.convertFailure.save-failed', 'Could not save. Retry the same conversion.'));
            setRetryOnly(true);
        } finally { setBusy(false); }
    };

    return <Dialog labelledBy={titleId} onClose={() => { if (!busy && !retryOnly) onCancel(); }} closeOnBackdrop={!busy && !retryOnly} overlayClassName="p-4">
        <DialogHeader className="px-5 pt-5 pb-4">
            <h3 id={titleId} className="text-lg font-semibold">{label}</h3>
        </DialogHeader>
        <DialogBody className="space-y-4 px-5 pb-5">
            {sourceForSummary.isSequential && <p className="text-sm">{tFallback(t, 'projects.convertBlocked.destination-section-sequence', 'Choose a destination set to Sequential → Within sections. The new section keeps its task sequence; other sections keep progressing independently.')}</p>}
            {!prepared ? <>
                <label className="block text-sm font-medium">
                    {tFallback(t, 'projects.convertDestination', 'Destination project')}
                    <select value={destinationId} onChange={(event) => { setDestinationId(event.target.value); setError(null); }} disabled={busy} className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2">
                        <option value="">{tFallback(t, 'projects.convertChooseDestination', 'Choose a project')}</option>
                        {destinations.map((project) =>
                            <option key={project.id} value={project.id}>{project.title}</option>)}
                    </select>
                </label>
                <label className="block text-sm font-medium">
                    {tFallback(t, 'projects.convertSectionName', 'Section name')}
                    <input value={name} onChange={(event) => { setName(event.target.value); setError(null); }} disabled={busy} className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2" />
                </label>
            </> : null}
            {shownPreview && <div className="space-y-2 text-sm">
                <p>{formatI18nTemplate(tFallback(t, 'projects.convertSummary', 'Move {{count}} tasks ({{completed}} done, {{archived}} archived) from {{source}} into {{destination}}.'), {
                    count: shownPreview.taskCount,
                    completed: shownPreview.completedCount,
                    archived: shownPreview.archivedCount,
                    source: shownPreview.sourceTitle,
                    destination: shownPreview.destinationTitle,
                })}</p>
                {prepared && <p>{formatI18nTemplate(tFallback(t, 'projects.convertNamedSection', 'New section: {{name}}'), { name: prepared.command.section.title })}</p>}
                {sourceForSummary.supportNotes ? <p>{tFallback(t, 'projects.convertNotes', 'Project notes become section notes.')}</p> : null}
                <p>{formatI18nTemplate(tFallback(t, 'projects.convertArea', 'Moved tasks use the destination Area: {{area}}.'), { area: destinationArea?.name ?? tFallback(t, 'projects.noArea', 'No Area') })}</p>
                <p className="flex items-center gap-2"><span className="h-3 w-3 rounded-full border border-border" style={{ backgroundColor: destination ? getProjectAccentColor(destination, new Map(destinationArea ? [[destinationArea.id, destinationArea]] : [])) : undefined }} />{tFallback(t, 'projects.convertDestinationColor', 'Section follows the destination color.')}</p>
                <p>{tFallback(t, 'projects.convertColor', 'The source project color is not carried to the section.')}</p>
                <p>{tFallback(t, 'projects.convertSettings', 'The new section uses the destination project’s settings.')}</p>
                <p>{tFallback(t, 'projects.convertTrash', 'The source project moves to Trash. Already-deleted tasks stay in Trash.')}</p>
            </div>}
            {preview && !preview.ok && <p role="alert" className="text-sm text-destructive">{blocked(preview.reason)}</p>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </DialogBody>
        <DialogFooter className="flex justify-end gap-2 border-t border-border px-5 py-4">
            <button type="button" disabled={busy || retryOnly} onClick={prepared ? () => { setPrepared(null); setError(null); } : onCancel} className="rounded-lg border border-border px-4 py-2 disabled:opacity-50">{prepared ? tFallback(t, 'common.back', 'Back') : t('common.cancel')}</button>
            <button type="button" disabled={busy || (!prepared && (!preview?.ok || !name.trim()))} aria-busy={busy} onClick={() => { if (prepared) void save(); else confirm(); }} className="rounded-lg bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{prepared ? (error ? tFallback(t, 'common.retry', 'Retry') : label) : tFallback(t, 'common.next', 'Next')}</button>
        </DialogFooter>
    </Dialog>;
}

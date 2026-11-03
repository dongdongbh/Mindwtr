import { useId, useState } from 'react';
import { tFallback, type ViewSectionDefinition } from '@mindwtr/core';

import { Dialog, DialogBody, DialogFooter, DialogHeader } from '../../ui/Dialog';
import { SomedaySectionSelector } from '../../ui/SomedaySectionSelector';
import {
    SomedaySectionMoveSaveError,
    type SomedaySectionMove,
} from '../../../lib/someday-section-move';

type Props = {
    sections: readonly ViewSectionDefinition[];
    selectedCount: number;

    description?: string;
    initialSectionId?: string;
    t: (key: string) => string;
    onCreateSection: (title: string) => Promise<string | null>;
    onApply: (sectionId: string | undefined, pendingMove?: SomedaySectionMove) => Promise<void>;
    onCancel: () => void;
};


export function SomedaySectionMoveDialog({
    sections,
    selectedCount,
    description,
    initialSectionId,
    t,
    onCreateSection,
    onApply,
    onCancel,
}: Props) {
    const titleId = useId();
    const pickerId = useId();
    const descriptionId = useId();
    const [sectionId, setSectionId] = useState<string | undefined>(initialSectionId);
    const [pendingMove, setPendingMove] = useState<SomedaySectionMove>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const moveLabel = tFallback(t, 'viewSections.moveToSection', 'Move to section…');
    const failureLabel = tFallback(t, 'viewSections.moveFailed', 'Could not move tasks to the section.');

    const create = async (title: string): Promise<string | null> => {
        setBusy(true);
        setError(null);
        try {
            const created = await onCreateSection(title);
            if (!created) setError(tFallback(t, 'viewSections.updateFailed', 'Could not update Someday sections.'));
            return created;
        } catch {
            setError(tFallback(t, 'viewSections.updateFailed', 'Could not update Someday sections.'));
            return null;
        } finally {
            setBusy(false);
        }
    };

    const apply = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            await onApply(sectionId, pendingMove);
        } catch (cause) {
            if (cause instanceof SomedaySectionMoveSaveError) setPendingMove(cause.pendingMove);
            setError(failureLabel);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            onClose={() => { if (!busy) onCancel(); }}
            labelledBy={titleId}
            describedBy={descriptionId}
            closeOnBackdrop={!busy}
            overlayClassName="p-4"
        >
            <DialogHeader className="space-y-1 px-5 pt-5 pb-4">
                <h3 id={titleId} className="text-lg font-semibold tracking-tight">{moveLabel}</h3>
                <p id={descriptionId} className="text-sm text-muted-foreground">{description ?? `${selectedCount} ${t('bulk.selected')}`}</p>
            </DialogHeader>
            <DialogBody className="space-y-2 px-5 pb-5">
                <label htmlFor={pickerId} className="block text-sm font-medium">
                    {tFallback(t, 'viewSections.somedaySection', 'Someday section')}
                </label>
                <SomedaySectionSelector
                    id={pickerId}
                    sections={sections}
                    value={sectionId}
                    disabled={busy || Boolean(pendingMove)}
                    onChange={(next) => { setSectionId(next); setError(null); }}
                    onCreateSection={create}
                    t={t}
                    className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                />
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            </DialogBody>
            <DialogFooter className="flex justify-end gap-2 border-t border-border bg-muted/20 px-5 py-4">
                <button type="button" onClick={onCancel} disabled={busy} className="min-h-10 min-w-20 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
                    {pendingMove ? tFallback(t, 'common.close', 'Close') : t('common.cancel')}
                </button>
                <button type="button" onClick={() => { void apply(); }} disabled={busy} aria-busy={busy} className="min-h-10 min-w-20 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
                    {pendingMove ? tFallback(t, 'common.retry', 'Retry') : t('common.save')}
                </button>
            </DialogFooter>
        </Dialog>
    );
}

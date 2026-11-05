import type { ChecklistItem, TaskChecklistEdit } from '@mindwtr/core';

type EditorRow = { identity: string; item: ChecklistItem };


export class ChecklistEditorRows {
    private serial = 0;
    private rows: EditorRow[] = [];
    constructor(private readonly sessionId?: string) {}
    private newIdentity() { return `${this.sessionId ?? 'checklist'}-row-${++this.serial}`; }

    sync(items: readonly ChecklistItem[]): readonly EditorRow[] {
        const remaining = new Set(this.rows);
        const match = (item: ChecklistItem) => {
            const row = [...remaining].find((candidate) => candidate.item === item)
                ?? [...remaining].find((candidate) => candidate.item.id === item.id
                    && candidate.item.title === item.title && candidate.item.isCompleted === item.isCompleted)
                ?? [...remaining].find((candidate) => candidate.item.id === item.id);
            if (row) remaining.delete(row);
            return { identity: row?.identity ?? this.newIdentity(), item };
        };
        this.rows = items.map(match);
        return this.rows;
    }

    apply(items: readonly ChecklistItem[], edit: TaskChecklistEdit): readonly EditorRow[] {
        const ordered = [...this.rows];
        if (edit.kind === 'move') {
            const [row] = ordered.splice(edit.from, 1);
            if (row) ordered.splice(edit.to, 0, row);
        } else if (edit.kind === 'remove') {
            ordered.splice(edit.index, 1);
        } else if (edit.kind === 'rename' || edit.kind === 'insertAfter') {
            const added = items.length - ordered.length;
            if (added > 0) {
                const inserted = items.slice(edit.index + 1, edit.index + 1 + added)
                    .map((item) => ({ identity: this.newIdentity(), item }));
                ordered.splice(edit.index + 1, 0, ...inserted);
            }
        }
        this.rows = ordered.map((row, index) => ({ ...row, item: items[index] ?? row.item }));
        return this.sync(items);
    }
}

export function checklistDropIndex(centers: readonly number[], pointer: number): number {
    if (centers.length === 0) return -1;
    let nearest = 0;
    for (let index = 1; index < centers.length; index += 1) {
        if (Math.abs(centers[index] - pointer) < Math.abs(centers[nearest] - pointer)) nearest = index;
    }
    return nearest;
}

export function checklistEdgeScroll(pointer: number, top: number, bottom: number): number {
    const edge = Math.min(72, (bottom - top) / 4);
    if (pointer < top + edge) return -Math.min(16, Math.max(0, top + edge - pointer) / 4);
    if (pointer > bottom - edge) return Math.min(16, Math.max(0, pointer - bottom + edge) / 4);
    return 0;
}

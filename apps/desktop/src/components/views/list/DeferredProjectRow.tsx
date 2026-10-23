import { getProjectAccentColor } from '@mindwtr/core';
import { Folder } from 'lucide-react';
import { DEFAULT_AREA_COLOR, tFallback, type Area, type Project } from '@mindwtr/core';

type Props = {
    project: Project;
    area?: Area;
    t: (key: string) => string;
    onOpen: (projectId: string) => void;
    onReactivate: (projectId: string) => void;
    /** Shows "Move to section…" when given (Someday section grouping, #1319). */
    onMoveToSection?: (projectId: string) => void;
};

/** A project parked in Someday or Waiting: open it, move it to a section, or reactivate it. */
export function DeferredProjectRow({ project, area, t, onOpen, onReactivate, onMoveToSection }: Props) {
    return (
        <div className="flex w-full items-center justify-between gap-3 rounded-md border border-border/60 bg-background px-3 py-2">
            <button
                type="button"
                onClick={() => onOpen(project.id)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-primary"
                aria-label={`${tFallback(t, 'projects.title', 'Project')}: ${project.title}`}
            >
                <Folder className="h-4 w-4 shrink-0" style={{ color: getProjectAccentColor(project, new Map(area ? [[area.id, area]] : [])) }} />
                <span className="truncate text-sm font-medium text-foreground">{project.title}</span>
                {area && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: area.color || DEFAULT_AREA_COLOR }}
                        />
                        {area.name}
                    </span>
                )}
            </button>
            {onMoveToSection && (
                <button
                    type="button"
                    onClick={() => onMoveToSection(project.id)}
                    className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                >
                    {tFallback(t, 'viewSections.moveToSection', 'Move to section…')}
                </button>
            )}
            <button
                type="button"
                onClick={() => onReactivate(project.id)}
                className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            >
                {t('projects.reactivate')}
            </button>
        </div>
    );
}

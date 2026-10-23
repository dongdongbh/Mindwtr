import { getProjectAccentColor, type Area } from '@mindwtr/core';
import type { ReactNode } from 'react';
import { safeFormatDate, type Project, tFallback } from '@mindwtr/core';
import { ChevronDown, ChevronRight, Folder, type LucideIcon } from 'lucide-react';

import { cn } from '../../../lib/utils';

type AgendaCollapsibleSectionProps = {
    children: ReactNode;
    color: string;
    controlsId: string;
    count: number;
    expanded: boolean;
    icon: LucideIcon;
    onToggle: () => void;
    title: string;
};

export function AgendaCollapsibleSection({
    children,
    color,
    controlsId,
    count,
    expanded,
    icon: Icon,
    onToggle,
    title,
}: AgendaCollapsibleSectionProps) {
    return (
        <div className="space-y-3">
            <h3>
                <button
                    type="button"
                    onClick={onToggle}
                    aria-expanded={expanded}
                    aria-controls={controlsId}
                    className={cn(
                        'flex w-full items-center gap-2 rounded-md text-left font-semibold transition-colors',
                        'focus:outline-none focus:ring-2 focus:ring-primary/30',
                        color,
                    )}
                >
                    {expanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                    <Icon className="h-5 w-5" />
                    <span>{title}</span>
                    <span className="font-normal text-muted-foreground">({count})</span>
                </button>
            </h3>
            {expanded ? <div id={controlsId}>{children}</div> : null}
        </div>
    );
}

type AgendaProjectSectionProps = {
    color: string;
    controlsId: string;
    expanded: boolean;
    icon: LucideIcon;
    onToggle: () => void;
    onProjectPress: (projectId: string) => void;
    projects: Project[];
    areaById?: Map<string, Area>;
    t: (key: string) => string;
    title: string;
};

export function AgendaProjectSection({
    color,
    controlsId,
    expanded,
    icon: Icon,
    onToggle,
    onProjectPress,
    projects,
    areaById = new Map(),
    t,
    title,
}: AgendaProjectSectionProps) {
    if (projects.length === 0) return null;

    return (
        <AgendaCollapsibleSection
            color={color}
            controlsId={controlsId}
            count={projects.length}
            expanded={expanded}
            icon={Icon}
            onToggle={onToggle}
            title={title}
        >
            <div className="space-y-2">
                {projects.map((project) => (
                    <button
                        key={project.id}
                        type="button"
                        aria-label={`${tFallback(t, 'common.open', 'Open')} ${project.title}`}
                        onClick={() => onProjectPress(project.id)}
                        className={cn(
                            'flex w-full items-center justify-between rounded-lg border border-border bg-card/80 px-3 py-2 text-left',
                            'transition-colors hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-primary/30',
                        )}
                    >
                        <div className="flex items-center gap-2">
                            <Folder className="h-4 w-4" style={{ color: getProjectAccentColor(project, areaById) }} />
                            <span className="text-sm font-medium text-foreground">{project.title}</span>
                            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                                {t(`status.${project.status}`)}
                            </span>
                        </div>
                        {project.reviewAt && (
                            <span className="text-xs text-muted-foreground">
                                {safeFormatDate(project.reviewAt, 'P')}
                            </span>
                        )}
                    </button>
                ))}
            </div>
        </AgendaCollapsibleSection>
    );
}

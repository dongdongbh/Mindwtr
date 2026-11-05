import type { ReactNode } from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import type { Project, Task } from '@mindwtr/core';
import { cn } from '../../../lib/utils';
import type { TaskGroup } from './next-grouping';

type GroupedTaskSectionsProps = {
    groups: TaskGroup[];
    renderTask: (task: Task, group: TaskGroup) => ReactNode;

    onToggleGroup?: (groupId: string) => void;
    collapsedGroupIds?: Set<string>;
    getSectionDomId?: (group: TaskGroup, index: number) => string | undefined;
    onAddTaskToGroup?: (group: TaskGroup) => void;
    addTaskLabel?: (group: TaskGroup) => string | undefined;

    renderProject?: (project: Project) => ReactNode;
};

type GroupedTaskListProps = GroupedTaskSectionsProps & {
    renderTask: (task: Task, group?: TaskGroup) => ReactNode;

    tasks: Task[];

    virtualRows?: GroupedVirtualRow[] | null;

    virtualizer?: Virtualizer<HTMLDivElement, Element> | null;

    flatRowClassName?: string;
};

export type GroupedVirtualRow =
    | {
        kind: 'header';
        group: TaskGroup;
        collapsed: boolean;
        controlsId?: string;
    }
    | {
        kind: 'task';
        group: TaskGroup;
        task: Task;
        isFirst: boolean;
        isLast: boolean;
        controlsId?: string;
    };

export function buildGroupedVirtualRows(
    groups: TaskGroup[],
    collapsedGroupIds: ReadonlySet<string>,
    getSectionDomId?: (group: TaskGroup, index: number) => string | undefined,
): GroupedVirtualRow[] {
    return groups.flatMap((group, groupIndex) => {
        const collapsed = collapsedGroupIds.has(group.id);
        const controlsId = getSectionDomId?.(group, groupIndex);
        const header: GroupedVirtualRow = {
            kind: 'header',
            group,
            collapsed,
            controlsId,
        };
        if (collapsed) return [header];
        return [
            header,
            ...group.tasks.map((task, index): GroupedVirtualRow => ({
                kind: 'task',
                group,
                task,
                isFirst: index === 0,
                isLast: index === group.tasks.length - 1,
                controlsId,
            })),
        ];
    });
}


export function flattenVisibleGroupTasks(
    groups: TaskGroup[],
    collapsedGroupIds: ReadonlySet<string>,
): Task[] {
    const seen = new Set<string>();
    const tasks: Task[] = [];
    groups.forEach((group) => {
        if (collapsedGroupIds.has(group.id)) return;
        group.tasks.forEach((task) => {
            if (seen.has(task.id)) return;
            seen.add(task.id);
            tasks.push(task);
        });
    });
    return tasks;
}

type GroupedTaskSectionHeaderProps = {
    group: TaskGroup;
    collapsed: boolean;
    controlsId?: string;
    onToggleGroup?: (groupId: string) => void;
    className?: string;
    onAddTaskToGroup?: (group: TaskGroup) => void;
    addTaskLabel?: (group: TaskGroup) => string | undefined;
};


const groupRowCount = (group: { tasks: readonly unknown[]; projects?: readonly unknown[] }) => (
    group.tasks.length + (group.projects?.length ?? 0)
);

export function GroupedTaskSectionHeader({
    group,
    collapsed,
    controlsId,
    onToggleGroup,
    className,
    onAddTaskToGroup,
    addTaskLabel,
}: GroupedTaskSectionHeaderProps) {
    const collapsible = Boolean(onToggleGroup) && groupRowCount(group) > 0;
    const title = (
        <span className="inline-flex min-w-0 items-center gap-1.5">
            {collapsible && (
                collapsed ? (
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                ) : (
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                )
            )}
            {group.dotColor && (
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: group.dotColor }} aria-hidden="true" />
            )}
            <span className="truncate">{group.title}</span>
        </span>
    );

    const addLabel = addTaskLabel?.(group);
    if (onAddTaskToGroup && addLabel) {
        return (
            <div className={cn(
                'flex items-center gap-2 border-b border-border/30 px-3 py-2 text-xs font-semibold uppercase tracking-wide',
                group.muted ? 'text-muted-foreground' : 'text-foreground/90',
                className,
            )}>
                {collapsible ? (
                    <button
                        type="button"
                        onClick={() => onToggleGroup?.(group.id)}
                        aria-expanded={!collapsed}
                        aria-controls={controlsId}
                        className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >{title}</button>
                ) : <div className="min-w-0 flex-1">{title}</div>}
                <span className="shrink-0 text-muted-foreground">{groupRowCount(group)}</span>
                <button
                    type="button"
                    onClick={() => onAddTaskToGroup(group)}
                    aria-label={addLabel}
                    title={addLabel}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                </button>
            </div>
        );
    }

    return collapsible ? (
        <button
            type="button"
            onClick={() => onToggleGroup?.(group.id)}
            aria-expanded={!collapsed}
            aria-controls={controlsId}
            className={cn(
                'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide transition-colors hover:bg-muted/30',
                'focus:outline-none focus:ring-2 focus:ring-primary/30',
                !collapsed && 'border-b border-border/30',
                group.muted ? 'text-muted-foreground' : 'text-foreground/90',
                className,
            )}
        >
            {title}
            <span className="shrink-0 text-muted-foreground">{groupRowCount(group)}</span>
        </button>
    ) : (
        <div className={cn(
            'flex items-center justify-between gap-3 border-b border-border/30 px-3 py-2 text-xs font-semibold uppercase tracking-wide',
            group.muted ? 'text-muted-foreground' : 'text-foreground/90',
            className,
        )}>
            {title}
            <span className="shrink-0 text-muted-foreground">{groupRowCount(group)}</span>
        </div>
    );
}


const SECTION_CARD = 'border-x border-border/40 bg-card/30';
const SECTION_HEADER_CARD = 'border border-border/40 bg-card/30';

function GroupProjects({ group, renderProject, className }: {
    group: TaskGroup;
    renderProject?: (project: Project) => ReactNode;
    className?: string;
}) {
    if (!renderProject || !group.projects?.length) return null;
    return (
        <div className={cn('space-y-2 p-2', className)}>
            {group.projects.map((project) => <div key={project.id}>{renderProject(project)}</div>)}
        </div>
    );
}


export function GroupedTaskList({
    groups,
    tasks,
    renderTask,
    virtualRows,
    virtualizer,
    collapsedGroupIds,
    onToggleGroup,
    getSectionDomId,
    onAddTaskToGroup,
    addTaskLabel,
    renderProject,
    flatRowClassName = 'pb-1.5',
}: GroupedTaskListProps) {
    const isGrouping = Boolean(virtualRows);

    if (virtualizer) {
        return (
            <div
                data-testid="virtualized-task-list"
                data-grouped={isGrouping ? 'true' : 'false'}
                style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
            >
                {virtualizer.getVirtualItems().map((virtualRow) => {
                    const row = virtualRows?.[virtualRow.index];
                    const rowStyle = {
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${virtualRow.start}px)`,
                    } as const;
                    if (row?.kind === 'header') {
                        return (
                            <div
                                key={virtualRow.key}
                                ref={virtualizer.measureElement}
                                data-index={virtualRow.index}
                                style={{ ...rowStyle, paddingTop: virtualRow.index > 0 ? 8 : 0 }}
                            >
                                <GroupedTaskSectionHeader
                                    group={row.group}
                                    collapsed={row.collapsed}
                                    controlsId={row.controlsId}
                                    onToggleGroup={onToggleGroup}
                                    onAddTaskToGroup={onAddTaskToGroup}
                                    addTaskLabel={addTaskLabel}
                                    className={cn(
                                        SECTION_HEADER_CARD,
                                        row.collapsed ? 'rounded-md' : 'rounded-t-md',
                                    )}
                                />
                                {!row.collapsed && (
                                    <GroupProjects
                                        group={row.group}
                                        renderProject={renderProject}
                                        className={cn(SECTION_CARD, row.group.tasks.length === 0 && 'rounded-b-md border-b border-border/40')}
                                    />
                                )}
                            </div>
                        );
                    }
                    const task = row?.kind === 'task' ? row.task : tasks[virtualRow.index];
                    if (!task) return null;
                    return (
                        <div
                            key={virtualRow.key}
                            ref={virtualizer.measureElement}
                            data-index={virtualRow.index}
                            style={rowStyle}
                        >
                            <div
                                id={row?.kind === 'task' && row.isFirst ? row.controlsId : undefined}
                                className={cn(row?.kind === 'task'
                                    ? [
                                        SECTION_CARD,
                                        !row.isLast && 'border-b border-border/30',
                                        row.isLast && 'rounded-b-md border-b border-border/40',
                                    ]
                                    : flatRowClassName)}
                            >
                                {renderTask(task, row?.group)}
                                {!row && <div className="mx-3 mt-1 h-px bg-border/30" />}
                            </div>
                        </div>
                    );
                })}
            </div>
        );
    }

    if (isGrouping) {
        return (
            <GroupedTaskSections
                groups={groups}
                renderTask={renderTask}
                onToggleGroup={onToggleGroup}
                collapsedGroupIds={collapsedGroupIds}
                getSectionDomId={getSectionDomId}
                onAddTaskToGroup={onAddTaskToGroup}
                addTaskLabel={addTaskLabel}
                renderProject={renderProject}
            />
        );
    }

    return (
        <div className="divide-y divide-border/30">
            {tasks.map((task) => renderTask(task))}
        </div>
    );
}


export function GroupedTaskSections({
    groups,
    renderTask,
    onToggleGroup,
    collapsedGroupIds,
    getSectionDomId,
    onAddTaskToGroup,
    addTaskLabel,
    renderProject,
}: GroupedTaskSectionsProps) {
    const collapsible = Boolean(onToggleGroup);
    return (
        <div className="space-y-2">
            {groups.map((group, groupIndex) => {
                const collapsed = collapsible && (collapsedGroupIds?.has(group.id) ?? false);
                const controlsId = collapsible ? getSectionDomId?.(group, groupIndex) : undefined;
                return (
                    <div key={group.id} className={cn('rounded-md', SECTION_HEADER_CARD)}>
                        <GroupedTaskSectionHeader
                            group={group}
                            collapsed={collapsed}
                            controlsId={controlsId}
                            onToggleGroup={onToggleGroup}
                            onAddTaskToGroup={onAddTaskToGroup}
                            addTaskLabel={addTaskLabel}
                        />
                        {!collapsed && (
                            <div id={controlsId} className="divide-y divide-border/30">
                                <GroupProjects group={group} renderProject={renderProject} />
                                {group.tasks.map((task) => renderTask(task, group))}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

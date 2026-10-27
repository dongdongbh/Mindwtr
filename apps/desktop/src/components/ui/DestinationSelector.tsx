import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
    compareAreasByOrder,
    isSelectableProjectForTaskAssignment,
    numericTextCollator,
    type Area,
    type Project,
    type TaskMoveDestination,
} from '@mindwtr/core';
import { ChevronDown, Folder, MapPin, Plus } from 'lucide-react';

import { cn } from '../../lib/utils';
import { ModalPortal } from '../ModalPortal';
import { useDropdownPosition } from './use-dropdown-position';

type DestinationSelectorProps = {
    projects: Project[];
    areas: Area[];
    /** Null presents an action picker without implying a current assignment. */
    value: TaskMoveDestination | null;
    onChange: (value: TaskMoveDestination) => void;
    onCreateProject?: (title: string) => Promise<string | null>;
    onCreateArea?: (name: string) => Promise<string | null>;
    destinationLabel: string;
    projectsLabel: string;
    areasLabel: string;
    noneLabel: string;
    searchPlaceholder: string;
    noMatchesLabel: string;
    createProjectLabel: string;
    createAreaLabel: string;
    showProjects?: boolean;
    showAreas?: boolean;
    disabled?: boolean;
    className?: string;
    controlClassName?: string;
    menuClassName?: string;
};

export function DestinationSelector({
    projects,
    areas,
    value,
    onChange,
    onCreateProject,
    onCreateArea,
    destinationLabel,
    projectsLabel,
    areasLabel,
    noneLabel,
    searchPlaceholder,
    noMatchesLabel,
    createProjectLabel,
    createAreaLabel,
    showProjects = true,
    showAreas = true,
    disabled = false,
    className,
    controlClassName,
    menuClassName,
}: DestinationSelectorProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [creating, setCreating] = useState<'project' | 'area' | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const restoreFocusRef = useRef(false);
    const mountedRef = useRef(true);
    const attemptRef = useRef(0);
    const [searchFocused, setSearchFocused] = useState(false);
    const optionIdPrefix = useId();
    const { fixedDropdownStyle, listMaxHeight } = useDropdownPosition({
        open,
        containerRef,
        dropdownRef,
    });

    const sortedProjects = useMemo(
        () => projects
            .filter(isSelectableProjectForTaskAssignment)
            .sort((left, right) => numericTextCollator.compare(left.title, right.title)),
        [projects],
    );
    const sortedAreas = useMemo(
        () => areas.filter((area) => !area.deletedAt).sort(compareAreasByOrder),
        [areas],
    );
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const filteredProjects = useMemo(
        () => !showProjects
            ? []
            : normalizedQuery
                ? sortedProjects.filter((project) => project.title.toLocaleLowerCase().includes(normalizedQuery))
                : sortedProjects,
        [normalizedQuery, showProjects, sortedProjects],
    );
    const filteredAreas = useMemo(
        () => !showAreas
            ? []
            : normalizedQuery
                ? sortedAreas.filter((area) => area.name.toLocaleLowerCase().includes(normalizedQuery))
                : sortedAreas,
        [normalizedQuery, showAreas, sortedAreas],
    );
    const selectedProject = value?.kind === 'project'
        ? projects.find((project) => project.id === value.id)
        : undefined;
    const selectedArea = value?.kind === 'area'
        ? areas.find((area) => area.id === value.id)
        : undefined;
    const selectedLabel = value === null ? destinationLabel : selectedProject?.title ?? selectedArea?.name ?? noneLabel;

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    useEffect(() => {
        if (!open) return;
        const handleMouseDown = (event: MouseEvent) => {
            const target = event.target as Node;
            if (!containerRef.current?.contains(target) && !dropdownRef.current?.contains(target)) {
                attemptRef.current += 1;
                setCreating(null);
                setOpen(false);
                setQuery('');
            }
        };
        document.addEventListener('mousedown', handleMouseDown);
        return () => document.removeEventListener('mousedown', handleMouseDown);
    }, [open]);

    const closeDropdown = () => {
        attemptRef.current += 1;
        setCreating(null);
        setOpen(false);
        setQuery('');
        restoreFocusRef.current = true;
    };

    useEffect(() => {
        if (open || disabled || !restoreFocusRef.current) return;
        restoreFocusRef.current = false;
        triggerRef.current?.focus();
    }, [disabled, open]);

    const choose = (selection: TaskMoveDestination) => {
        onChange(selection);
        closeDropdown();
    };

    const selectableOptions = () => Array.from(
        dropdownRef.current?.querySelectorAll<HTMLButtonElement>('[data-destination-option="true"]:not(:disabled)') ?? [],
    );
    const moveOptionFocus = (direction: 1 | -1) => {
        const options = selectableOptions();
        if (options.length === 0) return;
        const currentIndex = options.findIndex((option) => option === document.activeElement);
        const nextIndex = currentIndex < 0
            ? (direction > 0 ? 0 : options.length - 1)
            : (currentIndex + direction + options.length) % options.length;
        options[nextIndex]?.focus();
    };
    const handleDropdownKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeDropdown();
            return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            moveOptionFocus(event.key === 'ArrowDown' ? 1 : -1);
        }
    };
    const handleCreate = async (kind: 'project' | 'area') => {
        const name = query.trim();
        const create = kind === 'project' ? onCreateProject : onCreateArea;
        if (!name || !create || creating || disabled) return;
        const attempt = attemptRef.current + 1;
        attemptRef.current = attempt;
        setCreating(kind);
        try {
            const id = await create(name);
            if (mountedRef.current && attemptRef.current === attempt && id) choose({ kind, id });
        } catch {
            // Creation owns its user-facing error reporting. Keep this selector
            // open and prevent a rejected callback from becoming unhandled.
        } finally {
            if (mountedRef.current && attemptRef.current === attempt) setCreating(null);
        }
    };

    const hasMatches = filteredProjects.length > 0 || filteredAreas.length > 0;
    const canCreateProject = showProjects
        && Boolean(onCreateProject)
        && Boolean(normalizedQuery)
        && !sortedProjects.some((project) => project.title.trim().toLocaleLowerCase() === normalizedQuery);
    const canCreateArea = showAreas
        && Boolean(onCreateArea)
        && Boolean(normalizedQuery)
        // Against the live areas only: a deleted area's name is free again.
        && !sortedAreas.some((area) => area.name.trim().toLocaleLowerCase() === normalizedQuery);

    // Enter matches ui/ProjectSelector: an empty search picks nothing (it used
    // to file the draft under the alphabetically first project), and with no
    // match it runs the create action only when exactly one is on offer.
    const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== 'Enter' || !normalizedQuery) return;
        const firstProject = filteredProjects[0];
        const firstArea = filteredAreas[0];
        if (firstProject || firstArea) {
            event.preventDefault();
            if (firstProject) choose({ kind: 'project', id: firstProject.id });
            else if (firstArea) choose({ kind: 'area', id: firstArea.id });
            return;
        }
        if (canCreateProject === canCreateArea) return;
        event.preventDefault();
        void handleCreate(canCreateProject ? 'project' : 'area');
    };

    // While searching, the list runs matches (projects, then areas), the create
    // rows, then None, and the row Enter picks is highlighted (#1461).
    const searching = Boolean(normalizedQuery);
    const enterTargetKey = !searching
        ? undefined
        : filteredProjects[0]
            ? `project-${filteredProjects[0].id}`
            : filteredAreas[0]
                ? `area-${filteredAreas[0].id}`
                : canCreateProject !== canCreateArea
                    ? (canCreateProject ? 'create-project' : 'create-area')
                    : undefined;
    const optionId = (key: string) => `${optionIdPrefix}-${key}`;
    const optionClassName = (key: string, selected: boolean) => cn(
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted focus:outline-none focus:bg-muted disabled:opacity-50',
        selected && 'bg-muted font-medium',
        searchFocused && key === enterTargetKey && 'bg-primary/10 text-primary',
    );

    const renderOption = (
        key: string,
        label: string,
        selection: TaskMoveDestination,
        icon: typeof Folder,
    ) => {
        const selected = value !== null && selection.kind === value.kind
            && (selection.kind === 'none' || selection.id === (value.kind === 'none' ? undefined : value.id));
        const Icon = icon;
        return (
            <button
                key={key}
                id={optionId(key)}
                type="button"
                role="option"
                aria-selected={selected}
                data-destination-option="true"
                disabled={Boolean(creating)}
                onClick={() => choose(selection)}
                className={optionClassName(key, selected)}
            >
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate">{label}</span>
            </button>
        );
    };
    const renderCreate = (kind: 'project' | 'area') => {
        const key = `create-${kind}`;
        return (
            <button
                key={key}
                id={optionId(key)}
                type="button"
                role="option"
                aria-selected={false}
                data-destination-option="true"
                disabled={Boolean(creating)}
                onClick={() => void handleCreate(kind)}
                className={optionClassName(key, false)}
            >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {kind === 'project' ? createProjectLabel : createAreaLabel}: “{query.trim()}”
            </button>
        );
    };
    const noneOption = renderOption('none', noneLabel, { kind: 'none' }, MapPin);

    return (
        <div ref={containerRef} className={cn('relative', className)} aria-busy={Boolean(creating) || undefined}>
            <button
                ref={triggerRef}
                type="button"
                aria-label={destinationLabel}
                aria-haspopup="listbox"
                aria-expanded={open}
                disabled={disabled}
                onClick={() => {
                    if (open) {
                        closeDropdown();
                        return;
                    }
                    attemptRef.current += 1;
                    setCreating(null);
                    setOpen(true);
                }}
                onKeyDown={(event) => {
                    if (event.key === 'Escape' && open) {
                        event.preventDefault();
                        event.stopPropagation();
                        closeDropdown();
                    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) {
                        event.preventDefault();
                        event.stopPropagation();
                        attemptRef.current += 1;
                        setCreating(null);
                        setOpen(true);
                    }
                }}
                className={cn(
                    'flex w-full items-center justify-between rounded border border-border bg-muted/50 px-2 py-1 text-xs text-foreground',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                    controlClassName,
                )}
            >
                <span className="truncate">{selectedLabel}</span>
                <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden="true" />
            </button>
            {open && (
                <ModalPortal>
                    <div
                        ref={dropdownRef}
                        data-selector-dropdown="true"
                        style={fixedDropdownStyle}
                        className={cn(
                            'z-[70] rounded-md border border-border bg-popover p-1 text-xs text-popover-foreground shadow-lg',
                            menuClassName,
                        )}
                        onKeyDown={handleDropdownKeyDown}
                    >
                        <input
                            autoFocus
                            value={query}
                            disabled={Boolean(creating)}
                            placeholder={searchPlaceholder}
                            aria-label={searchPlaceholder}
                            onChange={(event) => setQuery(event.target.value)}
                            onKeyDown={handleSearchKeyDown}
                            onFocus={() => setSearchFocused(true)}
                            onBlur={() => setSearchFocused(false)}
                            aria-activedescendant={searchFocused && enterTargetKey ? optionId(enterTargetKey) : undefined}
                            className="mb-1 w-full rounded border border-border bg-muted/40 px-2 py-1 text-[inherit]"
                        />
                        <div role="listbox" aria-label={destinationLabel}>
                            <div className="overflow-y-auto" style={{ maxHeight: listMaxHeight }}>
                                {!searching && noneOption}
                                {filteredProjects.length > 0 && (
                                    <div role="group" aria-label={projectsLabel}>
                                        <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                            {projectsLabel}
                                        </div>
                                        {filteredProjects.map((project) => renderOption(
                                            `project-${project.id}`,
                                            project.title,
                                            { kind: 'project', id: project.id },
                                            Folder,
                                        ))}
                                    </div>
                                )}
                                {filteredAreas.length > 0 && (
                                    <div role="group" aria-label={areasLabel}>
                                        <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                            {areasLabel}
                                        </div>
                                        {filteredAreas.map((area) => renderOption(
                                            `area-${area.id}`,
                                            area.name,
                                            { kind: 'area', id: area.id },
                                            MapPin,
                                        ))}
                                    </div>
                                )}
                                {!hasMatches && (
                                    <div className="px-2 py-2 text-muted-foreground">{noMatchesLabel}</div>
                                )}
                            </div>
                            {searching && (
                                <div className="mt-1 border-t border-border pt-1">
                                    {canCreateProject && renderCreate('project')}
                                    {canCreateArea && renderCreate('area')}
                                    {noneOption}
                                </div>
                            )}
                        </div>
                    </div>
                </ModalPortal>
            )}
        </div>
    );
}

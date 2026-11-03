import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Task } from '@mindwtr/core';
import { ChevronDown, Timer } from 'lucide-react';
import { cn } from '../../lib/utils';
import { isImeComposing } from '../../lib/ime';
import { ModalPortal } from '../ModalPortal';
import { useDropdownPosition } from '../ui/use-dropdown-position';

interface PomodoroTaskPickerProps {
    tasks: Task[];
    selectedTaskId?: string;
    onSelect: (taskId: string | undefined) => void;
    label: string;
    timerOnlyLabel: string;
    noTaskLabel: string;
    searchPlaceholder: string;
    noMatchesLabel: string;
}

export function PomodoroTaskPicker({
    tasks,
    selectedTaskId,
    onSelect,
    label,
    timerOnlyLabel,
    noTaskLabel,
    searchPlaceholder,
    noMatchesLabel,
}: PomodoroTaskPickerProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const containerRef = useRef<HTMLDivElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const { fixedDropdownStyle, listMaxHeight } = useDropdownPosition({
        open,
        containerRef,
        dropdownRef,
    });

    const selectedTask = selectedTaskId ? tasks.find((task) => task.id === selectedTaskId) : undefined;
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = useMemo(() => {
        if (!normalizedQuery) return tasks;
        return tasks.filter((task) => task.title.toLowerCase().includes(normalizedQuery));
    }, [tasks, normalizedQuery]);

    useEffect(() => {
        if (!open) return;
        const handleClick = (event: MouseEvent) => {
            const target = event.target as Node;
            if (!containerRef.current?.contains(target) && !dropdownRef.current?.contains(target)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [open]);

    const closeDropdown = () => {
        setOpen(false);
        setQuery('');
    };

    const commitSelection = (taskId: string | undefined) => {
        onSelect(taskId);
        closeDropdown();
    };

    const focusSelectableOption = (direction: 1 | -1) => {
        const options = dropdownRef.current?.querySelectorAll<HTMLButtonElement>('[data-picker-option="true"]');
        if (!options || options.length === 0) return;
        const list = Array.from(options);
        const active = document.activeElement as HTMLElement | null;
        let index = list.findIndex((option) => option === active);
        if (index < 0) index = direction > 0 ? -1 : 0;
        const nextIndex = (index + direction + list.length) % list.length;
        list[nextIndex].focus();
    };

    const handleDropdownKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (isImeComposing(event)) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            closeDropdown();
            return;
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            focusSelectableOption(1);
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            focusSelectableOption(-1);
        }
    };

    const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (isImeComposing(event) || event.key !== 'Enter') return;
        const firstMatch = filtered[0];
        if (!firstMatch) return;
        event.preventDefault();
        commitSelection(firstMatch.id);
    };

    return (
        <div ref={containerRef} className="relative flex-1 min-w-0">
            <button
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                onKeyDown={(event) => {
                    if (event.key === 'Escape' && open) {
                        event.preventDefault();
                        closeDropdown();
                    }
                }}
                aria-label={label}
                aria-haspopup="listbox"
                aria-expanded={open}
                className="w-full flex items-center justify-between gap-2 text-sm bg-background border border-border rounded px-3 py-2 text-foreground"
            >
                <span className="flex items-center gap-1.5 min-w-0">
                    {!selectedTask && <Timer className="w-3.5 h-3.5 opacity-70 shrink-0" />}
                    <span className={cn('truncate', !selectedTask && 'text-muted-foreground')}>
                        {selectedTask?.title ?? timerOnlyLabel}
                    </span>
                </span>
                <ChevronDown className="h-3.5 w-3.5 opacity-70 shrink-0" />
            </button>
            {open && (
                <ModalPortal>
                    <div
                        ref={dropdownRef}
                        style={fixedDropdownStyle}
                        className="z-[70] rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-1 text-sm"
                        onKeyDown={handleDropdownKeyDown}
                    >
                        <input
                            autoFocus
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            onKeyDown={handleSearchKeyDown}
                            placeholder={searchPlaceholder}
                            aria-label={searchPlaceholder}
                            className="w-full mb-1 rounded border border-border bg-muted/40 px-2 py-1 text-[inherit]"
                        />
                        <div role="listbox" aria-label={label}>
                            <button
                                type="button"
                                data-picker-option="true"
                                role="option"
                                aria-selected={!selectedTaskId}
                                onClick={() => commitSelection(undefined)}
                                className={cn(
                                    'w-full text-left px-2 py-1.5 rounded flex items-center gap-1.5 hover:bg-muted/50 focus-visible:bg-muted/50',
                                    !selectedTaskId && 'bg-accent text-accent-foreground'
                                )}
                            >
                                <Timer className="w-3.5 h-3.5 opacity-70 shrink-0" />
                                {timerOnlyLabel}
                            </button>
                            <div className="overflow-y-auto" style={{ maxHeight: listMaxHeight }}>
                                {filtered.map((task) => (
                                    <button
                                        key={task.id}
                                        type="button"
                                        data-picker-option="true"
                                        role="option"
                                        aria-selected={task.id === selectedTaskId}
                                        onClick={() => commitSelection(task.id)}
                                        className={cn(
                                            'w-full text-left px-2 py-1.5 rounded truncate hover:bg-muted/50 focus-visible:bg-muted/50',
                                            task.id === selectedTaskId && 'bg-accent text-accent-foreground'
                                        )}
                                    >
                                        {task.title}
                                    </button>
                                ))}
                                {filtered.length === 0 && (
                                    <div className="px-2 py-1.5 text-muted-foreground">
                                        {normalizedQuery ? noMatchesLabel : noTaskLabel}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </ModalPortal>
            )}
        </div>
    );
}

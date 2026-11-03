import type { FormEvent, RefObject } from 'react';
import type { Area, Project } from '@mindwtr/core';
import { Mic, Plus } from 'lucide-react';
import { TaskInput } from '../../Task/TaskInput';
import { cn } from '../../../lib/utils';

type ListQuickAddProps = {
    t: (key: string) => string;
    value: string;
    onChange: (value: string) => void;
    onSubmit: (event: FormEvent) => void;
    onOpenAudio: () => void;
    onCreateProject: (title: string) => Promise<string | null>;
    inputRef: RefObject<HTMLInputElement | null>;
    projects: Project[];
    areas: Area[];
    contexts: string[];
    contextHistory: readonly string[];
    people: readonly string[];
    onResetCopilot: () => void;
    dense?: boolean;
};

export function ListQuickAdd({
    t,
    value,
    onChange,
    onSubmit,
    onOpenAudio,
    onCreateProject,
    inputRef,
    projects,
    areas,
    contexts,
    contextHistory,
    people,
    onResetCopilot,
    dense = false,
}: ListQuickAddProps) {


    const iconButtonClass = cn(
        "inline-flex items-center justify-center rounded-lg border border-border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        dense ? "h-8 w-8" : "h-9 w-9"
    );
    return (
        <form
            onSubmit={onSubmit}


            className="relative rounded-lg border border-border bg-card shadow-sm transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30"
        >
            <TaskInput
                inputRef={inputRef}
                value={value}
                projects={projects}
                contexts={contexts}
                contextHistory={contextHistory}
                areas={areas}
                people={people}
                onCreateProject={onCreateProject}
                onChange={(next) => {
                    onChange(next);
                    onResetCopilot();
                }}
                onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        inputRef.current?.blur();
                    }
                }}
                placeholder={`${t('nav.addTask')}... ${t('quickAdd.example')}`}
                ariaLabel={t('nav.addTask')}
                className={cn(
                    "w-full rounded-lg border-0 bg-transparent focus:outline-none focus:ring-0",
                    dense ? "min-h-10 py-2 pl-3 pr-24 text-sm" : "min-h-12 py-3 pl-4 pr-24"
                )}
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
                <button
                    type="button"
                    onClick={onOpenAudio}
                    className={cn(iconButtonClass, "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground")}
                    aria-label={t('quickAdd.audioCaptureLabel')}
                >
                    <Mic className="w-4 h-4" />
                </button>
                <button
                    type="submit"
                    disabled={!value.trim()}
                    className={cn(iconButtonClass, "border-primary bg-primary text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50")}
                    aria-label={t('common.add')}
                >
                    <Plus className="w-4 h-4" />
                </button>
            </div>
        </form>
    );
}

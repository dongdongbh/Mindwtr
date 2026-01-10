import { useEffect, useRef, useState } from 'react';
import { useTaskStore, parseQuickAdd, PRESET_CONTEXTS, safeFormatDate, Task } from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import { cn } from '../lib/utils';
import { isTauriRuntime } from '../lib/runtime';
import { TaskInput } from './Task/TaskInput';

export function QuickAddModal() {
    const { addTask, addProject, projects } = useTaskStore();
    const { t } = useLanguage();
    const [isOpen, setIsOpen] = useState(false);
    const [value, setValue] = useState('');
    const [initialProps, setInitialProps] = useState<Partial<Task> | null>(null);
    const lastActiveElementRef = useRef<HTMLElement | null>(null);
    const modalRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!isTauriRuntime()) return;

        let unlisten: (() => void) | undefined;
        const openFromTauri = async () => {
            setIsOpen(true);
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                await invoke<boolean>('consume_quick_add_pending');
            } catch (e) {
                console.error(e);
            }
        };

        const setup = async () => {
            const [{ listen }, { invoke }] = await Promise.all([
                import('@tauri-apps/api/event'),
                import('@tauri-apps/api/core'),
            ]);

            unlisten = await listen('quick-add', () => {
                openFromTauri().catch(console.error);
            });

            const pending = await invoke<boolean>('consume_quick_add_pending');
            if (pending) {
                setIsOpen(true);
            }
        };

        setup().catch(console.error);

        return () => {
            if (unlisten) unlisten();
        };
    }, []);

    useEffect(() => {
        type QuickAddDetail = { initialProps?: Partial<Task>; initialValue?: string };
        const handler: EventListener = (event) => {
            const detail = (event as CustomEvent<QuickAddDetail>).detail;
            setInitialProps(detail?.initialProps ?? null);
            setValue(detail?.initialValue ?? '');
            setIsOpen(true);
        };
        window.addEventListener('mindwtr:quick-add', handler);
        return () => window.removeEventListener('mindwtr:quick-add', handler);
    }, []);

    useEffect(() => {
        if (!isOpen) return;
        lastActiveElementRef.current = document.activeElement as HTMLElement | null;
        if (!value) setValue('');
    }, [isOpen, value]);

    const close = () => {
        setIsOpen(false);
        setInitialProps(null);
        setValue('');
        lastActiveElementRef.current?.focus();
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!value.trim()) return;
        const { title, props, projectTitle } = parseQuickAdd(value, projects);
        const finalTitle = title || value;
        if (!finalTitle.trim()) return;
        const baseProps: Partial<Task> = { ...initialProps, ...props };
        let projectId = baseProps.projectId;
        if (!projectId && projectTitle) {
            const created = await addProject(projectTitle, '#94a3b8');
            projectId = created.id;
        }
        const mergedProps: Partial<Task> = { status: 'inbox', ...baseProps, projectId };
        if (!baseProps.status) mergedProps.status = 'inbox';
        addTask(finalTitle, mergedProps);
        close();
    };

    const scheduledLabel = initialProps?.startTime
        ? safeFormatDate(initialProps.startTime, "MMM d, HH:mm")
        : null;

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 bg-black/50 flex items-start justify-center pt-[20vh] z-50"
            role="button"
            tabIndex={0}
            aria-label={t('common.close')}
            onClick={close}
            onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                if (event.currentTarget !== event.target) return;
                event.preventDefault();
                close();
            }}
        >
            <div
                ref={modalRef}
                className="w-full max-w-lg bg-popover text-popover-foreground rounded-xl border shadow-2xl overflow-hidden flex flex-col"
                role="dialog"
                aria-modal="true"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(event) => {
                    if (event.key !== 'Tab') return;
                    const container = modalRef.current;
                    if (!container) return;
                    const focusable = Array.from(
                        container.querySelectorAll<HTMLElement>(
                            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
                        )
                    ).filter((el) => !el.hasAttribute('disabled'));
                    if (focusable.length === 0) return;
                    const first = focusable[0];
                    const last = focusable[focusable.length - 1];
                    if (!event.shiftKey && document.activeElement === last) {
                        event.preventDefault();
                        first.focus();
                    } else if (event.shiftKey && document.activeElement === first) {
                        event.preventDefault();
                        last.focus();
                    }
                }}
            >
                <div className="px-4 py-3 border-b flex items-center justify-between">
                    <h3 className="font-semibold">{t('nav.addTask')}</h3>
                    <button onClick={close} className="text-sm text-muted-foreground hover:text-foreground">Esc</button>
                </div>
                <form onSubmit={handleSubmit} className="p-4 space-y-2">
                    <TaskInput
                        value={value}
                        autoFocus
                        projects={projects}
                        contexts={PRESET_CONTEXTS}
                        onCreateProject={async (title) => {
                            const created = await addProject(title, '#94a3b8');
                            return created.id;
                        }}
                        onChange={(next) => setValue(next)}
                        onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                                e.preventDefault();
                                close();
                            }
                        }}
                        placeholder={t('nav.addTask')}
                        className={cn(
                            "w-full bg-card border border-border rounded-lg py-3 px-4 shadow-sm focus:ring-2 focus:ring-primary focus:border-transparent transition-all",
                        )}
                    />
                    <p className="text-xs text-muted-foreground">{t('quickAdd.help')}</p>
                    {scheduledLabel && (
                        <p className="text-xs text-muted-foreground">
                            {t('calendar.scheduleAction')}: {scheduledLabel}
                        </p>
                    )}
                    <div className="flex justify-end gap-2 pt-1">
                        <button
                            type="button"
                            onClick={close}
                            className="px-3 py-1.5 rounded-md text-sm bg-muted hover:bg-muted/80"
                        >
                            {t('common.cancel')}
                        </button>
                        <button
                            type="submit"
                            className="px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary/90"
                        >
                            {t('common.save')}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

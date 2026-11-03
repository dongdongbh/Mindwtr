import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Brain, X } from 'lucide-react';
import { getMindSweepGroups, type MindSweepScope, type StoreActionResult, type Task } from '@mindwtr/core';
import { Dialog, DialogBody } from './ui/Dialog';

type MindSweepModalProps = {
    isOpen: boolean;
    onClose: () => void;
    t: (key: string) => string;
    addTask: (title: string, initialProps?: Partial<Task>) => Promise<StoreActionResult>;
};

const INTRO_STEP = -1;

export function MindSweepModal({ isOpen, onClose, t, addTask }: MindSweepModalProps) {
    const [scope, setScope] = useState<MindSweepScope>('all');
    const [stepIndex, setStepIndex] = useState(INTRO_STEP);
    const [draft, setDraft] = useState('');
    const [capturedByGroup, setCapturedByGroup] = useState<Record<string, string[]>>({});
    const [addFailed, setAddFailed] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const startButtonRef = useRef<HTMLButtonElement>(null);
    const finishButtonRef = useRef<HTMLButtonElement>(null);
    const titleId = useId();

    const groups = getMindSweepGroups(scope);
    const isIntro = stepIndex === INTRO_STEP;
    const isSummary = stepIndex >= groups.length;
    const group = !isIntro && !isSummary ? groups[stepIndex] : null;
    const capturedCount = Object.values(capturedByGroup).reduce((sum, items) => sum + items.length, 0);

    useEffect(() => {
        if (!isOpen) return;
        setScope('all');
        setStepIndex(INTRO_STEP);
        setDraft('');
        setCapturedByGroup({});
        setAddFailed(false);
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const handle = window.setTimeout(() => {
            if (group) {
                inputRef.current?.focus();
            } else if (isSummary) {
                finishButtonRef.current?.focus();
            } else {
                startButtonRef.current?.focus();
            }
        }, 50);
        return () => window.clearTimeout(handle);
    }, [group, isOpen, isSummary]);

    const handleAdd = useCallback(async () => {
        const title = draft.trim();
        if (!title || !group) return;
        try {


            const result = await addTask(title, { status: 'inbox' });
            if (!result?.success) {
                setAddFailed(true);
                return;
            }
            setCapturedByGroup((current) => ({
                ...current,
                [group.id]: [...(current[group.id] ?? []), title],
            }));
            setDraft('');
            setAddFailed(false);
            inputRef.current?.focus();
        } catch {
            setAddFailed(true);
        }
    }, [addTask, draft, group]);

    if (!isOpen) return null;

    const scopeOptions: Array<{ value: MindSweepScope; label: string }> = [
        { value: 'all', label: t('mindSweep.scopeAll') },
        { value: 'personal', label: t('mindSweep.scopePersonal') },
        { value: 'work', label: t('mindSweep.scopeWork') },
    ];

    return (
        <Dialog
            onClose={onClose}
            labelledBy={titleId}
            placement="top"
            overlayClassName="pt-[12vh]"


            panelClassName="max-w-lg mx-4 max-h-[76vh] bg-background text-foreground border-border shadow-xl"
        >
            <DialogBody className="p-6 flex flex-col gap-4">
                <div className="flex items-center justify-between">
                    <h2 id={titleId} className="text-lg font-semibold flex items-center gap-2">
                        <Brain className="w-5 h-5" />
                        {t('mindSweep.title')}
                    </h2>
                    <button
                        onClick={onClose}
                        aria-label={t('mindSweep.close')}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {isIntro && (
                    <>
                        <p className="text-sm text-muted-foreground">{t('mindSweep.intro')}</p>
                        <div>
                            <p className="text-sm font-medium mb-2">{t('mindSweep.scopeLabel')}</p>
                            <div className="flex gap-2">
                                {scopeOptions.map((option) => (
                                    <button
                                        key={option.value}
                                        onClick={() => setScope(option.value)}
                                        className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                                            scope === option.value
                                                ? 'bg-primary text-primary-foreground border-primary'
                                                : 'border-border hover:bg-accent'
                                        }`}
                                    >
                                        {option.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <button
                            ref={startButtonRef}
                            onClick={() => setStepIndex(0)}
                            className="w-full bg-primary text-primary-foreground py-2.5 px-4 rounded-lg font-medium hover:bg-primary/90 transition-colors"
                        >
                            {t('mindSweep.start')}
                        </button>
                    </>
                )}

                {group && (
                    <>
                        <div className="flex items-baseline justify-between">
                            <h3 className="text-base font-medium">{t(group.titleKey)}</h3>
                            <span className="text-xs text-muted-foreground">
                                {t('mindSweep.progress')
                                    .replace('{{current}}', String(stepIndex + 1))
                                    .replace('{{total}}', String(groups.length))}
                            </span>
                        </div>
                        <ul className="text-sm text-muted-foreground space-y-1 list-disc pl-5">
                            {group.promptKeys.map((promptKey) => (
                                <li key={promptKey}>{t(promptKey)}</li>
                            ))}
                        </ul>
                        <div className="flex gap-2">
                            <input
                                ref={inputRef}
                                value={draft}
                                onChange={(event) => setDraft(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                        event.preventDefault();
                                        void handleAdd();
                                    }
                                }}
                                placeholder={t('mindSweep.inputPlaceholder')}
                                className="flex-1 border border-border rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/40"
                            />
                            <button
                                onClick={() => void handleAdd()}
                                disabled={!draft.trim()}
                                className="px-4 py-2 rounded-lg text-sm bg-primary text-primary-foreground disabled:opacity-50 hover:bg-primary/90 transition-colors"
                            >
                                {t('mindSweep.add')}
                            </button>
                        </div>
                        {addFailed && (
                            <p className="text-sm text-destructive">{t('task.addFailed')}</p>
                        )}
                        {(capturedByGroup[group.id]?.length ?? 0) > 0 && (
                            <div>
                                <p className="text-xs text-muted-foreground mb-1">{t('mindSweep.groupCaptured')}</p>
                                <ul className="text-sm space-y-0.5 list-disc pl-5">
                                    {capturedByGroup[group.id].map((item, index) => (
                                        <li key={`${item}-${index}`} className="truncate">{item}</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        <div className="flex justify-between pt-2">
                            <button
                                onClick={() => setStepIndex((index) => index - 1)}
                                disabled={stepIndex === 0}
                                className="px-4 py-2 rounded-lg text-sm border border-border disabled:opacity-50 hover:bg-accent transition-colors"
                            >
                                {t('mindSweep.back')}
                            </button>
                            <button
                                onClick={() => setStepIndex((index) => index + 1)}
                                className="px-4 py-2 rounded-lg text-sm bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                            >
                                {t('mindSweep.next')}
                            </button>
                        </div>
                    </>
                )}

                {isSummary && (
                    <>
                        <h3 className="text-base font-medium">{t('mindSweep.summaryTitle')}</h3>
                        <p className="text-sm text-muted-foreground">
                            {capturedCount > 0
                                ? t('mindSweep.summaryCount').replace('{{count}}', String(capturedCount))
                                : t('mindSweep.summaryEmpty')}
                        </p>
                        {capturedCount > 0 && (
                            <p className="text-sm text-muted-foreground">{t('mindSweep.summaryHint')}</p>
                        )}
                        <button
                            ref={finishButtonRef}
                            onClick={onClose}
                            className="w-full bg-primary text-primary-foreground py-2.5 px-4 rounded-lg font-medium hover:bg-primary/90 transition-colors"
                        >
                            {t('mindSweep.finish')}
                        </button>
                    </>
                )}
            </DialogBody>
        </Dialog>
    );
}

type MindSweepLauncherProps = {
    t: (key: string) => string;
    addTask: (title: string, initialProps?: Partial<Task>) => Promise<StoreActionResult>;
    variant?: 'primary' | 'secondary';
};

type MindSweepTriggerProps = {
    t: (key: string) => string;
    onOpen: () => void;
    variant?: 'primary' | 'secondary';
};

export function MindSweepTrigger({ t, onOpen, variant = 'secondary' }: MindSweepTriggerProps) {
    const buttonClass = variant === 'primary'
        ? 'w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground py-3 px-4 rounded-lg font-medium hover:bg-primary/90 transition-colors'
        : 'flex items-center justify-center gap-2 whitespace-nowrap border border-border text-muted-foreground px-3 rounded-lg text-sm font-medium hover:bg-accent hover:text-foreground transition-colors';
    return (
        <button type="button" onClick={onOpen} className={buttonClass}>
            <Brain className="w-4 h-4" />
            {t('mindSweep.launchButton')}
        </button>
    );
}

export function MindSweepLauncher({ t, addTask, variant = 'secondary' }: MindSweepLauncherProps) {
    const [isOpen, setIsOpen] = useState(false);
    return (
        <>
            <MindSweepTrigger t={t} onOpen={() => setIsOpen(true)} variant={variant} />
            <MindSweepModal
                isOpen={isOpen}
                onClose={() => setIsOpen(false)}
                t={t}
                addTask={addTask}
            />
        </>
    );
}

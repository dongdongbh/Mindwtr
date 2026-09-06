import { X } from 'lucide-react';

import { cn } from '../lib/utils';

type Props = {
    t: (key: string) => string;
    nextActionDraft: string;
    setNextActionDraft: (value: string) => void;
    extraActionDrafts: string[];
    setExtraActionDrafts: (value: string[]) => void;
    labelClassName?: string;
    inputClassName?: string;
};

/** The next-action list shown while an Inbox item becomes a project: one
 *  required action plus any number of extra rows. Shared by the guided wizard
 *  and the quick panel so both modes offer the same conversion (#1167). */
export function InboxNextActionDrafts({
    t,
    nextActionDraft,
    setNextActionDraft,
    extraActionDrafts,
    setExtraActionDrafts,
    labelClassName,
    inputClassName,
}: Props) {
    const inputClass = cn('w-full border border-border rounded-lg py-2 px-3 text-sm focus:ring-2 focus:ring-primary', inputClassName);
    return (
        <div className="space-y-1">
            <label className={cn('text-xs text-muted-foreground font-medium', labelClassName)}>{t('process.nextAction')}</label>
            <input
                aria-label={t('process.nextAction')}
                value={nextActionDraft}
                onChange={(e) => setNextActionDraft(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key !== 'Enter' || !nextActionDraft.trim()) return;
                    e.preventDefault();
                    setExtraActionDrafts([...extraActionDrafts, '']);
                }}
                placeholder={t('taskEdit.titleLabel')}
                className={inputClass}
            />
            {extraActionDrafts.map((draft, index) => (
                <div key={index} className="flex gap-2">
                    <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setExtraActionDrafts(
                            extraActionDrafts.map((value, i) => (i === index ? e.target.value : value)),
                        )}
                        onKeyDown={(e) => {
                            if (e.key !== 'Enter' || index !== extraActionDrafts.length - 1 || !draft.trim()) return;
                            e.preventDefault();
                            setExtraActionDrafts([...extraActionDrafts, '']);
                        }}
                        placeholder={t('taskEdit.titleLabel')}
                        className={inputClass}
                    />
                    <button
                        type="button"
                        aria-label={t('process.removeAction')}
                        onClick={() => setExtraActionDrafts(extraActionDrafts.filter((_, i) => i !== index))}
                        className="px-2 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
            ))}
            <button
                type="button"
                onClick={() => setExtraActionDrafts([...extraActionDrafts, ''])}
                className="text-xs font-medium text-primary hover:underline"
            >
                + {t('process.addAnotherAction')}
            </button>
        </div>
    );
}

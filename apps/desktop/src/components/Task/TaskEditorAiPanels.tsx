import { Check, Loader2, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { useTaskItemAi } from './useTaskItemAi';

type TaskEditorAi = ReturnType<typeof useTaskItemAi>;

type TaskEditorAiMenuProps = {
    ai: TaskEditorAi;
    t: (key: string) => string;
};


export function TaskEditorAiMenu({ ai, t }: TaskEditorAiMenuProps) {
    const { aiEnabled, isAIWorking, handleAIClarify, handleAIBreakdown } = ai;
    const [aiMenuOpen, setAiMenuOpen] = useState(false);
    const aiMenuRef = useRef<HTMLDivElement>(null);
    const aiAssistantLabel = t('taskEdit.aiAssistant');
    const aiAssistantAriaLabel = aiAssistantLabel === 'taskEdit.aiAssistant' ? 'AI assistant' : aiAssistantLabel;
    const aiWorkingLabel = t('ai.working');
    const aiWorkingText = aiWorkingLabel === 'ai.working' ? 'Working...' : aiWorkingLabel;

    useEffect(() => {
        if (!aiMenuOpen) return;
        const handleClick = (event: MouseEvent) => {
            if (!aiMenuRef.current) return;
            if (aiMenuRef.current.contains(event.target as Node)) return;
            setAiMenuOpen(false);
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [aiMenuOpen]);

    if (!aiEnabled) return null;
    return (
        <div className="flex items-center gap-2">
            <div className="relative" ref={aiMenuRef}>
                <button
                    type="button"
                    onClick={() => setAiMenuOpen((prev) => !prev)}
                    disabled={isAIWorking}
                    aria-label={aiAssistantAriaLabel}
                    aria-expanded={aiMenuOpen}
                    aria-busy={isAIWorking}
                    className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                    {isAIWorking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                </button>
                {aiMenuOpen && (
                    <div className="absolute right-0 mt-2 w-44 rounded-md border border-border bg-card shadow-lg overflow-hidden z-10">
                        <button
                            type="button"
                            onClick={() => {
                                setAiMenuOpen(false);
                                handleAIClarify();
                            }}
                            disabled={isAIWorking}
                            aria-busy={isAIWorking}
                            className="w-full text-left text-xs px-3 py-2 hover:bg-muted/60 transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
                        >
                            {isAIWorking && <Loader2 className="w-3 h-3 animate-spin" />}
                            {t('taskEdit.aiClarify')}
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setAiMenuOpen(false);
                                handleAIBreakdown();
                            }}
                            disabled={isAIWorking}
                            aria-busy={isAIWorking}
                            className="w-full text-left text-xs px-3 py-2 hover:bg-muted/60 transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
                        >
                            {isAIWorking && <Loader2 className="w-3 h-3 animate-spin" />}
                            {t('taskEdit.aiBreakdown')}
                        </button>
                    </div>
                )}
            </div>
            {isAIWorking && (
                <div role="status" aria-live="polite" className="text-xs text-muted-foreground">
                    {aiWorkingText}
                </div>
            )}
        </div>
    );
}

type TaskEditorAiPanelsProps = {
    ai: TaskEditorAi;
    timeEstimatesEnabled: boolean;
    t: (key: string) => string;
};


export function TaskEditorAiPanels({ ai, timeEstimatesEnabled, t }: TaskEditorAiPanelsProps) {
    const {
        aiEnabled,
        aiError,
        aiBreakdownSteps,
        aiClarifyResponse,
        copilotContext,
        copilotEstimate,
        copilotTags,
        pendingCopilotParts,
        applyCopilotPart,
        applyCopilotSuggestion,
        addBreakdownStepsToChecklist,
        clearAiBreakdown,
        selectClarifyOption,
        applyClarifySuggestion,
        clearAiClarify,
    } = ai;
    if (!aiEnabled) return null;
    const hasAppliedCopilot = Boolean(copilotContext) || Boolean(copilotEstimate) || copilotTags.length > 0;

    return (
        <>
            {pendingCopilotParts.length > 0 && (
                <div className="text-xs px-2 py-1 rounded bg-muted/30 border border-border text-muted-foreground flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-1"><Sparkles className="h-3 w-3 shrink-0" aria-hidden="true" />{t('copilot.suggested')}</span>
                    {pendingCopilotParts.map((part) => (
                        <button
                            key={`${part.kind}:${part.value}`}
                            type="button"
                            onClick={() => applyCopilotPart(part)}
                            className="px-1.5 py-0.5 rounded bg-muted/50 text-foreground hover:bg-muted transition-colors"
                        >
                            {part.value}
                        </button>
                    ))}
                    {pendingCopilotParts.length > 1 && (
                        <button
                            type="button"
                            onClick={applyCopilotSuggestion}
                            className="px-1.5 py-0.5 rounded text-primary hover:bg-primary/10 transition-colors"
                        >
                            {t('copilot.applyAll')}
                        </button>
                    )}
                    <span className="text-muted-foreground/70">{t('copilot.applyHint')}</span>
                </div>
            )}
            {hasAppliedCopilot && (
                <div className="text-xs px-2 py-1 rounded bg-muted/30 border border-border text-muted-foreground">
                    <Check className="mr-1 inline h-3 w-3 align-[-0.125em]" aria-hidden="true" />{t('copilot.applied')}{' '}
                    {copilotContext ? `${copilotContext} ` : ''}
                    {timeEstimatesEnabled && copilotEstimate ? `${copilotEstimate}` : ''}
                    {copilotTags.length ? copilotTags.join(' ') : ''}
                </div>
            )}
            {aiError && (
                <div className="text-xs text-muted-foreground border border-border rounded-md p-2 bg-muted/20 break-words whitespace-pre-wrap">
                    {aiError}
                </div>
            )}
            {aiBreakdownSteps && (
                <div className="border border-border rounded-md p-2 space-y-2 text-xs">
                    <div className="text-muted-foreground">{t('ai.breakdownTitle')}</div>
                    <div className="space-y-1">
                        {aiBreakdownSteps.map((step, index) => (
                            <div key={`${step}-${index}`} className="text-foreground">
                                {index + 1}. {step}
                            </div>
                        ))}
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={addBreakdownStepsToChecklist}
                            className="px-2 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                        >
                            {t('ai.addSteps')}
                        </button>
                        <button
                            type="button"
                            onClick={clearAiBreakdown}
                            className="px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors text-muted-foreground"
                        >
                            {t('common.cancel')}
                        </button>
                    </div>
                </div>
            )}
            {aiClarifyResponse && (
                <div className="border border-border rounded-md p-2 space-y-2 text-xs">
                    <div className="text-muted-foreground">{aiClarifyResponse.question}</div>
                    <div className="flex flex-wrap gap-2">
                        {aiClarifyResponse.options.map((option) => (
                            <button
                                key={option.label}
                                type="button"
                                onClick={() => selectClarifyOption(option.action)}
                                className="px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors"
                            >
                                {option.label}
                            </button>
                        ))}
                        {aiClarifyResponse.suggestedAction?.title && (
                            <button
                                type="button"
                                onClick={applyClarifySuggestion}
                                className="px-2 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                            >
                                {t('ai.applySuggestion')}
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={clearAiClarify}
                            className="px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors text-muted-foreground"
                        >
                            {t('common.cancel')}
                        </button>
                    </div>
                </div>
            )}
        </>
    );
}

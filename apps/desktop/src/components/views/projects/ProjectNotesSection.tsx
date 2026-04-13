import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link2, Maximize2, Paperclip } from 'lucide-react';
import {
    applyMarkdownToolbarAction,
    continueMarkdownOnEnter,
    resolveAutoTextDirection,
    type Attachment,
    type MarkdownSelection,
    type MarkdownToolbarActionId,
    type MarkdownToolbarResult,
    type Project,
} from '@mindwtr/core';

import { ExpandedMarkdownEditor } from '../../ExpandedMarkdownEditor';
import { MarkdownFormatToolbar } from '../../MarkdownFormatToolbar';
import { Markdown } from '../../Markdown';
import { AttachmentProgressIndicator } from '../../AttachmentProgressIndicator';
import { getAttachmentDisplayTitle } from '../../../lib/attachment-utils';

type ProjectNotesSectionProps = {
    project: Project;
    showNotesPreview: boolean;
    onTogglePreview: () => void;
    onAddFile: () => void;
    onAddLink: () => void;
    attachmentsBusy?: boolean;
    visibleAttachments: Attachment[];
    attachmentError: string | null;
    onOpenAttachment: (attachment: Attachment) => void;
    onRemoveAttachment: (attachmentId: string) => void;
    onUpdateNotes: (notes: string) => void;
    t: (key: string) => string;
    language: string;
};

export function ProjectNotesSection({
    project,
    showNotesPreview,
    onTogglePreview,
    onAddFile,
    onAddLink,
    attachmentsBusy = false,
    visibleAttachments,
    attachmentError,
    onOpenAttachment,
    onRemoveAttachment,
    onUpdateNotes,
    t,
    language,
}: ProjectNotesSectionProps) {
    const [draftNotes, setDraftNotes] = useState(project.supportNotes || '');
    const [notesExpanded, setNotesExpanded] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const draftNotesRef = useRef(project.supportNotes || '');
    const notesSelectionRef = useRef<MarkdownSelection>({
        start: draftNotes.length,
        end: draftNotes.length,
    });
    const notesUndoRef = useRef<Array<{ value: string; selection: MarkdownSelection }>>([]);
    const [notesUndoDepth, setNotesUndoDepth] = useState(0);
    const resolvedDirection = resolveAutoTextDirection([project.title, draftNotes].filter(Boolean).join(' '), language);
    const isRtl = resolvedDirection === 'rtl';

    useEffect(() => {
        draftNotesRef.current = project.supportNotes || '';
        setDraftNotes(project.supportNotes || '');
        setNotesExpanded(false);
        notesSelectionRef.current = {
            start: (project.supportNotes || '').length,
            end: (project.supportNotes || '').length,
        };
        notesUndoRef.current = [];
        setNotesUndoDepth(0);
        if (textareaRef.current) {
            textareaRef.current.scrollTop = 0;
        }
    }, [project.id, project.supportNotes]);

    const pushNotesUndoEntry = (value: string, selection: MarkdownSelection) => {
        const previousEntry = notesUndoRef.current[notesUndoRef.current.length - 1];
        if (
            previousEntry
            && previousEntry.value === value
            && previousEntry.selection.start === selection.start
            && previousEntry.selection.end === selection.end
        ) {
            return;
        }
        const nextUndoEntries = [...notesUndoRef.current, { value, selection }];
        notesUndoRef.current = nextUndoEntries.length > 100
            ? nextUndoEntries.slice(nextUndoEntries.length - 100)
            : nextUndoEntries;
        setNotesUndoDepth(notesUndoRef.current.length);
    };

    const applyNotesValue = (
        value: string,
        options?: {
            nextSelection?: MarkdownSelection;
            recordUndo?: boolean;
            baseSelection?: MarkdownSelection;
        },
    ) => {
        if ((options?.recordUndo ?? true) && value !== draftNotesRef.current) {
            pushNotesUndoEntry(draftNotesRef.current, options?.baseSelection ?? notesSelectionRef.current);
        }
        draftNotesRef.current = value;
        setDraftNotes(value);
        if (options?.nextSelection) {
            notesSelectionRef.current = options.nextSelection;
        }
    };

    const handleNotesChange = (value: string) => {
        applyNotesValue(value);
    };

    const handleNotesUndo = () => {
        const previousEntry = notesUndoRef.current[notesUndoRef.current.length - 1];
        if (!previousEntry) return undefined;
        notesUndoRef.current = notesUndoRef.current.slice(0, -1);
        setNotesUndoDepth(notesUndoRef.current.length);
        applyNotesValue(previousEntry.value, {
            nextSelection: previousEntry.selection,
            recordUndo: false,
        });
        return previousEntry.selection;
    };

    const handleNotesApplyAction = (actionId: MarkdownToolbarActionId, selection: MarkdownSelection): MarkdownToolbarResult => {
        const next = applyMarkdownToolbarAction(draftNotesRef.current, selection, actionId);
        applyNotesValue(next.value, {
            baseSelection: selection,
            nextSelection: next.selection,
        });
        return next;
    };

    const handleNotesKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if ((event.metaKey || event.ctrlKey) && !event.altKey) {
            if (event.key.toLowerCase() !== 'z') return;
            if (notesUndoRef.current.length === 0) return;
            event.preventDefault();
            handleNotesUndo();
            return;
        }

        if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;
        const currentValue = event.currentTarget.value;
        const selection = {
            start: event.currentTarget.selectionStart ?? currentValue.length,
            end: event.currentTarget.selectionEnd ?? currentValue.length,
        };
        const next = continueMarkdownOnEnter(currentValue, selection);
        if (!next) return;

        event.preventDefault();
        applyNotesValue(next.value, {
            baseSelection: selection,
            nextSelection: next.selection,
        });
        notesSelectionRef.current = next.selection;
        requestAnimationFrame(() => {
            textareaRef.current?.focus();
            textareaRef.current?.setSelectionRange(next.selection.start, next.selection.end);
        });
    };

    return (
        <section className="py-5 border-b border-border/50">
            <div className="text-sm font-medium">
                {t('project.notes')}
            </div>
            <div className="pt-4 space-y-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={onTogglePreview}
                            className="h-7 text-xs px-2.5 rounded-md border border-border bg-background hover:bg-muted/40 transition-colors text-muted-foreground"
                        >
                            {showNotesPreview ? t('markdown.edit') : t('markdown.preview')}
                        </button>
                        <button
                            type="button"
                            onClick={() => setNotesExpanded(true)}
                            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            aria-label={t('markdown.expand')}
                        >
                            <Maximize2 className="h-4 w-4" />
                        </button>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={onAddFile}
                            className="h-7 text-xs px-2.5 rounded-md border border-border bg-background hover:bg-muted/40 transition-colors flex items-center gap-1 disabled:opacity-60 disabled:cursor-not-allowed"
                            disabled={attachmentsBusy}
                            aria-busy={attachmentsBusy}
                        >
                            <Paperclip className="w-3 h-3" />
                            {t('attachments.addFile')}
                        </button>
                        <button
                            type="button"
                            onClick={onAddLink}
                            className="h-7 text-xs px-2.5 rounded-md border border-border bg-background hover:bg-muted/40 transition-colors flex items-center gap-1 disabled:opacity-60 disabled:cursor-not-allowed"
                            disabled={attachmentsBusy}
                            aria-busy={attachmentsBusy}
                        >
                            <Link2 className="w-3 h-3" />
                            {t('attachments.addLink')}
                        </button>
                    </div>
                </div>

                {showNotesPreview ? (
                    <div className={`text-xs border border-border rounded-md px-2.5 py-2.5 ${isRtl ? 'text-right' : ''}`} dir={resolvedDirection}>
                        <Markdown markdown={draftNotes} className={isRtl ? 'text-right' : undefined} />
                    </div>
                ) : (
                    <div className="flex flex-col gap-2">
                        <MarkdownFormatToolbar
                            textareaRef={textareaRef}
                            t={t}
                            canUndo={notesUndoDepth > 0}
                            onUndo={handleNotesUndo}
                            onApplyAction={handleNotesApplyAction}
                        />
                        <textarea
                            ref={textareaRef}
                            className={`w-full min-h-[120px] p-3 text-sm bg-background border border-border rounded-md resize-y focus:outline-none focus:bg-accent/5 ${isRtl ? 'text-right' : ''}`}
                            placeholder={t('projects.notesPlaceholder')}
                            value={draftNotes}
                            dir={resolvedDirection}
                            onChange={(event) => {
                                applyNotesValue(event.target.value);
                                notesSelectionRef.current = {
                                    start: event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                                    end: event.currentTarget.selectionEnd ?? event.currentTarget.value.length,
                                };
                            }}
                            onSelect={(event) => {
                                notesSelectionRef.current = {
                                    start: event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                                    end: event.currentTarget.selectionEnd ?? event.currentTarget.value.length,
                                };
                            }}
                            onKeyDown={handleNotesKeyDown}
                            onBlur={(event) => {
                                onUpdateNotes(event.target.value);
                                event.currentTarget.scrollTop = 0;
                            }}
                        />
                    </div>
                )}

                <div className="pt-2 border-t border-border/50 space-y-1.5">
                    <div className="text-xs text-muted-foreground font-medium">{t('attachments.title')}</div>
                    {attachmentError && (
                        <div className="text-xs text-red-400">{attachmentError}</div>
                    )}
                    {visibleAttachments.length === 0 ? (
                        <div className="text-xs text-muted-foreground">{t('common.none')}</div>
                    ) : (
                        <div className="space-y-1.5">
                            {visibleAttachments.map((attachment) => {
                                const displayTitle = getAttachmentDisplayTitle(attachment);
                                const fullTitle = attachment.kind === 'link' ? attachment.uri : attachment.title;
                                return (
                                    <div key={attachment.id} className="flex items-center justify-between gap-2 text-xs rounded-md border border-border/60 px-2 py-1.5">
                                        <div className="min-w-0 flex-1">
                                            <button
                                                type="button"
                                                onClick={() => onOpenAttachment(attachment)}
                                                className="truncate text-primary hover:underline"
                                                title={fullTitle || displayTitle}
                                            >
                                                {displayTitle}
                                            </button>
                                            <AttachmentProgressIndicator attachmentId={attachment.id} className="mt-1" />
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => onRemoveAttachment(attachment.id)}
                                            className="text-muted-foreground hover:text-foreground text-[11px]"
                                        >
                                            {t('attachments.remove')}
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
                <ExpandedMarkdownEditor
                    isOpen={notesExpanded}
                    onClose={() => setNotesExpanded(false)}
                    value={draftNotes}
                    onChange={handleNotesChange}
                    onCommit={() => onUpdateNotes(draftNotesRef.current)}
                    title={t('project.notes')}
                    headerTitle={project.title || t('project.notes')}
                    placeholder={t('projects.notesPlaceholder')}
                    t={t}
                    initialMode="edit"
                    direction={resolvedDirection}
                    canUndo={notesUndoDepth > 0}
                    onUndo={handleNotesUndo}
                    onApplyAction={handleNotesApplyAction}
                    onSelectionChange={(selection) => {
                        notesSelectionRef.current = selection;
                    }}
                    onEditorKeyDown={handleNotesKeyDown}
                />
            </div>
        </section>
    );
}

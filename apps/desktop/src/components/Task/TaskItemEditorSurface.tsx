import type { ReactNode, RefObject } from 'react';

type TaskItemEditorSurfaceProps = {
    editorAriaLabel: string;
    getModalFocusableElements: () => HTMLElement[];
    isEditing: boolean;
    isModalEditor: boolean;
    modalEditorRef: RefObject<HTMLDivElement | null>;
    onCancel: () => void;
    renderDisplay: () => ReactNode;
    renderEditor: () => ReactNode;
};

export function TaskItemEditorSurface({
    editorAriaLabel,
    getModalFocusableElements,
    isEditing,
    isModalEditor,
    modalEditorRef,
    onCancel,
    renderDisplay,
    renderEditor,
}: TaskItemEditorSurfaceProps) {
    return (
        <>
            {isEditing && !isModalEditor ? (
                <div className="flex-1 min-w-0">
                    {renderEditor()}
                </div>
            ) : (
                renderDisplay()
            )}
            {isEditing && isModalEditor && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
                    role="dialog"
                    aria-modal="true"
                    aria-label={editorAriaLabel}
                    onMouseDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        onCancel();
                    }}
                >
                    <div
                        ref={modalEditorRef}
                        tabIndex={-1}
                        className="w-[min(1100px,92vw)] max-h-[90vh] rounded-xl border border-border bg-card p-4 shadow-2xl"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                                event.preventDefault();
                                onCancel();
                                return;
                            }
                            if (event.key !== 'Tab') return;
                            const focusable = getModalFocusableElements();
                            if (focusable.length === 0) return;
                            const first = focusable[0];
                            const last = focusable[focusable.length - 1];
                            const active = document.activeElement as HTMLElement | null;
                            if (!active || !focusable.includes(active)) {
                                event.preventDefault();
                                first.focus();
                                return;
                            }
                            if (event.shiftKey && active === first) {
                                event.preventDefault();
                                last.focus();
                                return;
                            }
                            if (!event.shiftKey && active === last) {
                                event.preventDefault();
                                first.focus();
                            }
                        }}
                    >
                        {renderEditor()}
                    </div>
                </div>
            )}
        </>
    );
}

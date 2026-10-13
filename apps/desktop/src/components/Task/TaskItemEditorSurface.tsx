import type { ReactNode, RefObject } from 'react';
import { Dialog, DialogBody } from '../ui/Dialog';

type TaskItemEditorSurfaceProps = {
    editorAriaLabel: string;
    isEditing: boolean;
    isModalEditor: boolean;
    modalEditorRef: RefObject<HTMLDivElement | null>;
    onCancel: () => void;
    renderDisplay: () => ReactNode;
    renderEditor: () => ReactNode;
};

export function TaskItemEditorSurface({
    editorAriaLabel,
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
                <Dialog
                    onClose={onCancel}
                    label={editorAriaLabel}
                    overlayClassName="p-4"
                    panelClassName="w-[min(1100px,92vw)] max-w-none max-h-[90vh] rounded-xl border-border bg-card"
                    panelRef={modalEditorRef}
                >
                    {/* The form owns scrolling so its action row stays visible (#957). */}
                    <DialogBody className="overflow-hidden p-6">
                        {renderEditor()}
                    </DialogBody>
                </Dialog>
            )}
        </>
    );
}

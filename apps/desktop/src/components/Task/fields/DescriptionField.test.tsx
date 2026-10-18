import { createRef } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MarkdownSelection, MarkdownToolbarActionId } from '@mindwtr/core';

import { DescriptionField } from './DescriptionField';

const t = (key: string) => ({
    'taskEdit.descriptionLabel': 'Description',
    'task.aria.description': 'Description',
    'taskEdit.descriptionPlaceholder': 'Add notes...',
    'taskEdit.descriptionAudio': 'Dictate description',
    'taskEdit.descriptionAudioStop': 'Stop dictation',
    'markdown.edit': 'Edit',
    'markdown.preview': 'Preview',
    'markdown.expand': 'Expand',
}[key] ?? key);

const baseProps = {
    t,
    taskTitle: 'Task',
    taskId: 'task-1',
    showDescriptionPreview: false,
    editDescription: '',
    isRtl: false,
    resolvedDirection: 'ltr' as const,
    descriptionExpanded: false,
    descriptionUndoDepth: 0,
    descriptionTextareaRef: createRef<HTMLTextAreaElement>(),
    descriptionSelection: { start: 0, end: 0 } as MarkdownSelection,
    descriptionAutocomplete: {
        isOpen: false,
        suggestions: [],
        selectedIndex: 0,
        setSelectedIndex: vi.fn(),
        applySuggestion: vi.fn(),
        menuRef: createRef<HTMLDivElement>(),
        position: null,
    } as unknown as Parameters<typeof DescriptionField>[0]['descriptionAutocomplete'],
    onTogglePreview: vi.fn(),
    onEditFromPreview: vi.fn(),
    onExpand: vi.fn(),
    onCloseExpanded: vi.fn(),
    onDescriptionInput: vi.fn(),
    onDescriptionChange: vi.fn(),
    onSelectionChange: vi.fn(),
    onUndo: vi.fn(),
    onApplyAction: vi.fn((_actionId: MarkdownToolbarActionId, selection: MarkdownSelection) => ({ value: '', selection })),
    onKeyDown: vi.fn(),
    onPaste: vi.fn(),
    descriptionAudioState: 'idle' as const,
    descriptionAudioError: null,
    onDescriptionAudioInput: vi.fn(),
};

describe('DescriptionField audio input', () => {
    it('renders a compact dictate button for the description field', () => {
        const onDescriptionAudioInput = vi.fn();
        const { getByRole } = render(
            <DescriptionField
                {...baseProps}
                onDescriptionAudioInput={onDescriptionAudioInput}
            />
        );

        fireEvent.click(getByRole('button', { name: 'Dictate description' }));

        expect(onDescriptionAudioInput).toHaveBeenCalledTimes(1);
    });
});

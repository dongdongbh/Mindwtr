// @vitest-environment jsdom

import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Project } from '@mindwtr/core';

import { ProjectNotesSection } from './ProjectNotesSection';

vi.mock('../../../lib/attachment-reference', () => ({
    useBareFileReferenceCheck: () => () => false,
}));

const t = (key: string) => key;

function buildProject(overrides: Partial<Project> = {}): Project {
    return {
        id: 'project-1',
        title: 'Launch site',
        status: 'active',
        color: '#3b82f6',
        order: 0,
        tagIds: [],
        createdAt: '2026-03-30T09:00:00',
        updatedAt: '2026-03-30T09:00:00',
        ...overrides,
    };
}

function renderNotes(supportNotes: string) {
    const onUpdateNotes = vi.fn();
    const utils = render(
        <ProjectNotesSection
            project={buildProject({ supportNotes })}
            showNotesPreview={false}
            onTogglePreview={vi.fn()}
            onAddFile={vi.fn()}
            onAddLink={vi.fn()}
            visibleAttachments={[]}
            attachmentError={null}
            onOpenAttachment={vi.fn()}
            onRemoveAttachment={vi.fn()}
            onUpdateNotes={onUpdateNotes}
            t={t}
            language="en"
        />
    );
    const textarea = utils.container.querySelector('textarea') as HTMLTextAreaElement;
    return { ...utils, textarea, onUpdateNotes };
}

describe('ProjectNotesSection keyboard', () => {
    it('indents the current list item with Tab and outdents it with Shift+Tab', () => {
        const { textarea } = renderNotes('- item');
        textarea.setSelectionRange(6, 6);

        fireEvent.keyDown(textarea, { key: 'Tab' });
        expect(textarea.value).toBe('  - item');

        fireEvent.keyDown(textarea, { key: 'Tab', shiftKey: true });
        expect(textarea.value).toBe('- item');
    });

    it('leaves Shift+Tab to the browser when the line is not indented', () => {
        const { textarea } = renderNotes('plain text');
        textarea.setSelectionRange(10, 10);

        const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
        textarea.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(false);
        expect(textarea.value).toBe('plain text');
    });
});

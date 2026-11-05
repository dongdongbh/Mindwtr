import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore, type Task } from '@mindwtr/core';

import { useTaskDescriptionEditor, type TaskDescriptionEditor } from './use-task-description-editor';

type HarnessApi = {
  draft: string;
  editor: TaskDescriptionEditor;
};

const task: Task = {
  id: 'task-1',
  title: 'Task',
  status: 'inbox',
  tags: [],
  contexts: [],
  createdAt: '2026-06-12T00:00:00.000Z',
  updatedAt: '2026-06-12T00:00:00.000Z',
};

function DescriptionEditorHarness({
  expose,
}: {
  expose: React.MutableRefObject<HarnessApi | null>;
}) {
  const [descriptionDraft, setDescriptionDraft] = React.useState('');
  const descriptionDraftRef = React.useRef(descriptionDraft);
  const descriptionDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const editor = useTaskDescriptionEditor({
    task,
    descriptionDraft,
    descriptionDraftRef,
    setDescriptionDraft,
    descriptionDebounceRef,
    setDraftField: vi.fn(),
    resetCopilotDraft: vi.fn(),
    onMarkdownOverlayVisibilityChange: vi.fn(),
    onInputFocusTracked: vi.fn(),
  });

  expose.current = {
    draft: descriptionDraft,
    editor,
  };

  return null;
}

describe('useTaskDescriptionEditor', () => {
  afterEach(() => {
    useTaskStore.setState({ settings: {} });
  });

  it.each(['()', '[]', '``'])('deletes an empty %s pair after stale native echoes', (pair) => {
    for (const prefix of ['', 'note ']) {
      const expose = React.createRef<HarnessApi | null>();
      let tree!: ReturnType<typeof create>;
      act(() => { tree = create(<DescriptionEditorHarness expose={expose} />); });
      if (prefix) {
        act(() => { expose.current!.editor.handleDescriptionChange(prefix); });
        act(() => { expose.current!.editor.setDescriptionSelection({ start: prefix.length, end: prefix.length }); });
      }
      const rawInsertion = prefix + pair[0];
      act(() => { expose.current!.editor.handleDescriptionChange(rawInsertion); });
      expect(expose.current!.draft).toBe(prefix + pair);
      act(() => { expose.current!.editor.handleDescriptionChange(rawInsertion); });
      act(() => { expose.current!.editor.handleDescriptionChange(rawInsertion); });
      expect(expose.current!.draft).toBe(prefix + pair);

      const preventDefault = vi.fn();
      act(() => {
        expose.current!.editor.handleDescriptionKeyPress({
          nativeEvent: { key: 'Backspace' }, preventDefault,
        } as any);
        expose.current!.editor.handleDescriptionChange(rawInsertion);
      });
      expect(expose.current!.draft).toBe(rawInsertion);
      act(() => {
        expose.current!.editor.handleDescriptionKeyPress({
          nativeEvent: { key: 'Backspace' }, preventDefault,
        } as any);
        expose.current!.editor.handleDescriptionChange(prefix);
      });
      expect(expose.current!.draft).toBe(prefix);
      expect(preventDefault).not.toHaveBeenCalled();
      act(() => { tree.unmount(); });
    }
  });

  it('keeps inline Android description pairs through repeated stale native changes', () => {
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<DescriptionEditorHarness expose={expose} />);
    });

    act(() => {
      expose.current!.editor.handleDescriptionChange('(');
    });

    expect(expose.current!.draft).toBe('()');

    act(() => {
      expose.current!.editor.handleDescriptionChange('(');
    });

    expect(expose.current!.draft).toBe('()');

    act(() => {
      expose.current!.editor.handleDescriptionChange('(())');
    });

    expect(expose.current!.draft).toBe('()');

    act(() => {
      tree.unmount();
    });
  });

  it('keeps a single pair when the native change arrives before repeated key press echoes', () => {


    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<DescriptionEditorHarness expose={expose} />);
    });

    act(() => {
      expose.current!.editor.handleDescriptionChange('(');
    });

    expect(expose.current!.draft).toBe('()');

    act(() => {
      expose.current!.editor.handleDescriptionKeyPress({
        nativeEvent: { key: '(' },
        preventDefault: vi.fn(),
      } as any);
    });

    expect(expose.current!.draft).toBe('()');

    act(() => {
      expose.current!.editor.handleDescriptionKeyPress({
        nativeEvent: { key: '(' },
        preventDefault: vi.fn(),
      } as any);
    });

    expect(expose.current!.draft).toBe('()');

    act(() => {
      tree.unmount();
    });
  });

  it('leaves pairing to the text change when key press echoes arrive first', () => {
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<DescriptionEditorHarness expose={expose} />);
    });

    const firstPreventDefault = vi.fn();
    act(() => {
      expose.current!.editor.handleDescriptionKeyPress({
        nativeEvent: { key: '[' },
        preventDefault: firstPreventDefault,
      } as any);
    });


    expect(firstPreventDefault).not.toHaveBeenCalled();
    expect(expose.current!.draft).toBe('');

    const duplicatePreventDefault = vi.fn();
    act(() => {
      expose.current!.editor.handleDescriptionKeyPress({
        nativeEvent: { key: '[' },
        preventDefault: duplicatePreventDefault,
      } as any);
    });

    expect(duplicatePreventDefault).not.toHaveBeenCalled();
    expect(expose.current!.draft).toBe('');

    act(() => {
      expose.current!.editor.handleDescriptionChange('[');
    });

    expect(expose.current!.draft).toBe('[]');

    act(() => {
      expose.current!.editor.handleDescriptionChange('[[]]');
    });

    expect(expose.current!.draft).toBe('[]');

    act(() => {
      tree.unmount();
    });
  });

  it('types plain text without auto-pairing when editor assist is disabled', () => {
    useTaskStore.setState({ settings: { markdownEditorAssist: false } });
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<DescriptionEditorHarness expose={expose} />);
    });

    const preventDefault = vi.fn();
    act(() => {
      expose.current!.editor.handleDescriptionKeyPress({
        nativeEvent: { key: '(' },
        preventDefault,
      } as any);
    });


    expect(preventDefault).not.toHaveBeenCalled();

    act(() => {
      expose.current!.editor.handleDescriptionChange('(');
    });

    expect(expose.current!.draft).toBe('(');

    act(() => {
      tree.unmount();
    });
  });
});

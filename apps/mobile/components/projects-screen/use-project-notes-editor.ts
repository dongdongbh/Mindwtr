import { useCallback, useEffect, useRef, useState } from 'react';
import { TextInput } from 'react-native';
import {
  applyMarkdownToolbarAction,
  continueMarkdownOnTextChange,
  isMarkdownEditorAssistEnabled,
  resolveAutoTextDirection,
  useTaskStore,
  type MarkdownSelection,
  type MarkdownToolbarActionId,
  type MarkdownToolbarResult,
  type Project,
} from '@mindwtr/core';

const selectionsEqual = (left: MarkdownSelection, right: MarkdownSelection) => (
  left.start === right.start && left.end === right.end
);

type UseProjectNotesEditorParams = {
  selectedProject: Project | null;
  setSelectedProject: (project: Project | null) => void;
  updateProject: (id: string, updates: Partial<Project>) => unknown;
  language: string;
};

export function useProjectNotesEditor({
  selectedProject,
  setSelectedProject,
  updateProject,
  language,
}: UseProjectNotesEditorParams) {
  const selectedProjectRef = useRef(selectedProject);
  selectedProjectRef.current = selectedProject;
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [showNotesPreview, setShowNotesPreview] = useState(false);
  const [notesFullscreen, setNotesFullscreen] = useState(false);
  const selectedProjectNotesRef = useRef('');
  const committedProjectNotesRef = useRef('');
  const selectedProjectNotesInputRef = useRef<TextInput | null>(null);
  const selectedProjectNotesUndoRef = useRef<Array<{ value: string; selection: MarkdownSelection }>>([]);
  const [selectedProjectNotesUndoDepth, setSelectedProjectNotesUndoDepth] = useState(0);
  const [isSelectedProjectNotesFocused, setIsSelectedProjectNotesFocused] = useState(false);
  const [selectedProjectNotesSelection, setSelectedProjectNotesSelection] = useState({ start: 0, end: 0 });
  const selectedProjectNotesSelectionRef = useRef<MarkdownSelection>({ start: 0, end: 0 });
  const pendingSelectedProjectNotesSelectionRef = useRef<MarkdownSelection | null>(null);
  const selectedProjectNotes = selectedProject?.supportNotes || '';
  const isProjectReadOnly = useCallback((project: Project | null | undefined) => {
    if (!project || project.status === 'archived') return true;
    return useTaskStore.getState()._allProjects?.find((item) => item.id === project.id)?.status === 'archived';
  }, []);
  const selectedProjectNotesDirection = selectedProject
    ? resolveAutoTextDirection(`${selectedProject.title ?? ''}\n${selectedProjectNotes}`.trim(), language)
    : 'ltr';
  const selectedProjectNotesTextDirectionStyle = {
    writingDirection: selectedProjectNotesDirection,
    textAlign: selectedProjectNotesDirection === 'rtl' ? 'right' : 'left',
  } as const;

  useEffect(() => {
    const initialNotes = selectedProject?.supportNotes || '';
    selectedProjectNotesRef.current = initialNotes;
    committedProjectNotesRef.current = initialNotes;
    const selectionEnd = initialNotes.length;
    selectedProjectNotesUndoRef.current = [];
    setSelectedProjectNotesUndoDepth(0);
    setIsSelectedProjectNotesFocused(false);
    setNotesFullscreen(false);
    setShowNotesPreview(selectedProject?.status === 'archived');
    pendingSelectedProjectNotesSelectionRef.current = null;
    selectedProjectNotesSelectionRef.current = { start: selectionEnd, end: selectionEnd };
    setSelectedProjectNotesSelection({ start: selectionEnd, end: selectionEnd });
    // supportNotes is a one-time snapshot for the newly selected project; keying this
    // reset on it would wipe the undo stack and selection on every notes keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject?.id, selectedProject?.status]);

  const pushSelectedProjectNotesUndoEntry = useCallback((value: string, selection: MarkdownSelection) => {
    const previousEntry = selectedProjectNotesUndoRef.current[selectedProjectNotesUndoRef.current.length - 1];
    if (
      previousEntry
      && previousEntry.value === value
      && previousEntry.selection.start === selection.start
      && previousEntry.selection.end === selection.end
    ) {
      return;
    }
    const nextUndoEntries = [...selectedProjectNotesUndoRef.current, { value, selection }];
    selectedProjectNotesUndoRef.current = nextUndoEntries.length > 100
      ? nextUndoEntries.slice(nextUndoEntries.length - 100)
      : nextUndoEntries;
    setSelectedProjectNotesUndoDepth(selectedProjectNotesUndoRef.current.length);
  }, []);

  const applySelectedProjectNotesValue = useCallback((
    text: string,
    options?: {
      nextSelection?: MarkdownSelection;
      recordUndo?: boolean;
      baseSelection?: MarkdownSelection;
    },
  ) => {
    const current = selectedProjectRef.current;
    if (!current || isProjectReadOnly(current)) return;
    const currentNotes = current.supportNotes || '';
    if ((options?.recordUndo ?? true) && text !== currentNotes) {
      pushSelectedProjectNotesUndoEntry(currentNotes, options?.baseSelection ?? selectedProjectNotesSelectionRef.current);
    }
    selectedProjectNotesRef.current = text;
    setSelectedProject({ ...current, supportNotes: text });
    if (options?.nextSelection) {
      selectedProjectNotesSelectionRef.current = options.nextSelection;
      setSelectedProjectNotesSelection(options.nextSelection);
    }
  }, [isProjectReadOnly, pushSelectedProjectNotesUndoEntry, setSelectedProject]);

  const restoreSelectedProjectNotesSelection = useCallback((selection: MarkdownSelection) => {
    pendingSelectedProjectNotesSelectionRef.current = selection;
    const applySelection = () => {
      selectedProjectNotesInputRef.current?.focus?.();
      selectedProjectNotesInputRef.current?.setNativeProps?.({ selection });
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(applySelection);
    } else {
      setTimeout(applySelection, 0);
    }
    const applyDelayedSelection = (shouldClearPending: boolean) => {
      applySelection();
      if (
        shouldClearPending
        && pendingSelectedProjectNotesSelectionRef.current
        && selectionsEqual(pendingSelectedProjectNotesSelectionRef.current, selection)
      ) {
        pendingSelectedProjectNotesSelectionRef.current = null;
      }
    };
    setTimeout(() => {
      applyDelayedSelection(false);
    }, 40);
    setTimeout(() => {
      applyDelayedSelection(false);
    }, 140);
    setTimeout(() => {
      applyDelayedSelection(true);
    }, 300);
  }, []);

  const handleSelectedProjectNotesChange = useCallback((text: string) => {
    if (isProjectReadOnly(selectedProjectRef.current)) return;
    const assistEnabled = isMarkdownEditorAssistEnabled(useTaskStore.getState().settings);
    const continued = continueMarkdownOnTextChange(
      selectedProjectNotesRef.current,
      text,
      selectedProjectNotesSelectionRef.current,
      { assist: assistEnabled },
    );
    if (continued) {
      applySelectedProjectNotesValue(continued.value, {
        baseSelection: selectedProjectNotesSelectionRef.current,
        nextSelection: continued.selection,
      });
      restoreSelectedProjectNotesSelection(continued.selection);
      return;
    }
    applySelectedProjectNotesValue(text);
  }, [applySelectedProjectNotesValue, isProjectReadOnly, restoreSelectedProjectNotesSelection]);

  useEffect(() => {
    selectedProjectNotesSelectionRef.current = selectedProjectNotesSelection;
  }, [selectedProjectNotesSelection]);

  const handleSelectedProjectNotesSelectionChange = useCallback((selection: MarkdownSelection) => {
    const pendingSelection = pendingSelectedProjectNotesSelectionRef.current;
    if (pendingSelection) {
      if (!selectionsEqual(pendingSelection, selection)) {
        return;
      }
      pendingSelectedProjectNotesSelectionRef.current = null;
    }
    selectedProjectNotesSelectionRef.current = selection;
    setSelectedProjectNotesSelection(selection);
  }, []);

  useEffect(() => {
    setSelectedProjectNotesSelection((prev) => {
      const nextStart = Math.min(prev.start, selectedProjectNotes.length);
      const nextEnd = Math.min(prev.end, selectedProjectNotes.length);
      if (nextStart === prev.start && nextEnd === prev.end) {
        return prev;
      }
      return { start: nextStart, end: nextEnd };
    });
  }, [selectedProjectNotes.length]);

  const handleSelectedProjectNotesUndo = useCallback(() => {
    if (isProjectReadOnly(selectedProjectRef.current)) return undefined;
    const previousEntry = selectedProjectNotesUndoRef.current[selectedProjectNotesUndoRef.current.length - 1];
    if (!previousEntry) return undefined;
    selectedProjectNotesUndoRef.current = selectedProjectNotesUndoRef.current.slice(0, -1);
    setSelectedProjectNotesUndoDepth(selectedProjectNotesUndoRef.current.length);
    applySelectedProjectNotesValue(previousEntry.value, {
      nextSelection: previousEntry.selection,
      recordUndo: false,
    });
    return previousEntry.selection;
  }, [applySelectedProjectNotesValue, isProjectReadOnly]);

  const handleSelectedProjectNotesApplyAction = useCallback((actionId: MarkdownToolbarActionId, selection: MarkdownSelection): MarkdownToolbarResult => {
    if (isProjectReadOnly(selectedProjectRef.current)) {
      return { value: selectedProjectNotesRef.current, selection };
    }
    const next = applyMarkdownToolbarAction(selectedProjectNotesRef.current, selection, actionId);
    applySelectedProjectNotesValue(next.value, {
      baseSelection: selection,
      nextSelection: next.selection,
    });
    return next;
  }, [applySelectedProjectNotesValue, isProjectReadOnly]);

  const commitSelectedProjectNotes = useCallback(() => {
    const current = selectedProjectRef.current;
    if (!current || isProjectReadOnly(current)) return;
    const nextNotes = selectedProjectNotesRef.current;
    if (nextNotes === committedProjectNotesRef.current) return;
    committedProjectNotesRef.current = nextNotes;
    updateProject(current.id, { supportNotes: nextNotes });
  }, [isProjectReadOnly, updateProject]);

  const handleSelectedProjectNotesApplyAutocomplete = useCallback((next: { value: string; selection: MarkdownSelection }) => {
    const current = selectedProjectRef.current;
    if (!current || isProjectReadOnly(current)) return;
    applySelectedProjectNotesValue(next.value, {
      baseSelection: selectedProjectNotesSelectionRef.current,
      nextSelection: next.selection,
    });
    selectedProjectNotesSelectionRef.current = next.selection;
    committedProjectNotesRef.current = next.value;
    updateProject(current.id, { supportNotes: next.value });
  }, [applySelectedProjectNotesValue, isProjectReadOnly, updateProject]);

  const resetProjectNotesUi = useCallback(() => {
    setNotesExpanded(false);
    setShowNotesPreview(false);
    setNotesFullscreen(false);
  }, []);

  return {
    notesExpanded,
    setNotesExpanded,
    showNotesPreview,
    setShowNotesPreview,
    notesFullscreen,
    setNotesFullscreen,
    selectedProjectNotes,
    selectedProjectNotesDirection,
    selectedProjectNotesTextDirectionStyle,
    selectedProjectNotesInputRef,
    selectedProjectNotesUndoDepth,
    isSelectedProjectNotesFocused,
    setIsSelectedProjectNotesFocused,
    selectedProjectNotesSelection,
    commitSelectedProjectNotes,
    handleSelectedProjectNotesApplyAction,
    handleSelectedProjectNotesApplyAutocomplete,
    handleSelectedProjectNotesChange,
    handleSelectedProjectNotesSelectionChange,
    handleSelectedProjectNotesUndo,
    resetProjectNotesUi,
  };
}

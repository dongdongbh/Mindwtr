import { useCallback, useEffect, useRef, useState } from 'react';
import { TextInput } from 'react-native';
import {
  applyMarkdownToolbarAction,
  continueMarkdownOnTextChange,
  resolveAutoTextDirection,
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
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [showNotesPreview, setShowNotesPreview] = useState(false);
  const [notesFullscreen, setNotesFullscreen] = useState(false);
  const selectedProjectNotesRef = useRef('');
  const selectedProjectNotesInputRef = useRef<TextInput | null>(null);
  const selectedProjectNotesUndoRef = useRef<Array<{ value: string; selection: MarkdownSelection }>>([]);
  const [selectedProjectNotesUndoDepth, setSelectedProjectNotesUndoDepth] = useState(0);
  const [isSelectedProjectNotesFocused, setIsSelectedProjectNotesFocused] = useState(false);
  const [selectedProjectNotesSelection, setSelectedProjectNotesSelection] = useState({ start: 0, end: 0 });
  const selectedProjectNotesSelectionRef = useRef<MarkdownSelection>({ start: 0, end: 0 });
  const pendingSelectedProjectNotesSelectionRef = useRef<MarkdownSelection | null>(null);
  const selectedProjectNotes = selectedProject?.supportNotes || '';
  const selectedProjectNotesDirection = selectedProject
    ? resolveAutoTextDirection(`${selectedProject.title ?? ''}\n${selectedProjectNotes}`.trim(), language)
    : 'ltr';
  const selectedProjectNotesTextDirectionStyle = {
    writingDirection: selectedProjectNotesDirection,
    textAlign: selectedProjectNotesDirection === 'rtl' ? 'right' : 'left',
  } as const;

  useEffect(() => {
    selectedProjectNotesRef.current = selectedProject?.supportNotes || '';
    const selectionEnd = (selectedProject?.supportNotes || '').length;
    selectedProjectNotesUndoRef.current = [];
    setSelectedProjectNotesUndoDepth(0);
    setIsSelectedProjectNotesFocused(false);
    pendingSelectedProjectNotesSelectionRef.current = null;
    selectedProjectNotesSelectionRef.current = { start: selectionEnd, end: selectionEnd };
    setSelectedProjectNotesSelection({ start: selectionEnd, end: selectionEnd });
  }, [selectedProject]);

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
    if (!selectedProject) return;
    if ((options?.recordUndo ?? true) && text !== selectedProjectNotes) {
      pushSelectedProjectNotesUndoEntry(selectedProjectNotes, options?.baseSelection ?? selectedProjectNotesSelectionRef.current);
    }
    selectedProjectNotesRef.current = text;
    setSelectedProject({ ...selectedProject, supportNotes: text });
    if (options?.nextSelection) {
      selectedProjectNotesSelectionRef.current = options.nextSelection;
      setSelectedProjectNotesSelection(options.nextSelection);
    }
  }, [pushSelectedProjectNotesUndoEntry, selectedProject, selectedProjectNotes, setSelectedProject]);

  const restoreSelectedProjectNotesSelection = useCallback((selection: MarkdownSelection) => {
    pendingSelectedProjectNotesSelectionRef.current = selection;
    const applySelection = () => {
      selectedProjectNotesInputRef.current?.setNativeProps?.({ selection });
    };
    requestAnimationFrame(applySelection);
    setTimeout(() => {
      applySelection();
      if (
        pendingSelectedProjectNotesSelectionRef.current
        && selectionsEqual(pendingSelectedProjectNotesSelectionRef.current, selection)
      ) {
        pendingSelectedProjectNotesSelectionRef.current = null;
      }
    }, 40);
  }, []);

  const handleSelectedProjectNotesChange = useCallback((text: string) => {
    const continued = continueMarkdownOnTextChange(
      selectedProjectNotesRef.current,
      text,
      selectedProjectNotesSelectionRef.current,
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
  }, [applySelectedProjectNotesValue, restoreSelectedProjectNotesSelection]);

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
    const previousEntry = selectedProjectNotesUndoRef.current[selectedProjectNotesUndoRef.current.length - 1];
    if (!previousEntry) return undefined;
    selectedProjectNotesUndoRef.current = selectedProjectNotesUndoRef.current.slice(0, -1);
    setSelectedProjectNotesUndoDepth(selectedProjectNotesUndoRef.current.length);
    applySelectedProjectNotesValue(previousEntry.value, {
      nextSelection: previousEntry.selection,
      recordUndo: false,
    });
    return previousEntry.selection;
  }, [applySelectedProjectNotesValue]);

  const handleSelectedProjectNotesApplyAction = useCallback((actionId: MarkdownToolbarActionId, selection: MarkdownSelection): MarkdownToolbarResult => {
    const next = applyMarkdownToolbarAction(selectedProjectNotesRef.current, selection, actionId);
    applySelectedProjectNotesValue(next.value, {
      baseSelection: selection,
      nextSelection: next.selection,
    });
    return next;
  }, [applySelectedProjectNotesValue]);

  const commitSelectedProjectNotes = useCallback(() => {
    if (!selectedProject) return;
    updateProject(selectedProject.id, { supportNotes: selectedProjectNotesRef.current });
  }, [selectedProject, updateProject]);

  const handleSelectedProjectNotesApplyAutocomplete = useCallback((next: { value: string; selection: MarkdownSelection }) => {
    applySelectedProjectNotesValue(next.value, {
      baseSelection: selectedProjectNotesSelectionRef.current,
      nextSelection: next.selection,
    });
    selectedProjectNotesSelectionRef.current = next.selection;
    if (selectedProject) {
      updateProject(selectedProject.id, { supportNotes: next.value });
    }
  }, [applySelectedProjectNotesValue, selectedProject, updateProject]);

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

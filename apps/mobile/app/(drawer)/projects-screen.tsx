import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, Alert, SectionList, Dimensions, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AREA_PRESET_COLORS, Attachment, DEFAULT_PROJECT_COLOR, generateUUID, normalizeLinkAttachmentInput, Project, resolveAutoTextDirection, Task, type MarkdownSelection, type MarkdownToolbarActionId, type MarkdownToolbarResult, applyMarkdownToolbarAction, continueMarkdownOnTextChange, useTaskStore, validateAttachmentForUpload } from '@mindwtr/core';
import * as DocumentPicker from 'expo-document-picker';
import * as Linking from 'expo-linking';
import * as Sharing from 'expo-sharing';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { projectsScreenStyles as styles } from '@/components/projects-screen/projects-screen.styles';
import {
  formatProjectDate,
  normalizeProjectTag,
  resolveAttachmentValidationMessage,
} from '@/components/projects-screen/projects-screen.utils';
import { openProjectAreaPicker, openProjectTagPicker } from '@/components/projects-screen/project-meta-pickers';
import { ProjectAreaModals } from '@/components/projects-screen/ProjectAreaModals';
import { ProjectDetailModal } from '@/components/projects-screen/ProjectDetailModal';
import { ProjectImagePreviewModal, ProjectLinkModal, ProjectTagPickerModal } from '@/components/projects-screen/ProjectOverlayModals';
import { ProjectRow } from '@/components/projects-screen/ProjectRow';
import { TaskEditModal } from '@/components/task-edit-modal';
import { useProjectFiltering, type ProjectSectionItem } from '@/hooks/use-project-filtering';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useLanguage } from '../../contexts/language-context';
import { useToast } from '../../contexts/toast-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { ListSectionHeader, defaultListContentStyle } from '@/components/list-layout';
import { ensureAttachmentAvailable } from '../../lib/attachment-sync';
import { logError, logWarn } from '../../lib/app-log';
import { AREA_FILTER_ALL, AREA_FILTER_NONE } from '@/lib/area-filter';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';

const selectionsEqual = (left: MarkdownSelection, right: MarkdownSelection) => (
  left.start === right.start && left.end === right.end
);

export default function ProjectsScreen() {
  const { projects, tasks, addProject, updateProject, deleteProject, toggleProjectFocus, addArea, updateArea, deleteArea, reorderAreas, updateTask, setHighlightTask } = useTaskStore();
  const { t, language } = useLanguage();
  const { showToast } = useToast();
  const tc = useThemeColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const statusPalette: Record<Project['status'], { text: string; bg: string; border: string }> = {
    active: { text: tc.tint, bg: `${tc.tint}22`, border: tc.tint },
    waiting: { text: '#F59E0B', bg: '#F59E0B22', border: '#F59E0B' },
    someday: { text: '#A855F7', bg: '#A855F722', border: '#A855F7' },
    archived: { text: tc.secondaryText, bg: tc.filterBg, border: tc.border },
  };
  const [newProjectTitle, setNewProjectTitle] = useState('');
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [showNotesPreview, setShowNotesPreview] = useState(false);
  const [notesFullscreen, setNotesFullscreen] = useState(false);
  const [showProjectMeta, setShowProjectMeta] = useState(false);
  const [showDueDatePicker, setShowDueDatePicker] = useState(false);
  const [showReviewPicker, setShowReviewPicker] = useState(false);
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [linkModalVisible, setLinkModalVisible] = useState(false);
  const [imagePreviewAttachment, setImagePreviewAttachment] = useState<Attachment | null>(null);
  const [linkInput, setLinkInput] = useState('');
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [showAreaPicker, setShowAreaPicker] = useState(false);
  const [showAreaManager, setShowAreaManager] = useState(false);
  const [newAreaName, setNewAreaName] = useState('');
  const [newAreaColor, setNewAreaColor] = useState('#3b82f6');
  const [expandedAreaColorId, setExpandedAreaColorId] = useState<string | null>(null);
  const { projectId, taskId, openToken } = useLocalSearchParams<{ projectId?: string; taskId?: string; openToken?: string }>();
  const lastOpenedTaskKeyRef = useRef<string | null>(null);
  const selectedProjectNotesRef = useRef('');
  const ALL_TAGS = '__all__';
  const NO_TAGS = '__none__';
  const ALL_AREAS = AREA_FILTER_ALL;
  const NO_AREA = AREA_FILTER_NONE;
  const [selectedTagFilter, setSelectedTagFilter] = useState(ALL_TAGS);
  const [showTagPicker, setShowTagPicker] = useState(false);
  const {
    areaById,
    resolvedAreaFilter: selectedAreaFilter,
    sortedAreas,
  } = useMobileAreaFilter();

  const logProjectError = useCallback((message: string, error?: unknown) => {
    if (!error) return;
    void logError(error, { scope: 'project', extra: { message } });
  }, []);
  const [showTagFilter, setShowTagFilter] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const selectedProjectNotesInputRef = useRef<TextInput | null>(null);
  const selectedProjectNotesUndoRef = useRef<Array<{ value: string; selection: MarkdownSelection }>>([]);
  const [selectedProjectNotesUndoDepth, setSelectedProjectNotesUndoDepth] = useState(0);
  const [isSelectedProjectNotesFocused, setIsSelectedProjectNotesFocused] = useState(false);
  const [selectedProjectNotesSelection, setSelectedProjectNotesSelection] = useState({ start: 0, end: 0 });
  const selectedProjectNotesSelectionRef = useRef<MarkdownSelection>({ start: 0, end: 0 });
  const pendingSelectedProjectNotesSelectionRef = useRef<MarkdownSelection | null>(null);
  const windowHeight = Dimensions.get('window').height;
  const pickerCardMaxHeight = Math.min(windowHeight * 0.8, 560);
  const areaListMaxHeight = Math.min(windowHeight * 0.4, 280);
  const areaManagerListMaxHeight = Math.min(windowHeight * 0.45, 320);
  const overlayModalPresentation = Platform.OS === 'ios' ? 'overFullScreen' : 'fullScreen';

  const colors = AREA_PRESET_COLORS;
  const colorDisplayByHex: Record<string, { nameKey: string; swatch: string }> = {
    '#3b82f6': { nameKey: 'projects.colorBlue', swatch: '🔵' },
    '#10b981': { nameKey: 'projects.colorGreen', swatch: '🟢' },
    '#f59e0b': { nameKey: 'projects.colorAmber', swatch: '🟠' },
    '#ef4444': { nameKey: 'projects.colorRed', swatch: '🔴' },
    '#8b5cf6': { nameKey: 'projects.colorPurple', swatch: '🟣' },
    '#ec4899': { nameKey: 'projects.colorPink', swatch: '🩷' },
  };
  const {
    areaUsage,
    focusedCount,
    groupedProjects,
    projectTagOptions,
    tagFilterOptions,
  } = useProjectFiltering({
    projects,
    tasks,
    sortedAreas,
    areaById,
    selectedTagFilter,
    selectedAreaFilter,
    allTagsValue: ALL_TAGS,
    noTagsValue: NO_TAGS,
    t,
  });

  const openProject = useCallback((project: Project) => {
    setSelectedProject(project);
    setNotesExpanded(false);
    setShowNotesPreview(false);
    setNotesFullscreen(false);
    setShowProjectMeta(false);
    setShowDueDatePicker(false);
    setShowReviewPicker(false);
    setShowStatusMenu(false);
    setLinkModalVisible(false);
    setLinkInput('');
  }, []);

  useEffect(() => {
    if (!projectId || typeof projectId !== 'string') return;
    const project = projects.find((item) => item.id === projectId && !item.deletedAt);
    if (project) {
      openProject(project);
    }
  }, [projectId, projects, openProject]);

  useEffect(() => {
    if (!taskId || typeof taskId !== 'string') return;
    if (!selectedProject || selectedProject.id !== projectId) return;
    const openKey = `${taskId}:${typeof openToken === 'string' ? openToken : ''}`;
    if (lastOpenedTaskKeyRef.current === openKey) return;
    const task = tasks.find((item) => item.id === taskId && !item.deletedAt);
    if (!task || task.projectId !== selectedProject.id) return;
    lastOpenedTaskKeyRef.current = openKey;
    setHighlightTask(task.id);
    setEditingTask(task);
  }, [openToken, taskId, projectId, selectedProject, tasks, setHighlightTask]);

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

  const sortAreasByName = () => {
    const reordered = [...sortedAreas]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((area) => area.id);
    reorderAreas(reordered);
  };

  const sortAreasByColor = () => {
    const reordered = [...sortedAreas]
      .sort((a, b) => {
        const colorA = (a.color || '').toLowerCase();
        const colorB = (b.color || '').toLowerCase();
        if (colorA && colorB && colorA !== colorB) return colorA.localeCompare(colorB);
        if (colorA && !colorB) return -1;
        if (!colorA && colorB) return 1;
        return a.name.localeCompare(b.name);
      })
      .map((area) => area.id);
    reorderAreas(reordered);
  };

  const toggleProjectTag = (tag: string) => {
    if (!selectedProject) return;
    const normalized = normalizeProjectTag(tag);
    if (!normalized) return;
    const current = selectedProject.tagIds || [];
    const exists = current.includes(normalized);
    const next = exists ? current.filter((t) => t !== normalized) : [...current, normalized];
    updateProject(selectedProject.id, { tagIds: next });
    setSelectedProject({ ...selectedProject, tagIds: next });
  };

  const renderSectionItem = ({ item }: { item: ProjectSectionItem }) => {
    return (
      <ProjectRow
        project={item.data}
        tasks={tasks}
        areaById={areaById}
        tc={tc}
        focusedCount={focusedCount}
        statusPalette={statusPalette}
        t={t}
        onDeleteProject={deleteProject}
        onOpenProject={openProject}
        onToggleProjectFocus={toggleProjectFocus}
      />
    );
  };

  const selectedProjectNotes = selectedProject?.supportNotes || '';
  const selectedProjectAreaName = selectedProject?.areaId && areaById.has(selectedProject.areaId)
    ? areaById.get(selectedProject.areaId)?.name || t('projects.noArea')
    : t('projects.noArea');
  const selectedProjectNotesDirection = selectedProject
    ? resolveAutoTextDirection(`${selectedProject.title ?? ''}\n${selectedProjectNotes}`.trim(), language)
    : 'ltr';
  const selectedProjectNotesTextDirectionStyle = {
    writingDirection: selectedProjectNotesDirection,
    textAlign: selectedProjectNotesDirection === 'rtl' ? 'right' : 'left',
  } as const;
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
  }, [pushSelectedProjectNotesUndoEntry, selectedProject, selectedProjectNotes]);
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
  }, [applySelectedProjectNotesValue, selectedProjectNotesRef]);
  const commitSelectedProjectNotes = () => {
    if (!selectedProject) return;
    updateProject(selectedProject.id, { supportNotes: selectedProjectNotesRef.current });
  };
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


  const handleAddProject = () => {
    if (newProjectTitle.trim()) {
      const inferredAreaId =
        selectedAreaFilter !== ALL_AREAS && selectedAreaFilter !== NO_AREA && areaById.has(selectedAreaFilter)
          ? selectedAreaFilter
          : undefined;
      const areaColor = inferredAreaId ? areaById.get(inferredAreaId)?.color : undefined;
      addProject(newProjectTitle, areaColor || DEFAULT_PROJECT_COLOR, {
        areaId: inferredAreaId,
      });
      setNewProjectTitle('');
    }
  };

  const persistSelectedProjectEdits = (project: Project | null) => {
    if (!project) return;
    const original = projects.find((p) => p.id === project.id);
    if (!original) return;

    const nextTitle = project.title.trim();
    const nextArea = project.areaId || undefined;
    const prevArea = original.areaId || undefined;

    const updates: Partial<Project> = {};
    if (nextTitle && nextTitle !== original.title) updates.title = nextTitle;
    if (nextArea !== prevArea) updates.areaId = nextArea;
    if ((project.tagIds || []).join('|') !== (original.tagIds || []).join('|')) {
      updates.tagIds = project.tagIds || [];
    }

    if (Object.keys(updates).length > 0) {
      updateProject(project.id, updates);
    }
  };

  const closeProjectDetail = () => {
    persistSelectedProjectEdits(selectedProject);
    setSelectedProject(null);
    setNotesExpanded(false);
    setShowNotesPreview(false);
    setNotesFullscreen(false);
    setShowProjectMeta(false);
    setShowReviewPicker(false);
    setShowStatusMenu(false);
    setLinkModalVisible(false);
    setLinkInput('');
    setShowAreaPicker(false);
    setShowTagPicker(false);
    if (projectId && router.canGoBack()) {
      router.back();
    }
  };

  const handleSetProjectStatus = (status: Project['status']) => {
    if (!selectedProject) return;
    updateProject(selectedProject.id, { status });
    setSelectedProject({ ...selectedProject, status });
    setShowStatusMenu(false);
  };

  const handleArchiveSelectedProject = () => {
    if (!selectedProject) return;
    Alert.alert(
      t('projects.title'),
      t('projects.archiveConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('projects.archive'),
          style: 'destructive',
          onPress: () => {
            updateProject(selectedProject.id, { status: 'archived' });
            setSelectedProject({ ...selectedProject, status: 'archived' });
          }
        }
      ]
    );
  };

  const openAreaPicker = () => {
    openProjectAreaPicker({
      addArea,
      areaUsage,
      colorDisplayByHex,
      colors,
      deleteArea,
      logProjectError,
      selectedProject,
      setSelectedProject,
      setShowAreaPicker,
      setShowStatusMenu,
      showToast,
      sortAreasByColor,
      sortAreasByName,
      sortedAreas,
      t,
      updateArea,
      updateProject,
    });
  };

  const openTagPicker = () => {
    openProjectTagPicker({
      projectTagOptions,
      selectedProject,
      setSelectedProject,
      setShowStatusMenu,
      setShowTagPicker,
      setTagDraft,
      t,
      toggleProjectTag,
      updateProject,
    });
  };

  const updateAttachmentStatus = (
    attachments: Attachment[],
    id: string,
    status: Attachment['localStatus']
  ): Attachment[] =>
    attachments.map((item): Attachment =>
      item.id === id ? { ...item, localStatus: status } : item
    );

  const isImageAttachment = useCallback((attachment: Attachment) => {
    const mime = attachment.mimeType?.toLowerCase();
    if (mime?.startsWith('image/')) return true;
    return /\.(png|jpg|jpeg|gif|webp|heic|heif)$/i.test(attachment.uri);
  }, []);

  const openAttachment = async (attachment: Attachment) => {
    const shouldDownload = attachment.kind === 'file'
      && attachment.cloudKey
      && (attachment.localStatus === 'missing' || !attachment.uri);
    if (shouldDownload && selectedProject) {
      const next = updateAttachmentStatus(
        selectedProject.attachments || [],
        attachment.id,
        'downloading'
      );
      updateProject(selectedProject.id, { attachments: next });
      setSelectedProject({ ...selectedProject, attachments: next });
    }

    const resolved = await ensureAttachmentAvailable(attachment);
    if (!resolved) {
      if (shouldDownload && selectedProject) {
        const next = updateAttachmentStatus(
          selectedProject.attachments || [],
          attachment.id,
          'missing'
        );
        updateProject(selectedProject.id, { attachments: next });
        setSelectedProject({ ...selectedProject, attachments: next });
      }
      const message = attachment.kind === 'file' ? t('attachments.missing') : t('attachments.fileNotSupported');
      Alert.alert(t('attachments.title'), message);
      return;
    }
    if (resolved.uri !== attachment.uri || resolved.localStatus !== attachment.localStatus) {
      const next = (selectedProject?.attachments || []).map((item): Attachment =>
        item.id === resolved.id ? { ...item, ...resolved } : item
      );
      if (selectedProject) {
        updateProject(selectedProject.id, { attachments: next });
        setSelectedProject({ ...selectedProject, attachments: next });
      }
    }

    if (resolved.kind === 'link') {
      Linking.openURL(resolved.uri).catch((error) => logProjectError('Failed to open attachment URL', error));
      return;
    }
    if (isImageAttachment(resolved)) {
      setImagePreviewAttachment(resolved);
      return;
    }

    const available = await Sharing.isAvailableAsync().catch((error) => {
      void logWarn('[Sharing] availability check failed', {
        scope: 'project',
        extra: { error: error instanceof Error ? error.message : String(error) },
      });
      return false;
    });
    if (available) {
      Sharing.shareAsync(resolved.uri).catch((error) => logProjectError('Failed to share attachment', error));
    } else {
      Linking.openURL(resolved.uri).catch((error) => logProjectError('Failed to open attachment URL', error));
    }
  };

  useEffect(() => {
    if (!selectedProject) {
      setImagePreviewAttachment(null);
    }
  }, [selectedProject]);

  const downloadAttachment = async (attachment: Attachment) => {
    if (!selectedProject) return;
    const shouldDownload = attachment.kind === 'file'
      && attachment.cloudKey
      && (attachment.localStatus === 'missing' || !attachment.uri);
    if (shouldDownload) {
      const next = updateAttachmentStatus(
        selectedProject.attachments || [],
        attachment.id,
        'downloading'
      );
      updateProject(selectedProject.id, { attachments: next });
      setSelectedProject({ ...selectedProject, attachments: next });
    }

    const resolved = await ensureAttachmentAvailable(attachment);
    if (!resolved) {
      const next = updateAttachmentStatus(
        selectedProject.attachments || [],
        attachment.id,
        'missing'
      );
      updateProject(selectedProject.id, { attachments: next });
      setSelectedProject({ ...selectedProject, attachments: next });
      const message = attachment.kind === 'file' ? t('attachments.missing') : t('attachments.fileNotSupported');
      Alert.alert(t('attachments.title'), message);
      return;
    }
    if (resolved.uri !== attachment.uri || resolved.localStatus !== attachment.localStatus) {
      const next = (selectedProject.attachments || []).map((item): Attachment =>
        item.id === resolved.id ? { ...item, ...resolved } : item
      );
      updateProject(selectedProject.id, { attachments: next });
      setSelectedProject({ ...selectedProject, attachments: next });
    }
  };

  const addProjectFileAttachment = async () => {
    if (!selectedProject) return;
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: false,
      multiple: false,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    const size = asset.size;
    if (typeof size === 'number') {
      const validation = await validateAttachmentForUpload(
        {
          id: 'pending',
          kind: 'file',
          title: asset.name || 'file',
          uri: asset.uri,
          mimeType: asset.mimeType,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        size
      );
      if (!validation.valid) {
        Alert.alert(t('attachments.title'), resolveAttachmentValidationMessage(validation.error, t));
        return;
      }
    }
    const now = new Date().toISOString();
    const attachment: Attachment = {
      id: generateUUID(),
      kind: 'file',
      title: asset.name || 'file',
      uri: asset.uri,
      mimeType: asset.mimeType,
      size: asset.size,
      createdAt: now,
      updatedAt: now,
      localStatus: 'available',
    };
    const next = [...(selectedProject.attachments || []), attachment];
    updateProject(selectedProject.id, { attachments: next });
    setSelectedProject({ ...selectedProject, attachments: next });
  };

  const confirmAddProjectLink = () => {
    if (!selectedProject) return;
    const normalized = normalizeLinkAttachmentInput(linkInput);
    if (!normalized.uri) return;
    const now = new Date().toISOString();
    const attachment: Attachment = {
      id: generateUUID(),
      kind: normalized.kind,
      title: normalized.title,
      uri: normalized.uri,
      createdAt: now,
      updatedAt: now,
    };
    const next = [...(selectedProject.attachments || []), attachment];
    updateProject(selectedProject.id, { attachments: next });
    setSelectedProject({ ...selectedProject, attachments: next });
    setLinkModalVisible(false);
    setLinkInput('');
  };

  const removeProjectAttachment = (id: string) => {
    if (!selectedProject) return;
    const now = new Date().toISOString();
    const next = (selectedProject.attachments || []).map((a) =>
      a.id === id ? { ...a, deletedAt: now, updatedAt: now } : a
    );
    updateProject(selectedProject.id, { attachments: next });
    setSelectedProject({ ...selectedProject, attachments: next });
  };


  const modalHeaderStyle = [styles.modalHeader, {
    borderBottomColor: tc.border,
    backgroundColor: tc.cardBg,
    paddingTop: Math.max(insets.top, 10),
    paddingBottom: 10,
  }];

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <View style={[styles.inputContainer, { borderBottomColor: tc.border }]}>
        <TextInput
          style={[styles.input, { borderColor: tc.border, backgroundColor: tc.inputBg, color: tc.text }]}
          placeholder={t('projects.addPlaceholder')}
          placeholderTextColor={tc.secondaryText}
          value={newProjectTitle}
          onChangeText={setNewProjectTitle}
          onSubmitEditing={handleAddProject}
          returnKeyType="done"
        />
        <View style={styles.filterSection}>
          <TouchableOpacity
            style={styles.filterHeader}
            onPress={() => setShowTagFilter((prev) => !prev)}
          >
            <Text style={[styles.tagFilterLabel, { color: tc.text }]}>{t('projects.tagFilter')}</Text>
            <Text style={[styles.filterToggleText, { color: tc.secondaryText }]}>
              {showTagFilter ? t('filters.hide') : t('filters.show')}
            </Text>
          </TouchableOpacity>
          {showTagFilter && (
            <View style={styles.tagFilterChips}>
              <TouchableOpacity
                style={[
                  styles.tagFilterChip,
                  selectedTagFilter === ALL_TAGS
                    ? { borderColor: tc.tint, backgroundColor: tc.tint }
                    : { borderColor: tc.border, backgroundColor: tc.cardBg },
                ]}
                onPress={() => setSelectedTagFilter(ALL_TAGS)}
              >
                <Text
                  style={[
                    styles.tagFilterText,
                    { color: selectedTagFilter === ALL_TAGS ? tc.onTint : tc.text },
                  ]}
                >
                  {t('projects.allTags')}
                </Text>
              </TouchableOpacity>
              {tagFilterOptions.list.map((tag) => (
                <TouchableOpacity
                  key={tag}
                  style={[
                    styles.tagFilterChip,
                    selectedTagFilter === tag
                      ? { borderColor: tc.tint, backgroundColor: tc.tint }
                      : { borderColor: tc.border, backgroundColor: tc.cardBg },
                  ]}
                  onPress={() => setSelectedTagFilter(tag)}
                >
                  <Text
                    style={[
                      styles.tagFilterText,
                      { color: selectedTagFilter === tag ? tc.onTint : tc.text },
                    ]}
                  >
                    {tag}
                  </Text>
                </TouchableOpacity>
              ))}
              {tagFilterOptions.hasNoTags && (
                <TouchableOpacity
                  style={[
                    styles.tagFilterChip,
                    selectedTagFilter === NO_TAGS
                      ? { borderColor: tc.tint, backgroundColor: tc.tint }
                      : { borderColor: tc.border, backgroundColor: tc.cardBg },
                  ]}
                  onPress={() => setSelectedTagFilter(NO_TAGS)}
                >
                  <Text
                    style={[
                      styles.tagFilterText,
                      { color: selectedTagFilter === NO_TAGS ? tc.onTint : tc.text },
                    ]}
                  >
                    {t('projects.noTags')}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>
        <TouchableOpacity
          onPress={handleAddProject}
          style={[
            styles.addButton,
            { backgroundColor: tc.tint },
            !newProjectTitle.trim() && styles.addButtonDisabled,
          ]}
          disabled={!newProjectTitle.trim()}
        >
          <Text style={styles.addButtonText}>{t('projects.add')}</Text>
        </TouchableOpacity>
      </View>

      <SectionList
        sections={groupedProjects}
        keyExtractor={(item) => `${item.type}-${item.data.id}`}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={defaultListContentStyle}
        style={{ flex: 1 }}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{t('projects.empty')}</Text>
          </View>
        }
        renderSectionHeader={({ section }) => (
          <ListSectionHeader title={section.title} tc={tc} />
        )}
        renderItem={({ item }) => renderSectionItem({ item })}
      />

      <ProjectDetailModal
        addProjectFileAttachment={addProjectFileAttachment}
        closeProjectDetail={closeProjectDetail}
        commitSelectedProjectNotes={commitSelectedProjectNotes}
        formatProjectDate={formatProjectDate}
        handleArchiveSelectedProject={handleArchiveSelectedProject}
        handleSelectedProjectNotesApplyAction={handleSelectedProjectNotesApplyAction}
        handleSelectedProjectNotesApplyAutocomplete={handleSelectedProjectNotesApplyAutocomplete}
        handleSelectedProjectNotesChange={handleSelectedProjectNotesChange}
        handleSelectedProjectNotesSelectionChange={handleSelectedProjectNotesSelectionChange}
        handleSelectedProjectNotesUndo={handleSelectedProjectNotesUndo}
        handleSetProjectStatus={handleSetProjectStatus}
        isSelectedProjectNotesFocused={isSelectedProjectNotesFocused}
        modalHeaderStyle={modalHeaderStyle as Array<Record<string, unknown>>}
        notesExpanded={notesExpanded}
        notesFullscreen={notesFullscreen}
        onCloseNotesFullscreen={() => setNotesFullscreen(false)}
        onDownloadAttachment={downloadAttachment}
        onOpenAreaPicker={openAreaPicker}
        onOpenAttachment={openAttachment}
        onOpenTagPicker={openTagPicker}
        onRemoveProjectAttachment={removeProjectAttachment}
        onSetLinkInput={setLinkInput}
        onSetLinkModalVisible={setLinkModalVisible}
        onSetNotesExpanded={setNotesExpanded}
        onSetSelectedProject={setSelectedProject}
        onSetSelectedProjectNotesFocused={setIsSelectedProjectNotesFocused}
        onSetShowDueDatePicker={setShowDueDatePicker}
        onSetShowNotesFullscreen={setNotesFullscreen}
        onSetShowNotesPreview={setShowNotesPreview}
        onSetShowProjectMeta={setShowProjectMeta}
        onSetShowReviewPicker={setShowReviewPicker}
        onSetShowStatusMenu={setShowStatusMenu}
        overlayVisible={!!selectedProject}
        presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
        selectedProject={selectedProject}
        selectedProjectAreaName={selectedProjectAreaName}
        selectedProjectNotes={selectedProjectNotes}
        selectedProjectNotesDirection={selectedProjectNotesDirection}
        selectedProjectNotesInputRef={selectedProjectNotesInputRef}
        selectedProjectNotesSelection={selectedProjectNotesSelection}
        selectedProjectNotesTextDirectionStyle={selectedProjectNotesTextDirectionStyle}
        selectedProjectNotesUndoDepth={selectedProjectNotesUndoDepth}
        showDueDatePicker={showDueDatePicker}
        showNotesPreview={showNotesPreview}
        showProjectMeta={showProjectMeta}
        showReviewPicker={showReviewPicker}
        showStatusMenu={showStatusMenu}
        statusPalette={statusPalette}
        t={t}
        tc={tc}
        updateProject={updateProject}
      />

      <TaskEditModal
        visible={editingTask !== null}
        task={editingTask}
        onClose={() => setEditingTask(null)}
        onSave={(taskId, updates) => updateTask(taskId, updates)}
        defaultTab="view"
        onProjectNavigate={(projectId) => {
          if (!selectedProject || selectedProject.id !== projectId) {
            openProjectScreen(projectId);
          }
        }}
        onContextNavigate={openContextsScreen}
        onTagNavigate={openContextsScreen}
      />

      <ProjectLinkModal
        visible={linkModalVisible}
        presentationStyle={overlayModalPresentation}
        tc={tc}
        t={t}
        linkInput={linkInput}
        onChangeLinkInput={setLinkInput}
        onClose={() => {
          setLinkModalVisible(false);
          setLinkInput('');
        }}
        onSave={confirmAddProjectLink}
      />
      <ProjectImagePreviewModal
        visible={Boolean(imagePreviewAttachment)}
        attachment={imagePreviewAttachment}
        presentationStyle={overlayModalPresentation}
        tc={tc}
        t={t}
        onClose={() => setImagePreviewAttachment(null)}
      />
      <ProjectAreaModals
        addArea={addArea}
        areaListMaxHeight={areaListMaxHeight}
        areaManagerListMaxHeight={areaManagerListMaxHeight}
        areaUsage={areaUsage}
        colors={colors}
        expandedAreaColorId={expandedAreaColorId}
        newAreaColor={newAreaColor}
        newAreaName={newAreaName}
        onCloseAreaManager={() => {
          setShowAreaManager(false);
          setExpandedAreaColorId(null);
        }}
        onDeleteArea={deleteArea}
        onSetExpandedAreaColorId={setExpandedAreaColorId}
        onSetNewAreaColor={setNewAreaColor}
        onSetNewAreaName={setNewAreaName}
        onSetSelectedProject={setSelectedProject}
        onSetShowAreaManager={setShowAreaManager}
        onSetShowAreaPicker={setShowAreaPicker}
        onShowToast={showToast}
        overlayModalPresentation={overlayModalPresentation}
        pickerCardMaxHeight={pickerCardMaxHeight}
        selectedProject={selectedProject}
        showAreaManager={showAreaManager}
        showAreaPicker={showAreaPicker}
        sortedAreas={sortedAreas}
        sortAreasByColor={sortAreasByColor}
        sortAreasByName={sortAreasByName}
        t={t}
        tc={tc}
        updateArea={updateArea}
        updateProject={updateProject}
      />
      <ProjectTagPickerModal
        visible={showTagPicker}
        presentationStyle={overlayModalPresentation}
        tc={tc}
        t={t}
        tagDraft={tagDraft}
        projectTagOptions={projectTagOptions}
        selectedTags={selectedProject?.tagIds || []}
        onChangeTagDraft={setTagDraft}
        onAddTag={() => {
          const nextTag = normalizeProjectTag(tagDraft);
          if (!nextTag) return;
          toggleProjectTag(nextTag);
          setTagDraft('');
        }}
        onClose={() => setShowTagPicker(false)}
        onToggleTag={toggleProjectTag}
      />
      </View>
    </GestureHandlerRootView>
  );
}

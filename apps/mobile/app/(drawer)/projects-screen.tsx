import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useStartupScreenReady } from '@/hooks/use-startup-screen-ready';
import { workspaceSessionStorage as AsyncStorage } from '@/lib/workspace-session-storage';
import { View, Text, TextInput, TouchableOpacity, FlatList, Platform, useWindowDimensions } from 'react-native';
import type { GettingStartedAction } from '@/components/GettingStartedActions';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AREA_PRESET_COLORS, areaOrderIdsForIntent, Attachment, collectProjectTaskLinks, DEFAULT_PROJECT_COLOR, getProjectSectionsForView, planProjectMove, Project, type ProjectAreaGroup, projectTagsForIntent, shallow, Task, type Section, type TaskSortBy, undoProjectDelete, updateProjectFromDraft, useTaskStore } from '@mindwtr/core';
import { useFocusEffect, useLocalSearchParams, usePathname, useRouter } from 'expo-router';
import { runAfterCaptureRouteGone, SHEET_DISMISS_SETTLE_MS } from '@/lib/capture-route-presence';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react-native';

import {
  DEFAULT_PROJECT_LIST_VIEW_STATE,
  PROJECT_LIST_VIEW_STATE_STORAGE_KEY,
  type ProjectListViewState,
  compactCollapsedAreas,
  readProjectListViewState,
  serializeProjectListViewState,
} from '@/lib/view-state/project-list-view-state';
import { projectsScreenStyles as styles } from '@/components/projects-screen/projects-screen.styles';
import { persistLastRoute, setSessionRestoreOpenProject } from '@/lib/session-restore';
import {
  buildProjectQuickCaptureReturnTo,
  buildProjectStatusPalette,
  normalizeProjectTag,
  resolveAttachmentValidationMessage,
} from '@/components/projects-screen/projects-screen.utils';
import {
  applyLiveProjectUpdate,
  getLiveMutableProject,
  openProjectAreaPicker,
  openProjectTagPicker,
} from '@/components/projects-screen/project-meta-pickers';
import { ProjectAreaModals } from '@/components/projects-screen/ProjectAreaModals';
import { ProjectDetailModal } from '@/components/projects-screen/ProjectDetailModal';
import { ProjectImagePreviewModal, ProjectLinkModal, ProjectTagPickerModal } from '@/components/projects-screen/ProjectOverlayModals';
import { ProjectRow } from '@/components/projects-screen/ProjectRow';
import {
  buildProjectListRows,
  type ProjectListRow,
} from '@/components/projects-screen/project-list-model';
import { useProjectAttachments } from '@/components/projects-screen/use-project-attachments';
import { useProjectNotesEditor } from '@/components/projects-screen/use-project-notes-editor';
import { TaskEditModal } from '@/components/task-edit-modal';
import type { TaskEditTab } from '@/components/task-edit/use-task-edit-state';
import { useProjectFiltering } from '@/hooks/use-project-filtering';
import { useAndroidActivitySession } from '@/hooks/use-android-activity-session';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useQuickCapture } from '../../contexts/quick-capture-context';
import { useLanguage } from '../../contexts/language-context';
import { useToast } from '../../contexts/toast-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { ListSectionHeader, defaultListContentStyle } from '@/components/list-layout';
import { logError, logWarn } from '../../lib/app-log';
import { AREA_FILTER_ALL, AREA_FILTER_NONE, areaFilterSelectionToValue, flushPendingSave } from '@mindwtr/core';
import { consumePendingCaptureTaskOpen, openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { CompactText, CompactTextInput } from '@/components/compact-text';

type ProjectTaskSortBy = TaskSortBy;
type ProjectSelectionActivityState = { projectId: string };

const isProjectSelectionActivityStateShape = (value: unknown): value is ProjectSelectionActivityState => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.projectId === 'string' && candidate.projectId.length > 0;
};

const EMPTY_PROJECT_TASKS: Task[] = [];
function resolveTaskRouteTab(value?: string | string[]): TaskEditTab {
  const routeValue = Array.isArray(value) ? value[0] : value;
  return routeValue === 'task' ? 'task' : 'view';
}

export default function ProjectsScreen() {
  const onStartupLayout = useStartupScreenReady('projects');
  const {
    projects,
    allProjects,
    tasks,
    allTasks,
    sections,
    allSections,
    addProject,
    updateProject,
    deleteProject,
    duplicateProject,
    toggleProjectFocus,
    addArea,
    updateArea,
    deleteArea,
    reorderAreas,
    reorderProjects,
    setHighlightTask,
    projectTaskSummaryById,
  } = useTaskStore((state) => ({
    projects: state.projects,
    allProjects: state._allProjects,
    tasks: state.tasks,
    allTasks: state._allTasks,
    sections: state.sections,
    allSections: state._allSections,
    addProject: state.addProject,
    updateProject: state.updateProject,
    deleteProject: state.deleteProject,
    duplicateProject: state.duplicateProject,
    toggleProjectFocus: state.toggleProjectFocus,
    addArea: state.addArea,
    updateArea: state.updateArea,
    deleteArea: state.deleteArea,
    reorderAreas: state.reorderAreas,
    reorderProjects: state.reorderProjects,
    setHighlightTask: state.setHighlightTask,
    projectTaskSummaryById: state.getDerivedState().projectTaskSummaryById,
  }), shallow);
  const { t, language } = useLanguage();
  const { showToast } = useToast();
  const { openQuickCapture } = useQuickCapture();
  const tc = useThemeColors();
  const filledButton = useFilledButtonColors();
  const focusedProjectCount = useMemo(
    () => projects.reduce(
      (count, project) => count + (!project.deletedAt && project.isFocused ? 1 : 0),
      0,
    ),
    [projects],
  );
  const router = useRouter();
  const statusPalette = buildProjectStatusPalette(tc);
  const [newProjectTitle, setNewProjectTitle] = useState('');
  const [newProjectAreaId, setNewProjectAreaId] = useState('');
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const selectedProjectRef = useRef(selectedProject);
  selectedProjectRef.current = selectedProject;
  // The row the open project's edits started from: set when a project opens, then advanced field by field
  // once the stored row agrees with the draft (a persist or a live write landed it). Closing then writes only
  // what the user changed, not a field another device synced while the sheet was open.
  const selectedProjectBaseRef = useRef<Project | null>(null);
  if (!selectedProject || selectedProjectBaseRef.current?.id !== selectedProject.id) {
    selectedProjectBaseRef.current = selectedProject;
  } else {
    const live = projects.find((project) => project.id === selectedProject.id);
    const base = selectedProjectBaseRef.current;
    if (live && base) {
      selectedProjectBaseRef.current = {
        ...base,
        ...(selectedProject.title.trim() === live.title.trim() ? { title: live.title } : {}),
        ...((selectedProject.areaId || undefined) === (live.areaId || undefined) ? { areaId: live.areaId } : {}),
        ...((selectedProject.tagIds || []).join('|') === (live.tagIds || []).join('|') ? { tagIds: live.tagIds } : {}),
      };
    }
  }
  const [projectActivityRecoveryEnabled, setProjectActivityRecoveryEnabled] = useState(true);
  const [projectTaskSortBy, setProjectTaskSortBy] = useState<ProjectTaskSortBy>('default');
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [taskModalDefaultTab, setTaskModalDefaultTab] = useState<TaskEditTab>('view');
  const [taskModalOpenKey, setTaskModalOpenKey] = useState('manual');
  const [showAreaPicker, setShowAreaPicker] = useState(false);
  const [showAreaManager, setShowAreaManager] = useState(false);
  const [newAreaName, setNewAreaName] = useState('');
  const [newAreaColor, setNewAreaColor] = useState('#3b82f6');
  const [expandedAreaColorId, setExpandedAreaColorId] = useState<string | null>(null);
  const { projectId, taskId, openToken, taskTab } = useLocalSearchParams<{ projectId?: string; taskId?: string; openToken?: string; taskTab?: string }>();
  const lastOpenedTaskKeyRef = useRef<string | null>(null);
  const handledRouteProjectKeyRef = useRef<string | null>(null);
  const pathname = usePathname();

  // The open project lives in component state, not the route — mirror it into
  // the session snapshot so an interrupted session reopens the project, not
  // just the projects list (#842). Re-persist immediately: an OS kill can
  // arrive without another navigation or background event.
  useEffect(() => {
    setSessionRestoreOpenProject(selectedProject?.id ?? null);
    void persistLastRoute(pathname);
  }, [pathname, selectedProject?.id]);
  useEffect(() => () => {
    setSessionRestoreOpenProject(null);
  }, []);
  const ALL_TAGS = '__all__';
  const NO_TAGS = '__none__';
  const ALL_AREAS = AREA_FILTER_ALL;
  const NO_AREA = AREA_FILTER_NONE;
  const [selectedTagFilter, setSelectedTagFilter] = useState(ALL_TAGS);
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [collapsedAreas, setCollapsedAreas] = useState<Record<string, boolean>>({});
  const [projectListViewStateHydrated, setProjectListViewStateHydrated] = useState(false);
  const [showDeferredProjects, setShowDeferredProjects] = useState(false);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const projectListViewStateRef = useRef<ProjectListViewState>(DEFAULT_PROJECT_LIST_VIEW_STATE);
  const projectListViewStateTouchedRef = useRef(false);
  const {
    areaById,
    resolvedAreaFilter: selectedAreaFilter,
    sortedAreas,
  } = useMobileAreaFilter();

  const selectedAreaFilterValue = areaFilterSelectionToValue(selectedAreaFilter);

  useEffect(() => {
    setNewProjectAreaId(
      selectedAreaFilterValue !== ALL_AREAS && selectedAreaFilterValue !== NO_AREA ? selectedAreaFilterValue : ''
    );
  }, [selectedAreaFilterValue, ALL_AREAS, NO_AREA]);

  const logProjectError = useCallback((message: string, error?: unknown) => {
    if (!error) return;
    void logError(error, { scope: 'project', extra: { message } });
  }, []);
  const applyProjectListViewState = useCallback((nextState: ProjectListViewState) => {
    const compactState = {
      ...nextState,
      collapsedAreas: compactCollapsedAreas(nextState.collapsedAreas),
    };
    projectListViewStateRef.current = compactState;
    setCollapsedAreas(compactState.collapsedAreas);
    setShowArchivedProjects(compactState.showArchivedProjects);
    setShowDeferredProjects(compactState.showDeferredProjects);
  }, []);
  const persistProjectListViewState = useCallback((nextState: ProjectListViewState) => {
    const compactState = {
      ...nextState,
      collapsedAreas: compactCollapsedAreas(nextState.collapsedAreas),
    };
    projectListViewStateRef.current = compactState;
    AsyncStorage.setItem(PROJECT_LIST_VIEW_STATE_STORAGE_KEY, serializeProjectListViewState(compactState))
      .catch(() => undefined);
  }, []);
  const resolveText = useCallback((key: string, fallback: string) => {
    const value = t(key);
    return value && value !== key ? value : fallback;
  }, [t]);
  const [showTagFilter, setShowTagFilter] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const { height: windowHeight } = useWindowDimensions();
  const pickerCardMaxHeight = Math.min(windowHeight * 0.8, 560);
  const areaListMaxHeight = Math.min(windowHeight * 0.4, 280);
  const areaManagerListMaxHeight = Math.min(windowHeight * 0.45, 320);
  const overlayModalPresentation = 'overFullScreen' as const;

  const colors = AREA_PRESET_COLORS;
  const {
    areaUsage,
    focusedCount,
    groupedActiveProjects,
    groupedDeferredProjects,
    groupedArchivedProjects,
    projectTagOptions,
    tagFilterOptions,
  } = useProjectFiltering({
    projects,
    tasks,
    sortedAreas,
    selectedTagFilter,
    selectedAreaFilter,
    allTagsValue: ALL_TAGS,
    noTagsValue: NO_TAGS,
    focusedProjectCount,
  });
  const notesEditor = useProjectNotesEditor({
    selectedProject,
    setSelectedProject,
    updateProject,
    language,
  });
  const { commitSelectedProjectNotes, resetProjectNotesUi } = notesEditor;
  const notesEditorRef = useRef(notesEditor);
  notesEditorRef.current = notesEditor;

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(PROJECT_LIST_VIEW_STATE_STORAGE_KEY)
      .then((raw) => {
        if (!active) return;
        if (!projectListViewStateTouchedRef.current) {
          const persisted = readProjectListViewState(raw);
          if (persisted) {
            applyProjectListViewState(persisted);
          }
        }
        setProjectListViewStateHydrated(true);
      })
      .catch(() => {
        if (active) {
          setProjectListViewStateHydrated(true);
        }
      });
    return () => {
      active = false;
    };
  }, [applyProjectListViewState]);
  const attachments = useProjectAttachments({
    selectedProject,
    setSelectedProject,
    updateProject,
    t,
    logProjectError,
  });
  const {
    linkModalVisible,
    setLinkModalVisible,
    imagePreviewAttachment,
    setImagePreviewAttachment,
    linkInput,
    setLinkInput,
    confirmAddProjectLink,
    resetProjectAttachmentUi,
  } = attachments;

  const projectListRows = useMemo(() => {
    if (!projectListViewStateHydrated) return [];
    return buildProjectListRows({
      areaById,
      collapsedAreas,
      groupedActiveProjects,
      groupedArchivedProjects,
      groupedDeferredProjects,
      showArchivedProjects,
      showDeferredProjects,
      t,
    });
  }, [
    areaById,
    collapsedAreas,
    groupedActiveProjects,
    groupedArchivedProjects,
    groupedDeferredProjects,
    projectListViewStateHydrated,
    showArchivedProjects,
    showDeferredProjects,
    t,
  ]);
  const projectListEmptyLabel = projectListViewStateHydrated
    ? t('projects.empty')
    : resolveText('common.loading', 'Loading...');

  // Memos key off the id so a project object refresh with the same id reuses results.
  const selectedProjectIdForLists = selectedProject?.id ?? null;
  const selectedProjectTasks = useMemo(() => {
    if (!selectedProjectIdForLists || !allTasks) return EMPTY_PROJECT_TASKS;
    return allTasks.filter(
      (task) => task.projectId === selectedProjectIdForLists && !task.deletedAt
    );
  }, [allTasks, selectedProjectIdForLists]);
  const selectedProjectSections = useMemo<Section[]>(
    () => getProjectSectionsForView(selectedProject, sections, allSections),
    [allSections, sections, selectedProject],
  );
  const liveSelectedProject = selectedProject
    ? allProjects?.find((project) => project.id === selectedProject.id)
    : null;
  const selectedProjectIsArchived = selectedProject?.status === 'archived'
    || liveSelectedProject?.status === 'archived';

  useEffect(() => {
    if (!selectedProjectIsArchived) return;
    setShowAreaPicker(false);
    setShowAreaManager(false);
    setShowTagPicker(false);
  }, [selectedProjectIsArchived]);

  const openProject = useCallback((project: Project) => {
    setProjectActivityRecoveryEnabled(true);
    setSelectedProject(project);
    setProjectTaskSortBy(project.taskSortBy ?? 'default');
    resetProjectNotesUi();
    resetProjectAttachmentUi();
  }, [resetProjectAttachmentUi, resetProjectNotesUi]);
  const validateProjectSelectionActivityState = useCallback((value: unknown): value is ProjectSelectionActivityState => {
    if (!isProjectSelectionActivityStateShape(value)) return false;
    return projects.some((project) => project.id === value.projectId && !project.deletedAt);
  }, [projects]);
  const restoreProjectSelection = useCallback((recovered: ProjectSelectionActivityState) => {
    const project = projects.find((candidate) => (
      candidate.id === recovered.projectId && !candidate.deletedAt
    ));
    if (project) openProject(project);
  }, [openProject, projects]);
  const { clear: clearProjectSelectionActivity } = useAndroidActivitySession({
    enabled: projectActivityRecoveryEnabled,
    ownerId: `projects-screen:${pathname}`,
    value: selectedProject ? { projectId: selectedProject.id } : null,
    validate: validateProjectSelectionActivityState,
    onRestore: restoreProjectSelection,
  });

  // Keep the open project's sort in step with the store, so a sort chosen on
  // another device (arriving via sync) reorders the already-open detail view.
  // Local writes set the same value first, making this a no-op for them.
  const liveSelectedProjectTaskSortBy = selectedProject
    ? (projects.find((p) => p.id === selectedProject.id)?.taskSortBy ?? 'default')
    : null;
  useEffect(() => {
    if (liveSelectedProjectTaskSortBy === null) return;
    setProjectTaskSortBy(liveSelectedProjectTaskSortBy);
  }, [liveSelectedProjectTaskSortBy]);

  // Persist the chosen sort on the project so it survives reopening the project
  // and syncs across devices; core normalizes 'default' to an absent field.
  const handleProjectTaskSortByChange = useCallback((next: ProjectTaskSortBy) => {
    if (selectedProject?.status === 'archived') return;
    if (projects.find((project) => project.id === selectedProject?.id)?.status === 'archived') return;
    setProjectTaskSortBy(next);
    if (selectedProject) {
      updateProject(selectedProject.id, { taskSortBy: next });
    }
  }, [projects, selectedProject, updateProject]);

  const reopenProjectIdAfterCaptureRef = useRef<string | null>(null);
  const pendingGettingStartedAction = useRef<GettingStartedAction | null>(null);
  const pendingProjectDismissActionRef = useRef<(() => void) | null>(null);
  const reopenProjectAfterEditorRef = useRef<Project | null>(null);

  useEffect(() => {
    if (!projectId || typeof projectId !== 'string') return;
    // Handle each open request once per screen instance — re-running on
    // unrelated store updates would reset the open project's sort and pickers,
    // and would reopen a project the user just closed. A fresh openToken marks
    // a new explicit request, so tapping the same project again still opens it.
    const openKey = `${projectId}:${typeof openToken === 'string' ? openToken : ''}`;
    if (handledRouteProjectKeyRef.current === openKey) return;
    const project = projects.find((item) => item.id === projectId && !item.deletedAt);
    if (project) {
      handledRouteProjectKeyRef.current = openKey;
      // Tokenless re-visits (capture returnTo, session restore) must not reset
      // the detail state of a project that is already open.
      if (selectedProject?.id !== project.id) {
        openProject(project);
      }
    }
  }, [projectId, openToken, projects, openProject, selectedProject?.id]);

  useEffect(() => {
    if (!taskId || typeof taskId !== 'string') return;
    if (!selectedProject || selectedProject.id !== projectId) return;
    const nextTaskTab = resolveTaskRouteTab(taskTab);
    const openKey = `${taskId}:${typeof openToken === 'string' ? openToken : ''}:${nextTaskTab}`;
    if (lastOpenedTaskKeyRef.current === openKey) return;
    const task = allTasks?.find((item) => item.id === taskId && !item.deletedAt);
    if (!task || task.projectId !== selectedProject.id) return;
    lastOpenedTaskKeyRef.current = openKey;
    setHighlightTask(task.id);
    setTaskModalDefaultTab(nextTaskTab);
    setTaskModalOpenKey(`route:${openKey}`);
    setEditingTask(task);
  }, [allTasks, openToken, taskId, projectId, selectedProject, taskTab, setHighlightTask]);

  const sortAreasByName = () => {
    const orderedIds = areaOrderIdsForIntent(sortedAreas, { kind: 'sortName' });
    if (orderedIds) reorderAreas(orderedIds);
  };

  const sortAreasByColor = () => {
    const orderedIds = areaOrderIdsForIntent(sortedAreas, { kind: 'sortColor' });
    if (orderedIds) reorderAreas(orderedIds);
  };

  // A chip toggles its tag; the picker's + only adds the typed one (a tag already there stays).
  const changeProjectTag = (tag: string, kind: 'add' | 'toggle') => {
    if (!selectedProject) return;
    const normalized = normalizeProjectTag(tag);
    if (!normalized) return;
    applyLiveProjectUpdate({
      projectId: selectedProject.id,
      updates: (project) => {
        const current = project.tagIds || [];
        return { tagIds: projectTagsForIntent(current, { kind, input: tag }) };
      },
      updateProject,
      setSelectedProject,
      onBlocked: () => setShowTagPicker(false),
    });
  };
  const toggleProjectTag = (tag: string) => changeProjectTag(tag, 'toggle');

  const handleDeleteProject = useCallback((projectIdToDelete: string) => {
    // Deleting detaches the project's tasks, and only Undo can know which they
    // were -- the links must be read before the delete.
    const detachedTasks = collectProjectTaskLinks(projectIdToDelete);
    void Promise.resolve(deleteProject(projectIdToDelete))
      .then(() => {
        if (selectedProject?.id === projectIdToDelete) {
          clearProjectSelectionActivity();
          setProjectActivityRecoveryEnabled(false);
          setSelectedProject(null);
        }
        showToast({
          title: resolveText('common.notice', 'Notice'),
          message: resolveText('projects.deleted', 'Project moved to Trash'),
          tone: 'info',
          actionLabel: resolveText('common.undo', 'Undo'),
          onAction: () => {
            void undoProjectDelete(projectIdToDelete, detachedTasks)
              .catch((error) => {
                logProjectError('Failed to restore project', error);
                showToast({
                  title: resolveText('common.notice', 'Notice'),
                  message: resolveText('projects.restoreFailed', 'Failed to restore project'),
                  tone: 'error',
                });
              });
          },
          durationMs: 5200,
        });
      })
      .catch((error) => {
        logProjectError('Failed to delete project', error);
        showToast({
          title: resolveText('common.notice', 'Notice'),
          message: resolveText('projects.deleteFailed', 'Failed to delete project'),
          tone: 'error',
        });
      });
  }, [
    clearProjectSelectionActivity,
    deleteProject,
    logProjectError,
    resolveText,
    selectedProject?.id,
    showToast,
  ]);

  const handleDuplicateProject = useCallback((projectIdToDuplicate: string) => {
    void Promise.resolve(duplicateProject(projectIdToDuplicate))
      .then((createdProject) => {
        if (!createdProject) {
          showToast({
            title: resolveText('common.notice', 'Notice'),
            message: resolveText('projects.duplicateFailed', 'Failed to duplicate project'),
            tone: 'error',
          });
          return;
        }
        setSelectedProject(createdProject);
        showToast({
          title: resolveText('common.done', 'Done'),
          message: resolveText('projects.duplicated', 'Project duplicated'),
          tone: 'success',
        });
      })
      .catch((error) => {
        logProjectError('Failed to duplicate project', error);
        showToast({
          title: resolveText('common.notice', 'Notice'),
          message: resolveText('projects.duplicateFailed', 'Failed to duplicate project'),
          tone: 'error',
        });
      });
  }, [duplicateProject, logProjectError, resolveText, showToast]);

  const moveProject = (
    project: Project,
    group: ProjectAreaGroup | undefined,
    direction: 'up' | 'down',
  ) => {
    const plan = group ? planProjectMove(group, allProjects, project.id, direction) : null;
    if (!plan) return undefined;
    return () => {
      void Promise.resolve(reorderProjects(plan.orderedIds, plan.areaId)).catch((error) => {
        logProjectError('Failed to move project', error);
        showToast({
          title: resolveText('common.notice', 'Notice'),
          message: resolveText('projects.moveProjectFailed', 'Failed to move project'),
          tone: 'error',
        });
      });
    };
  };

  const renderProjectItem = (project: Project, sectionKind: 'active' | 'deferred' | 'archived') => {
    const groups = sectionKind === 'active'
      ? groupedActiveProjects
      : sectionKind === 'deferred' ? groupedDeferredProjects : groupedArchivedProjects;
    const group = groups.find((entry) => entry.projects.some((item) => item.id === project.id));
    return (
      <ProjectRow
        project={project}
        taskSummary={projectTaskSummaryById.get(project.id)}
        tc={tc}
        focusedCount={focusedCount}
        statusPalette={statusPalette}
        t={t}
        onDeleteProject={handleDeleteProject}
        onDuplicateProject={handleDuplicateProject}
        onOpenProject={openProject}
        onToggleProjectFocus={toggleProjectFocus}
        onMoveUp={moveProject(project, group, 'up')}
        onMoveDown={moveProject(project, group, 'down')}
      />
    );
  };

  const toggleAreaCollapse = useCallback((areaId: string) => {
    projectListViewStateTouchedRef.current = true;
    const current = projectListViewStateRef.current;
    const collapsedAreas = { ...current.collapsedAreas };
    if (collapsedAreas[areaId]) {
      delete collapsedAreas[areaId];
    } else {
      collapsedAreas[areaId] = true;
    }
    const nextState = {
      ...current,
      collapsedAreas,
    };
    setCollapsedAreas(compactCollapsedAreas(collapsedAreas));
    persistProjectListViewState(nextState);
  }, [persistProjectListViewState]);

  const toggleProjectSection = useCallback((sectionKind: Extract<ProjectListRow, { type: 'section-toggle' }>['sectionKind']) => {
    projectListViewStateTouchedRef.current = true;
    const current = projectListViewStateRef.current;
    if (sectionKind === 'deferred') {
      const nextState = {
        ...current,
        showDeferredProjects: !current.showDeferredProjects,
      };
      setShowDeferredProjects(nextState.showDeferredProjects);
      persistProjectListViewState(nextState);
      return;
    }
    const nextState = {
      ...current,
      showArchivedProjects: !current.showArchivedProjects,
    };
    setShowArchivedProjects(nextState.showArchivedProjects);
    persistProjectListViewState(nextState);
  }, [persistProjectListViewState]);

  const projectTagFilterActive = selectedTagFilter !== ALL_TAGS;
  const projectTagLabel = (tag: string) => tag === '' ? t('projects.emptyTag') : tag;
  const selectedTagFilterLabel = selectedTagFilter === NO_TAGS
    ? t('projects.noTags')
    : projectTagLabel(selectedTagFilter);
  const projectTagFilterHeading = projectTagFilterActive
    ? `${t('projects.tagFilter')}: ${selectedTagFilterLabel}`
    : t('projects.tagFilter');
  const projectTagFilterActionLabel = showTagFilter ? t('filters.hide') : t('filters.show');
  const renderProjectTagFilters = () => (
    <View style={[styles.tagFilterChips, styles.projectTagFilterChips]}>
      <TouchableOpacity
        style={[
          styles.tagFilterChip,
          selectedTagFilter === ALL_TAGS
            ? { borderColor: tc.tint, backgroundColor: tc.tint }
            : { borderColor: tc.border, backgroundColor: tc.cardBg },
        ]}
        onPress={() => setSelectedTagFilter(ALL_TAGS)}
        accessibilityRole="button"
        accessibilityLabel={t('projects.allTags')}
        accessibilityState={{ selected: selectedTagFilter === ALL_TAGS }}
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
          accessibilityRole="button"
          accessibilityLabel={projectTagLabel(tag)}
          accessibilityState={{ selected: selectedTagFilter === tag }}
        >
          <Text
            style={[
              styles.tagFilterText,
              { color: selectedTagFilter === tag ? tc.onTint : tc.text },
            ]}
          >
            {projectTagLabel(tag)}
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
          accessibilityRole="button"
          accessibilityLabel={t('projects.noTags')}
          accessibilityState={{ selected: selectedTagFilter === NO_TAGS }}
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
  );

  const renderProjectListRow = ({ item, index }: { item: ProjectListRow; index: number }) => {
    if (item.type === 'section-label') {
      return <ListSectionHeader title={item.title} tc={tc} style={styles.projectListSectionHeader} />;
    }

    if (item.type === 'section-toggle') {
      const showTopBorder = index > 0;
      return (
        <TouchableOpacity
          onPress={() => {
            toggleProjectSection(item.sectionKind);
          }}
          style={[
            styles.collapsibleSectionToggle,
            showTopBorder && { borderTopWidth: 1, borderTopColor: tc.border },
          ]}
        >
          <Text style={[styles.collapsibleSectionToggleText, { color: tc.secondaryText }]}>
            {item.title}
          </Text>
          {item.expanded
            ? <ChevronDown size={16} color={tc.secondaryText} strokeWidth={2.2} />
            : <ChevronRight size={16} color={tc.secondaryText} strokeWidth={2.2} />}
        </TouchableOpacity>
      );
    }

    if (item.type === 'area-header') {
      return (
        <TouchableOpacity
          testID={`project-area-header-${item.sectionKind}-${item.areaId}`}
          onPress={() => toggleAreaCollapse(item.areaId)}
          style={styles.collapsibleAreaHeader}
          accessibilityRole="button"
          accessibilityLabel={item.title}
          accessibilityState={{ expanded: !item.collapsed }}
        >
          <View style={styles.collapsibleAreaHeaderContent}>
            {item.icon ? (
              <Text
                testID={`project-area-icon-${item.areaId}`}
                style={[styles.collapsibleAreaIcon, { color: tc.secondaryText }]}
              >
                {item.icon}
              </Text>
            ) : item.color ? (
              <View
                testID={`project-area-dot-${item.areaId}`}
                style={[
                  styles.collapsibleAreaDot,
                  { backgroundColor: item.color, borderColor: tc.border },
                ]}
              />
            ) : null}
            <Text style={[styles.collapsibleAreaHeaderText, { color: tc.secondaryText }]} numberOfLines={1}>
              {item.title}
            </Text>
          </View>
          {item.collapsed
            ? <ChevronRight size={16} color={tc.secondaryText} strokeWidth={2.2} />
            : <ChevronDown size={16} color={tc.secondaryText} strokeWidth={2.2} />}
        </TouchableOpacity>
      );
    }

    return renderProjectItem(item.project, item.sectionKind);
  };

  const selectedProjectAreaName = selectedProject?.areaId && areaById.has(selectedProject.areaId)
    ? areaById.get(selectedProject.areaId)?.name || t('projects.noArea')
    : t('projects.noArea');

  const handleAddProject = () => {
    if (newProjectTitle.trim()) {
      const resolvedAreaId =
        newProjectAreaId && areaById.has(newProjectAreaId) ? newProjectAreaId : undefined;
      const areaColor = resolvedAreaId ? areaById.get(resolvedAreaId)?.color : undefined;
      addProject(newProjectTitle, areaColor || DEFAULT_PROJECT_COLOR, {
        areaId: resolvedAreaId,
      });
      setNewProjectTitle('');
      setNewProjectAreaId(
        selectedAreaFilterValue !== ALL_AREAS && selectedAreaFilterValue !== NO_AREA ? selectedAreaFilterValue : ''
      );
    }
  };

  const persistSelectedProjectEdits = (project: Project | null) => {
    if (!project || project.status === 'archived') return;
    const original = projects.find((p) => p.id === project.id);
    if (!original || original.status === 'archived') return;

    const nextTitle = project.title.trim();
    const updates: Partial<Project> = { areaId: project.areaId || undefined, tagIds: project.tagIds || [] };
    if (nextTitle) updates.title = nextTitle;
    const opened = selectedProjectBaseRef.current?.id === project.id ? selectedProjectBaseRef.current : original;
    // Compared as saved (trimmed), so outer spaces in the stored title do not read as the user's rename.
    const base = { ...opened, title: opened.title.trim(), areaId: opened.areaId || undefined, tagIds: opened.tagIds || [] };
    selectedProjectBaseRef.current = { ...base, ...updates };
    // Only the fields changed since the sheet opened are written, onto the latest row.
    return updateProjectFromDraft(project.id, base, updates);
  };
  const persistSelectedProjectEditsRef = useRef(persistSelectedProjectEdits);
  persistSelectedProjectEditsRef.current = persistSelectedProjectEdits;

  // Quick add is a pushed route, but the project detail is a native modal
  // (pageSheet on iOS) whose visibility is derived from selectedProject.
  // Moving the route while that stays set desyncs the two: coming back, the
  // state still says "open" so the sheet never re-presents, and tapping the
  // same project sets identical state — no transition, so the row reads as
  // dead until the screen is remounted (#938). Dismiss on the way out and
  // restore on the way back, so re-opening is always a real false -> true
  // transition. Edits are committed first, exactly as closing by hand does.
  const openProjectQuickAdd = useCallback((projectToAddTo: Project) => {
    commitSelectedProjectNotes();
    persistSelectedProjectEdits(selectedProject);
    reopenProjectIdAfterCaptureRef.current = projectToAddTo.id;
    setSelectedProject(null);
    const openCapture = () => openQuickCapture({
      initialProps: {
        projectId: projectToAddTo.id,
        status: 'next',
      },
      returnTo: buildProjectQuickCaptureReturnTo(projectToAddTo.id),
    });
    // UIKit must finish dismissing the project sheet before presenting capture,
    // as for the Getting Started actions below.
    if (Platform.OS === 'ios') {
      pendingProjectDismissActionRef.current = openCapture;
      return;
    }
    openCapture();
    // commitSelectedProjectNotes/persistSelectedProjectEdits are re-created every
    // render; listing them would rebuild this callback on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openQuickCapture, selectedProject, projects, updateProject]);

  // Read through refs so this callback's identity never changes: useFocusEffect
  // re-runs whenever the callback it is given changes, and openProject is
  // rebuilt every render, which would re-open the project on every render and
  // undo the dismissal above.
  const openProjectRef = useRef(openProject);
  openProjectRef.current = openProject;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const tasksRef = useRef(allTasks ?? []);
  tasksRef.current = allTasks ?? [];
  const routeProjectIdRef = useRef(typeof projectId === 'string' ? projectId : undefined);
  routeProjectIdRef.current = typeof projectId === 'string' ? projectId : undefined;

  useFocusEffect(
    useCallback(() => runAfterCaptureRouteGone(() => {
      const pendingId = reopenProjectIdAfterCaptureRef.current;
      reopenProjectIdAfterCaptureRef.current = null;
      const project = pendingId
        ? projectsRef.current.find((item) => item.id === pendingId && !item.deletedAt)
        : undefined;
      // Save & edit from this project's capture: open the editor on THIS
      // screen instance. The capture route cannot navigate here — any
      // navigation to a screen that is already on top stacks a duplicate of
      // it, so leaving the project would take an extra back tap (#1029).
      const pendingTask = consumePendingCaptureTaskOpen(pendingId ?? routeProjectIdRef.current);
      const task = pendingTask
        ? tasksRef.current.find((item) => item.id === pendingTask.taskId && !item.deletedAt)
        : undefined;
      if (project) {
        // iOS presents one sheet at a time: the editor and the project are
        // siblings, so the second would be refused and leave an invisible
        // layer. Open the editor first and the project once it is dismissed.
        if (task && Platform.OS === 'ios') reopenProjectAfterEditorRef.current = project;
        else openProjectRef.current(project);
      }
      if (!pendingTask || !task) return;
      setHighlightTask(task.id);
      setTaskModalDefaultTab(pendingTask.taskTab);
      setTaskModalOpenKey(`capture:${pendingTask.taskId}`);
      setEditingTask(task);
      // Presenting a sheet while UIKit still dismisses the capture route is
      // refused and leaves an invisible layer over the list, so wait for it.
      // setHighlightTask (zustand) and the useState setters are stable; data
      // is read through refs so this callback never changes identity.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [])
  );

  const closeProjectDetail = (navigateBack = true) => {
    clearProjectSelectionActivity();
    setProjectActivityRecoveryEnabled(false);
    commitSelectedProjectNotes();
    persistSelectedProjectEdits(selectedProject);
    setSelectedProject(null);
    resetProjectNotesUi();
    resetProjectAttachmentUi();
    setShowAreaPicker(false);
    setShowTagPicker(false);
    if (navigateBack && projectId && router.canGoBack()) {
      router.back();
    }
  };

  const finishGettingStartedAction = () => {
    const action = pendingGettingStartedAction.current;
    pendingGettingStartedAction.current = null;
    if (action === 'capture') {
      openQuickCapture({ initialProps: { status: 'inbox' } });
    } else if (action === 'inbox') {
      router.navigate('/(drawer)/(tabs)/inbox');
    } else if (action === 'focus') {
      router.navigate('/(drawer)/(tabs)/focus');
    }
  };

  const handleProjectDetailDismiss = () => {
    const pendingAction = pendingProjectDismissActionRef.current;
    pendingProjectDismissActionRef.current = null;
    pendingAction?.();
    finishGettingStartedAction();
  };

  const openGettingStartedAction = (action: GettingStartedAction) => {
    pendingGettingStartedAction.current = action;
    closeProjectDetail(false);
    // UIKit must finish dismissing the project sheet before presenting capture.
    // Android does not expose Modal.onDismiss, so it follows the normal route path.
    if (Platform.OS !== 'ios') finishGettingStartedAction();
  };

  const openAreaPicker = () => {
    if (!selectedProject || !getLiveMutableProject(selectedProject.id)) return;
    openProjectAreaPicker({
      addArea,
      areaUsage,
      colors,
      deleteArea,
      logProjectError,
      selectedProject,
      setSelectedProject,
      setShowAreaPicker,
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
    if (!selectedProject || !getLiveMutableProject(selectedProject.id)) return;
    openProjectTagPicker({
      projectTagOptions,
      selectedProject,
      setSelectedProject,
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

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View onLayout={onStartupLayout} style={[styles.container, { backgroundColor: tc.bg }]}>
      <View
        style={[styles.inputContainer, { borderBottomColor: tc.border }]}
        testID="projects-list-controls"
      >
        <View style={styles.addProjectRow}>
          <CompactTextInput
            style={[styles.input, styles.addProjectInput, { borderColor: tc.border, backgroundColor: tc.inputBg, color: tc.text }]}
            placeholder={t('projects.addPlaceholder')}
            placeholderTextColor={tc.secondaryText}
            value={newProjectTitle}
            onChangeText={setNewProjectTitle}
            onSubmitEditing={handleAddProject}
            returnKeyType="done"
            accessibilityLabel={t('projects.addPlaceholder')}
          />
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={t('projects.add')}
            onPress={handleAddProject}
            style={[
              styles.addIconButton,
              { backgroundColor: filledButton.backgroundColor },
              !newProjectTitle.trim() && styles.addButtonDisabled,
            ]}
            disabled={!newProjectTitle.trim()}
          >
            <Plus size={22} color={filledButton.textColor ?? tc.onTint} strokeWidth={2.4} />
          </TouchableOpacity>
        </View>
        {newProjectTitle.trim().length > 0 && sortedAreas.length > 0 && (
          <View style={[styles.tagFilterChips, styles.newProjectAreaChips]}>
            <TouchableOpacity
              style={[
                styles.tagFilterChip,
                newProjectAreaId === ''
                  ? { borderColor: tc.tint, backgroundColor: tc.tint }
                  : { borderColor: tc.border, backgroundColor: tc.cardBg },
              ]}
              onPress={() => setNewProjectAreaId('')}
              accessibilityRole="button"
              accessibilityLabel={t('projects.noArea')}
              accessibilityState={{ selected: newProjectAreaId === '' }}
            >
              <Text
                style={[
                  styles.tagFilterText,
                  { color: newProjectAreaId === '' ? tc.onTint : tc.text },
                ]}
              >
                {t('projects.noArea')}
              </Text>
            </TouchableOpacity>
            {sortedAreas.map((area) => (
              <TouchableOpacity
                key={area.id}
                style={[
                  styles.tagFilterChip,
                  newProjectAreaId === area.id
                    ? { borderColor: tc.tint, backgroundColor: tc.tint }
                    : { borderColor: tc.border, backgroundColor: tc.cardBg },
                ]}
                onPress={() => setNewProjectAreaId(area.id)}
                accessibilityRole="button"
                accessibilityLabel={area.name}
                accessibilityState={{ selected: newProjectAreaId === area.id }}
              >
                <Text
                  style={[
                    styles.tagFilterText,
                    { color: newProjectAreaId === area.id ? tc.onTint : tc.text },
                  ]}
                >
                  {area.name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        <View style={styles.filterSection} testID="projects-tag-filter-section">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <TouchableOpacity
              accessibilityLabel={`${projectTagFilterHeading}, ${projectTagFilterActionLabel}`}
              accessibilityRole="button"
              accessibilityState={{ expanded: showTagFilter, selected: projectTagFilterActive }}
              onPress={() => setShowTagFilter((current) => !current)}
              style={[styles.filterHeader, { flex: 1 }]}
              testID="projects-tag-filter-toggle"
            >
              <CompactText
                numberOfLines={1}
                style={[
                  styles.tagFilterLabel,
                  { color: projectTagFilterActive ? tc.tint : tc.text },
                ]}
              >
                {projectTagFilterHeading}
              </CompactText>
              <CompactText
                adjustsFontSizeToFit
                minimumFontScale={0.78}
                numberOfLines={1}
                style={[styles.filterToggleText, { color: tc.secondaryText }]}
              >
                {projectTagFilterActionLabel}
              </CompactText>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={t('areas.manage')}
              onPress={() => setShowAreaManager(true)}
              style={[styles.areaSortButton, { borderColor: tc.border, minHeight: 44, justifyContent: 'center' }]}
            >
              <CompactText style={[styles.areaSortText, { color: tc.text }]}>{t('areas.manage')}</CompactText>
            </TouchableOpacity>
          </View>
          {showTagFilter ? renderProjectTagFilters() : null}
        </View>
      </View>

      <FlatList
        data={projectListRows}
        keyExtractor={(item) => item.key}
        contentContainerStyle={[defaultListContentStyle, styles.projectListContent]}
        style={{ flex: 1 }}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{projectListEmptyLabel}</Text>
          </View>
        }
        renderItem={renderProjectListRow}
        removeClippedSubviews={false}
      />

      <ProjectDetailModal
        areaName={selectedProjectAreaName}
        attachments={attachments}
        notes={notesEditor}
        onClose={() => closeProjectDetail()}
        onGettingStartedAction={openGettingStartedAction}
        onDismiss={handleProjectDetailDismiss}
        onDeleteProject={handleDeleteProject}
        onDuplicateProject={handleDuplicateProject}
        onBeforeConvertToSection={async () => {
          try {
            await commitSelectedProjectNotes();
            await persistSelectedProjectEdits(selectedProject);
            await flushPendingSave();
            return true;
          } catch {
            showToast({ title: resolveText('common.notice', 'Notice'), message: resolveText('projects.convertFailure.save-failed', 'Could not save. Retry the same conversion.'), tone: 'error' });
            return false;
          }
        }}
        onConvertedToSection={(result) => {
          clearProjectSelectionActivity();
          resetProjectNotesUi();
          const destination = useTaskStore.getState()._allProjects.find((project) => project.id === result.destinationProjectId);
          setSelectedProject(destination ?? null);
          const undo = async () => {
            try {
              await notesEditorRef.current.commitSelectedProjectNotes();
              await persistSelectedProjectEditsRef.current(selectedProjectRef.current);
              await flushPendingSave();
            } catch {
              showToast({ title: resolveText('common.notice', 'Notice'), message: resolveText('projects.convertUndoFailure.save-failed', 'Could not save the Undo. Retry.'), tone: 'error',
                actionLabel: resolveText('common.retry', 'Retry'), onAction: () => { void undo(); } });
              return;
            }
            const outcome = await useTaskStore.getState().undoProjectToSection(result.receipt);
            if (outcome.success) {
              const restored = useTaskStore.getState()._allProjects.find((project) => project.id === outcome.sourceProjectId);
              if (restored) setSelectedProject(restored);
              return;
            }
            showToast({
              title: resolveText('common.notice', 'Notice'),
              message: resolveText(`projects.convertUndoFailure.${outcome.reason}`, 'Could not undo the conversion.'),
              tone: 'error',
              actionLabel: outcome.reason === 'save-failed' ? resolveText('common.retry', 'Retry') : undefined,
              onAction: outcome.reason === 'save-failed' ? () => { void undo(); } : undefined,
            });
          };
          showToast({ title: resolveText('common.done', 'Done'), message: resolveText('projects.convertSuccess', 'Project converted to section.'), tone: 'success',
            actionLabel: resolveText('common.undo', 'Undo'), onAction: () => { void undo(); } });
        }}
        onOpenAreaPicker={openAreaPicker}
        onOpenQuickAdd={openProjectQuickAdd}
        onOpenTagPicker={openTagPicker}
        onProjectChange={setSelectedProject}
        onTaskSortByChange={handleProjectTaskSortByChange}
        project={selectedProject}
        sections={selectedProjectSections}
        taskSortBy={projectTaskSortBy}
        tasks={selectedProjectTasks}
      />

      <TaskEditModal
        key={taskModalOpenKey}
        visible={editingTask !== null}
        task={editingTask
          ? (allTasks?.find((task) => task.id === editingTask.id) ?? editingTask)
          : null}
        readOnly={Boolean(
          editingTask?.projectId
          && (
            allProjects?.find((project) => project.id === editingTask.projectId)?.status === 'archived'
            || (selectedProject?.id === editingTask.projectId && selectedProject.status === 'archived')
          )
        )}
        onClose={() => {
          setEditingTask(null);
          const project = reopenProjectAfterEditorRef.current;
          reopenProjectAfterEditorRef.current = null;
          // Wait for UIKit to finish removing the editor sheet (iOS only).
          if (project) setTimeout(() => openProjectRef.current(project), SHEET_DISMISS_SETTLE_MS);
        }}
        onSave={(taskId, updates) => {
          const state = useTaskStore.getState();
          const liveTask = state._allTasks?.find((task) => task.id === taskId);
          if (!liveTask) return { success: false };
          if (liveTask.projectId) {
            const liveProject = state._allProjects?.find((project) => project.id === liveTask.projectId);
            if (!liveProject || liveProject.deletedAt || liveProject.status === 'archived') return { success: false };
          }
          return state.updateTask(taskId, updates);
        }}
        defaultTab={taskModalDefaultTab}
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
        reorderAreas={reorderAreas}
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
          changeProjectTag(nextTag, 'add');
          setTagDraft('');
        }}
        onClose={() => setShowTagPicker(false)}
        onToggleTag={toggleProjectTag}
      />
      </View>
    </GestureHandlerRootView>
  );
}

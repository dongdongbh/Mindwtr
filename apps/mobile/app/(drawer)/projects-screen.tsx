import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { View, Text, TextInput, TouchableOpacity, FlatList, Dimensions } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AREA_PRESET_COLORS, Attachment, DEFAULT_PROJECT_COLOR, Project, shallow, Task, type Section, type TaskSortBy, useTaskStore } from '@mindwtr/core';
import { useFocusEffect, useLocalSearchParams, usePathname, useRouter } from 'expo-router';
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
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useQuickCapture } from '../../contexts/quick-capture-context';
import { useLanguage } from '../../contexts/language-context';
import { useToast } from '../../contexts/toast-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { ListSectionHeader, defaultListContentStyle } from '@/components/list-layout';
import { logError, logWarn } from '../../lib/app-log';
import { AREA_FILTER_ALL, AREA_FILTER_NONE, areaFilterSelectionToValue } from '@mindwtr/core';
import { consumePendingCaptureTaskOpen, openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { CompactText, CompactTextInput } from '@/components/compact-text';

type ProjectTaskSortBy = TaskSortBy;
const EMPTY_PROJECT_TASKS: Task[] = [];
function resolveTaskRouteTab(value?: string | string[]): TaskEditTab {
  const routeValue = Array.isArray(value) ? value[0] : value;
  return routeValue === 'task' ? 'task' : 'view';
}

export default function ProjectsScreen() {
  const {
    projects,
    allProjects,
    tasks,
    allTasks,
    sections,
    addProject,
    updateProject,
    deleteProject,
    restoreProject,
    duplicateProject,
    toggleProjectFocus,
    addArea,
    updateArea,
    deleteArea,
    reorderAreas,
    setHighlightTask,
    projectTaskSummaryById,
  } = useTaskStore((state) => ({
    projects: state.projects,
    allProjects: state._allProjects,
    tasks: state.tasks,
    allTasks: state._allTasks,
    sections: state.sections,
    addProject: state.addProject,
    updateProject: state.updateProject,
    deleteProject: state.deleteProject,
    restoreProject: state.restoreProject,
    duplicateProject: state.duplicateProject,
    toggleProjectFocus: state.toggleProjectFocus,
    addArea: state.addArea,
    updateArea: state.updateArea,
    deleteArea: state.deleteArea,
    reorderAreas: state.reorderAreas,
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
  const windowHeight = Dimensions.get('window').height;
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
  const selectedProjectSections = useMemo<Section[]>(() => {
    if (!selectedProjectIdForLists) return [];
    return sections
      .filter((section) => section.projectId === selectedProjectIdForLists && !section.deletedAt)
      .sort((a, b) => {
        const aOrder = Number.isFinite(a.order) ? a.order : 0;
        const bOrder = Number.isFinite(b.order) ? b.order : 0;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.title.localeCompare(b.title);
      });
  }, [sections, selectedProjectIdForLists]);
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
    setSelectedProject(project);
    setProjectTaskSortBy(project.taskSortBy ?? 'default');
    resetProjectNotesUi();
    resetProjectAttachmentUi();
  }, [resetProjectAttachmentUi, resetProjectNotesUi]);

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
    applyLiveProjectUpdate({
      projectId: selectedProject.id,
      updates: (project) => {
        const current = project.tagIds || [];
        const exists = current.includes(normalized);
        return { tagIds: exists ? current.filter((value) => value !== normalized) : [...current, normalized] };
      },
      updateProject,
      setSelectedProject,
      onBlocked: () => setShowTagPicker(false),
    });
  };

  const handleDeleteProject = useCallback((projectIdToDelete: string) => {
    void Promise.resolve(deleteProject(projectIdToDelete))
      .then(() => {
        if (selectedProject?.id === projectIdToDelete) {
          setSelectedProject(null);
        }
        showToast({
          title: resolveText('common.notice', 'Notice'),
          message: resolveText('projects.deleted', 'Project moved to Trash'),
          tone: 'info',
          actionLabel: resolveText('common.undo', 'Undo'),
          onAction: () => {
            void Promise.resolve(restoreProject(projectIdToDelete))
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
    deleteProject,
    logProjectError,
    resolveText,
    restoreProject,
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

  const renderProjectItem = (project: Project) => {
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

  const renderProjectListRow = ({ item, index }: { item: ProjectListRow; index: number }) => {
    if (item.type === 'section-label') {
      return <ListSectionHeader title={item.title} tc={tc} />;
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
          onPress={() => toggleAreaCollapse(item.areaId)}
          style={styles.collapsibleAreaHeader}
        >
          <View style={styles.collapsibleAreaHeaderContent}>
            {item.color ? (
              <View
                style={[
                  styles.collapsibleAreaDot,
                  { backgroundColor: item.color, borderColor: tc.border },
                ]}
              />
            ) : null}
            {item.icon ? (
              <Text style={[styles.collapsibleAreaIcon, { color: tc.secondaryText }]}>{item.icon}</Text>
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

    return renderProjectItem(item.project);
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
    openQuickCapture({
      initialProps: {
        projectId: projectToAddTo.id,
        status: 'next',
      },
      returnTo: buildProjectQuickCaptureReturnTo(projectToAddTo.id),
    });
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
    useCallback(() => {
      const pendingId = reopenProjectIdAfterCaptureRef.current;
      if (pendingId) {
        reopenProjectIdAfterCaptureRef.current = null;
        const project = projectsRef.current.find((item) => item.id === pendingId && !item.deletedAt);
        if (project) openProjectRef.current(project);
      }
      // Save & edit from this project's capture: open the editor on THIS
      // screen instance. The capture route cannot navigate here — any
      // navigation to a screen that is already on top stacks a duplicate of
      // it, so leaving the project would take an extra back tap (#1029).
      const pendingTask = consumePendingCaptureTaskOpen(pendingId ?? routeProjectIdRef.current);
      if (!pendingTask) return;
      const task = tasksRef.current.find((item) => item.id === pendingTask.taskId && !item.deletedAt);
      if (!task) return;
      setHighlightTask(task.id);
      setTaskModalDefaultTab(pendingTask.taskTab);
      setTaskModalOpenKey(`capture:${pendingTask.taskId}`);
      setEditingTask(task);
      // setHighlightTask (zustand) and the useState setters are stable; data
      // is read through refs so this callback never changes identity.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
  );

  const closeProjectDetail = () => {
    commitSelectedProjectNotes();
    persistSelectedProjectEdits(selectedProject);
    setSelectedProject(null);
    resetProjectNotesUi();
    resetProjectAttachmentUi();
    setShowAreaPicker(false);
    setShowTagPicker(false);
    if (projectId && router.canGoBack()) {
      router.back();
    }
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
      <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <View style={[styles.inputContainer, { borderBottomColor: tc.border }]}>
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
          <View style={styles.tagFilterChips}>
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
        <View style={styles.filterSection}>
          <TouchableOpacity
            style={styles.filterHeader}
            onPress={() => setShowTagFilter((prev) => !prev)}
            accessibilityRole="button"
            accessibilityLabel={`${t('projects.tagFilter')}: ${showTagFilter ? t('filters.hide') : t('filters.show')}`}
            accessibilityState={{ expanded: showTagFilter }}
          >
            <CompactText
              style={[styles.tagFilterLabel, { color: tc.text }]}
              numberOfLines={1}
            >
              {t('projects.tagFilter')}
            </CompactText>
            <CompactText
              style={[styles.filterToggleText, { color: tc.secondaryText }]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.78}
            >
              {showTagFilter ? t('filters.hide') : t('filters.show')}
            </CompactText>
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
                  accessibilityLabel={tag}
                  accessibilityState={{ selected: selectedTagFilter === tag }}
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
          )}
        </View>
      </View>

      <FlatList
        data={projectListRows}
        keyExtractor={(item) => item.key}
        contentContainerStyle={defaultListContentStyle}
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
        onClose={closeProjectDetail}
        onDuplicateProject={handleDuplicateProject}
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
        onClose={() => setEditingTask(null)}
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

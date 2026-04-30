import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { View, Text, TextInput, TouchableOpacity, Alert, FlatList, Dimensions, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AREA_PRESET_COLORS, Attachment, DEFAULT_PROJECT_COLOR, Project, Task, useTaskStore } from '@mindwtr/core';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronDown, ChevronRight } from 'lucide-react-native';

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
import { buildProjectListRows, type ProjectListRow } from '@/components/projects-screen/project-list-model';
import { useProjectAttachments } from '@/components/projects-screen/use-project-attachments';
import { useProjectNotesEditor } from '@/components/projects-screen/use-project-notes-editor';
import { TaskEditModal } from '@/components/task-edit-modal';
import { useProjectFiltering } from '@/hooks/use-project-filtering';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useLanguage } from '../../contexts/language-context';
import { useToast } from '../../contexts/toast-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { ListSectionHeader, defaultListContentStyle } from '@/components/list-layout';
import { logError, logWarn } from '../../lib/app-log';
import { AREA_FILTER_ALL, AREA_FILTER_NONE } from '@/lib/area-filter';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';

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
  const [showProjectMeta, setShowProjectMeta] = useState(false);
  const [showDueDatePicker, setShowDueDatePicker] = useState(false);
  const [showReviewPicker, setShowReviewPicker] = useState(false);
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [showAreaPicker, setShowAreaPicker] = useState(false);
  const [showAreaManager, setShowAreaManager] = useState(false);
  const [newAreaName, setNewAreaName] = useState('');
  const [newAreaColor, setNewAreaColor] = useState('#3b82f6');
  const [expandedAreaColorId, setExpandedAreaColorId] = useState<string | null>(null);
  const { projectId, taskId, openToken } = useLocalSearchParams<{ projectId?: string; taskId?: string; openToken?: string }>();
  const lastOpenedTaskKeyRef = useRef<string | null>(null);
  const ALL_TAGS = '__all__';
  const NO_TAGS = '__none__';
  const ALL_AREAS = AREA_FILTER_ALL;
  const NO_AREA = AREA_FILTER_NONE;
  const [selectedTagFilter, setSelectedTagFilter] = useState(ALL_TAGS);
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [collapsedAreas, setCollapsedAreas] = useState<Record<string, boolean>>({});
  const [showDeferredProjects, setShowDeferredProjects] = useState(false);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
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
    groupedActiveProjects,
    groupedDeferredProjects,
    groupedArchivedProjects,
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
  const {
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
  } = useProjectNotesEditor({
    selectedProject,
    setSelectedProject,
    updateProject,
    language,
  });
  const {
    linkModalVisible,
    setLinkModalVisible,
    imagePreviewAttachment,
    setImagePreviewAttachment,
    linkInput,
    setLinkInput,
    openAttachment,
    downloadAttachment,
    addProjectFileAttachment,
    confirmAddProjectLink,
    removeProjectAttachment,
    resetProjectAttachmentUi,
  } = useProjectAttachments({
    selectedProject,
    setSelectedProject,
    updateProject,
    t,
    logProjectError,
  });

  const projectListRows = useMemo(() => buildProjectListRows({
    areaById,
    collapsedAreas,
    groupedActiveProjects,
    groupedArchivedProjects,
    groupedDeferredProjects,
    showArchivedProjects,
    showDeferredProjects,
    t,
  }), [
    areaById,
    collapsedAreas,
    groupedActiveProjects,
    groupedArchivedProjects,
    groupedDeferredProjects,
    showArchivedProjects,
    showDeferredProjects,
    t,
  ]);

  const openProject = useCallback((project: Project) => {
    setSelectedProject(project);
    resetProjectNotesUi();
    setShowProjectMeta(false);
    setShowDueDatePicker(false);
    setShowReviewPicker(false);
    setShowStatusMenu(false);
    resetProjectAttachmentUi();
  }, [resetProjectAttachmentUi, resetProjectNotesUi]);

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

  const renderProjectItem = (project: Project) => {
    return (
      <ProjectRow
        project={project}
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

  const toggleAreaCollapse = useCallback((areaId: string) => {
    setCollapsedAreas((current) => ({
      ...current,
      [areaId]: !(current[areaId] ?? false),
    }));
  }, []);

  const renderProjectListRow = ({ item, index }: { item: ProjectListRow; index: number }) => {
    if (item.type === 'section-label') {
      return <ListSectionHeader title={item.title} tc={tc} />;
    }

    if (item.type === 'section-toggle') {
      const showTopBorder = index > 0;
      return (
        <TouchableOpacity
          onPress={() => {
            if (item.sectionKind === 'deferred') {
              setShowDeferredProjects((current) => !current);
              return;
            }
            setShowArchivedProjects((current) => !current);
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
    resetProjectNotesUi();
    setShowProjectMeta(false);
    setShowReviewPicker(false);
    setShowStatusMenu(false);
    resetProjectAttachmentUi();
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

      <FlatList
        data={projectListRows}
        keyExtractor={(item) => item.key}
        contentContainerStyle={defaultListContentStyle}
        style={{ flex: 1 }}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{t('projects.empty')}</Text>
          </View>
        }
        renderItem={renderProjectListRow}
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

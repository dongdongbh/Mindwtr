import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import {
  buildSomedayFilterOptions,
  buildSomedayViewModel,
  flushPendingSave,
  getSomedayGroupSectionId,
  getSomedaySectionMoveSelection,
  getSomedaySectionTaskText,
  planSomedaySectionTaskAdd,
  selectSomedayTasks,
  shallow,
  tFallback,
  useTaskStore,
} from '@mindwtr/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SomedayGroupBy, Task, TaskSortBy, TaskStatus } from '@mindwtr/core';
import { useTheme } from '../../contexts/theme-context';
import { useLanguage } from '../../contexts/language-context';
import { ArrowUpDown, Eye, Folder, Lightbulb, Plus, SlidersHorizontal } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useVisibleTaskContext } from '@/hooks/use-visible-tasks';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { TaskEditModal } from '../task-edit-modal';
import { getBulkMoveStatusOptions } from '../task-list/TaskListBulkBar';
import { assertBulkActionSucceeded, usePruneSelectionToVisible, useTaskListSelection } from '../use-task-list-selection';
import { TaskListView } from '../task-list-view';
import { ListEmptyState } from '../list-empty-state';
import { FilterChip, TaskFilterSheet } from '../task-filter-sheet';
import { DeferredProjectsSection } from './deferred-projects-section';
import { SomedaySectionPicker } from '../someday-section-picker';
import { createSomedaySection } from '@/lib/someday-section-actions';
import { useToast } from '@/contexts/toast-context';
import { settleStoreAction } from '../store-action-result';
import { logError } from '@/lib/app-log';
import { useSomedaySectionMove } from './use-someday-section-move';
import { ListOverflowMenu } from '../list-overflow-menu';
import { useTaskFilterSelections } from '@/hooks/use-task-filter-selections';

export function SomedayView() {
  const { tasks, projects, settings, updateTask, updateProject, deleteTask, restoreTask, batchMoveTasks, batchDeleteTasks, batchUpdateTasks, highlightTaskId, setHighlightTask } = useTaskStore((state) => ({
    tasks: state.tasks,
    projects: state.projects,
    settings: state.settings,
    updateTask: state.updateTask,
    updateProject: state.updateProject,
    deleteTask: state.deleteTask,
    restoreTask: state.restoreTask,
    batchMoveTasks: state.batchMoveTasks,
    batchDeleteTasks: state.batchDeleteTasks,
    batchUpdateTasks: state.batchUpdateTasks,
    highlightTaskId: state.highlightTaskId,
    setHighlightTask: state.setHighlightTask,
  }), shallow);
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [sortBy, setSortBy] = useState<TaskSortBy>('default');
  const [groupBy, setGroupBy] = useState<SomedayGroupBy>('viewSection');
  const [showDetails, setShowDetails] = useState(false);
  const [newSectionOpen, setNewSectionOpen] = useState(false);
  const [addingGroup, setAddingGroup] = useState<{ sectionId?: string; title: string } | null>(null);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [addingTask, setAddingTask] = useState(false);
  const [addTaskError, setAddTaskError] = useState(false);
  const pendingAddedTaskRef = useRef<{ id: string; title: string } | null>(null);
  const router = useRouter();
  const { showToast } = useToast();

  const tc = useThemeColors();
  const insets = useSafeAreaInsets();
  const { areaById, resolvedAreaFilter, visibleTasks } = useVisibleTaskContext();
  const navBarInset = Platform.OS === 'android' && insets.bottom >= 24 ? insets.bottom : 0;
  const tasksById = useMemo(() => {
    return tasks.reduce((acc, task) => {
      acc[task.id] = task;
      return acc;
    }, {} as Record<string, Task>);
  }, [tasks]);
  const taskListContentStyle = useMemo(
    () => [styles.taskListContent, navBarInset ? { paddingBottom: 16 + navBarInset } : null],
    [navBarInset],
  );

  // What the screen lists, groups, counts and offers comes from core, shared with the native host.
  const baseSomedayTasks = useMemo(() => selectSomedayTasks(visibleTasks), [visibleTasks]);
  const filterOptions = useMemo(
    () => buildSomedayFilterOptions({ tasks: baseSomedayTasks, projects, settings, t }),
    [baseSomedayTasks, projects, settings, t],
  );
  const selections = useTaskFilterSelections({
    view: 'list',
    t,
    visibility: filterOptions.visibility,
    retainTokens: filterOptions.retainTokens,
    retainProjects: filterOptions.retainProjects,
    getProjectLabel: filterOptions.getProjectLabel,
  });
  const model = useMemo(() => buildSomedayViewModel({
    tasks: baseSomedayTasks,
    projects,
    areaById,
    resolvedAreaFilter,
    settings,
    sortBy,
    groupBy,
    showDetails,
    criteria: selections.criteria,
    searchQuery: selections.searchQuery,
    filterChips: selections.chips.map((chip) => ({ id: chip.id, label: chip.label, excluded: chip.excluded ?? false })),
    t,
  }), [areaById, baseSomedayTasks, groupBy, projects, resolvedAreaFilter, selections.chips, selections.criteria, selections.searchQuery, settings, showDetails, sortBy, t]);
  const {
    deferredProjects,
    groups: somedayTaskGroups,
    labels,
    sections: somedaySections,
    tasks: somedayTasks,
  } = model;
  const selection = useTaskListSelection({
    batchDeleteTasks,
    batchMoveTasks,
    batchUpdateTasks,
    restoreTask,
    t,
    tasksById,
  });
  const visibleTaskIds = useMemo(() => somedayTasks.map((task) => task.id), [somedayTasks]);
  usePruneSelectionToVisible(selection.setMultiSelectedIds, visibleTaskIds);
  const bulkMoveStatusOptions = useMemo(() => getBulkMoveStatusOptions('someday'), []);
  const sectionMove = useSomedaySectionMove(t, resolvedAreaFilter, selection.exitSelectionMode);
  const moveSelection = sectionMove.moveTargetIds
    ? getSomedaySectionMoveSelection(sectionMove.moveTargetIds.map((id) => tasksById[id]), somedaySections)
    : { selectedId: undefined, selectionMixed: false };
  const addTaskText = getSomedaySectionTaskText(t, addingGroup?.title ?? '');

  const openAddTaskForGroup = (groupId: string) => {
    const group = somedayTaskGroups?.find((candidate) => candidate.id === groupId);
    if (!group) return;
    setAddingGroup({ sectionId: getSomedayGroupSectionId(groupId) ?? undefined, title: group.title });
    setNewTaskTitle('');
    setAddTaskError(false);
    pendingAddedTaskRef.current = null;
  };

  const closeAddTask = () => {
    if (addingTask) return;
    setAddingGroup(null);
    setNewTaskTitle('');
    setAddTaskError(false);
  };

  const saveSectionTask = async () => {
    const title = newTaskTitle.trim();
    if (!addingGroup || !title || addingTask) return;
    setAddingTask(true);
    setAddTaskError(false);
    try {
      const latest = useTaskStore.getState();
      const plan = planSomedaySectionTaskAdd({
        title,
        sectionId: addingGroup.sectionId,
        stored: latest.settings?.gtd?.viewSections?.someday,
      });
      if (plan.kind !== 'add') {
        setAddTaskError(true);
        return;
      }
      const pending = pendingAddedTaskRef.current;
      if (pending && pending.title === title && latest.tasks.some((task) => task.id === pending.id)) {
        await latest.retryPersistence();
      }
      if (!pending || pending.title !== title || !latest.tasks.some((task) => task.id === pending.id)) {
        const result = await latest.addTask(plan.title, plan.props);
        assertBulkActionSucceeded(result);
        if (result.id) pendingAddedTaskRef.current = { id: result.id, title };
      }
      await flushPendingSave();
      if (useTaskStore.getState().persistenceFailure) throw new Error('Someday section task save incomplete');
      pendingAddedTaskRef.current = null;
      setAddingGroup(null);
      setNewTaskTitle('');
      setAddTaskError(false);
      showToast({ message: addTaskText.created, tone: 'success' });
    } catch (error) {
      setAddTaskError(true);
      void logError(error, { scope: 'task', extra: { message: 'Failed to add Someday section task' } });
    } finally {
      setAddingTask(false);
    }
  };

  const handleStatusChange = (task: Task, status: TaskStatus) => {
    return updateTask(task.id, { status });
  };
  const handleActivateProject = (projectId: string) => {
    void settleStoreAction(() => updateProject(projectId, { status: 'active' })).then((outcome) => {
      if (outcome.ok) return;
      showToast({
        title: tFallback(t, 'common.error', 'Error'),
        message: outcome.message || tFallback(t, 'projects.reactivateFailed', 'Failed to reactivate project'),
        tone: 'error',
        durationMs: 4200,
      });
    });
  };
  const handleOpenProject = (projectId: string) => {
    router.push({ pathname: '/projects-screen', params: { projectId } });
  };

  const handleSaveTask = (taskId: string, updates: Partial<Task>) => {
    return updateTask(taskId, updates);
  };

  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!highlightTaskId) return;
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = setTimeout(() => {
      setHighlightTask(null);
    }, 3500);
    return () => {
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
      }
    };
  }, [highlightTaskId, setHighlightTask]);

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <View style={[styles.stats, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{model.ideasCount}</Text>
          <Text style={[styles.statLabel, { color: tc.secondaryText }]}>{labels.ideas}</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{model.inProjectsCount}</Text>
          <Text style={[styles.statLabel, { color: tc.secondaryText }]}>{labels.inProjects}</Text>
        </View>
        {selections.hasActive ? (
          <FilterChip
            label={`${labels.filters} · ${selections.activeCount}`}
            selected
            themeColors={tc}
            onPress={selections.clear}
            removable
            removeLabel={`${labels.filtersClear}: ${labels.filters}`}
          />
        ) : null}
        <View style={styles.summaryOverflow}>
          <ListOverflowMenu
            actions={[
              {
                id: 'filters',
                label: labels.filters,
                icon: (color) => <SlidersHorizontal size={19} color={color} strokeWidth={2} />,
                onPress: () => setFiltersVisible(true),
                selected: selections.hasActive,
                testID: 'someday-filter-action',
              },
              {
                id: 'sort',
                label: labels.sort,
                accessibilityLabel: `${labels.sort}: ${model.menu.sortValue}`,
                icon: (color) => <ArrowUpDown size={19} color={color} strokeWidth={2} />,
                value: model.menu.sortValue,
                testID: 'someday-sort-action',
                submenu: {
                  title: labels.sort,
                  actions: model.menu.sortOptions.map((option) => ({
                    id: `sort:${option.value}`,
                    label: option.label,
                    accessibilityLabel: `${labels.sort}: ${option.label}`,
                    icon: (color) => <ArrowUpDown size={18} color={color} strokeWidth={2} />,
                    onPress: () => setSortBy(option.value),
                    selected: option.selected,
                    testID: `someday-sort-${option.value}`,
                  })),
                },
              },
              {
                id: 'group',
                label: labels.group,
                accessibilityLabel: `${labels.group}: ${model.menu.groupValue}`,
                icon: (color) => <Folder size={19} color={color} strokeWidth={2} />,
                value: model.menu.groupValue,
                testID: 'someday-group-action',
                submenu: {
                  title: labels.group,
                  actions: model.menu.groupOptions.map((option) => ({
                    id: `group:${option.value}`,
                    label: option.label,
                    accessibilityLabel: `${labels.group}: ${option.label}`,
                    icon: (color: string) => <Folder size={18} color={color} strokeWidth={2} />,
                    onPress: () => setGroupBy(option.value),
                    selected: option.selected,
                    testID: `someday-group-${option.value}`,
                  })),
                },
              },
              {
                id: 'details',
                label: labels.details,
                icon: (color) => <Eye size={19} color={color} strokeWidth={2} />,
                onPress: () => setShowDetails((current) => !current),
                selected: showDetails,
                testID: 'someday-toggle-details',
              },
              {
                id: 'new-section',
                label: labels.newSection,
                icon: (color) => <Plus size={19} color={color} strokeWidth={2} />,
                onPress: () => setNewSectionOpen(true),
                testID: 'someday-new-section-action',
              },
            ]}
            backLabel={labels.back}
            closeLabel={labels.close}
            moreLabel={labels.more}
            themeColors={tc}
            triggerTestID="someday-overflow-button"
          />
        </View>
      </View>

      <TaskListView
        tasks={somedayTasks}
        taskGroups={somedayTaskGroups}
        showDetails={showDetails}
        isDark={isDark}
        themeColors={tc}
        t={t}
        onPressTask={setEditingTask}
        onChangeTaskStatus={handleStatusChange}
        onDeleteTask={(task) => deleteTask(task.id)}
        onMoveTaskToSection={sectionMove.openForTask}
        onMoveSelectionToSection={() => sectionMove.openForSelection(selection.selectedIdsArray)}
        onAddTaskToSection={groupBy === 'viewSection' ? openAddTaskForGroup : undefined}
        highlightTaskId={highlightTaskId}
        selection={selection}
        bulkStatusOptions={bulkMoveStatusOptions}
        contentContainerStyle={taskListContentStyle}
        ListHeaderComponent={(
          <DeferredProjectsSection
            projects={deferredProjects}
            areaById={areaById}
            themeColors={tc}
            t={t}
            onActivateProject={handleActivateProject}
            onOpenProject={handleOpenProject}
          />
        )}
        ListEmptyComponent={deferredProjects.length === 0 || model.showEmptyState ? (model.empty.actionLabel ? (
          <ListEmptyState
            message={model.empty.message}
            hint={model.empty.hint}
            actionLabel={model.empty.actionLabel}
            onAction={selections.clear}
            backgroundColor={tc.cardBg}
            borderColor={tc.border}
            textColor={tc.text}
            mutedTextColor={tc.secondaryText}
          />
        ) : (
          <View style={styles.emptyState}>
            <Lightbulb size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
            <Text style={[styles.emptyTitle, { color: tc.text }]}>{labels.emptyTitle}</Text>
            {labels.emptyHint ? <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{labels.emptyHint}</Text> : null}
          </View>
        )) : null}
      />

      <TaskFilterSheet
        visible={filtersVisible}
        onClose={() => setFiltersVisible(false)}
        selections={selections}
        options={{
          tokens: filterOptions.tokens,
          projects: filterOptions.projects ?? undefined,
          timeEstimates: filterOptions.timeEstimates,
          visibility: filterOptions.visibility,
        }}
        themeColors={tc}
        t={t}
      />

      {newSectionOpen ? (
        <SomedaySectionPicker
          createOnly
          sections={somedaySections}
          onCreate={createSomedaySection}
          onSelect={() => setNewSectionOpen(false)}
          onCancelCreate={() => setNewSectionOpen(false)}
          t={t}
          themeColors={tc}
        />
      ) : null}

      <Modal
        visible={sectionMove.moveTargetIds !== null}
        transparent
        animationType="fade"
        onRequestClose={sectionMove.close}
        accessibilityViewIsModal
      >
        <Pressable style={styles.pickerOverlay} onPress={sectionMove.close}>
          <View style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
            onStartShouldSetResponder={() => true}>
            <Text accessibilityRole="header" style={[styles.pickerTitle, { color: tc.text }]}>
              {labels.moveToSection}
            </Text>
            <ScrollView keyboardShouldPersistTaps="handled">
              <SomedaySectionPicker
                sections={somedaySections}
                selectedId={moveSelection.selectedId}
                selectionMixed={moveSelection.selectionMixed}
                onCreate={createSomedaySection}
                onSelect={(sectionId) => { void sectionMove.move(sectionId); }}
                t={t}
                themeColors={tc}
                optionsStyle={styles.pickerOptions}
                optionStyle={styles.pickerOption}
                optionTextStyle={styles.pickerOptionText}
              />
            </ScrollView>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('common.cancel')}
              disabled={sectionMove.saving} onPress={sectionMove.close} style={styles.pickerCancel}>
              <Text style={{ color: tc.secondaryText }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      <Modal visible={addingGroup !== null} transparent animationType="fade"
        onRequestClose={closeAddTask} accessibilityViewIsModal>
        <View style={styles.pickerOverlay}>
          <View style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text accessibilityRole="header" style={[styles.pickerTitle, { color: tc.text }]}>
              {addTaskText.title}
            </Text>
            <TextInput
              accessibilityLabel={addTaskText.inputLabel}
              autoFocus
              value={newTaskTitle}
              editable={!addingTask && !pendingAddedTaskRef.current}
              onChangeText={setNewTaskTitle}
              onSubmitEditing={() => { void saveSectionTask(); }}
              placeholder={addTaskText.placeholder}
              placeholderTextColor={tc.secondaryText}
              style={[styles.taskTitleInput, { color: tc.text, borderColor: tc.border, backgroundColor: tc.bg }]}
            />
            {addTaskError ? (
              <Text accessibilityRole="alert" style={{ color: tc.danger }}>
                {addTaskText.failed}
              </Text>
            ) : null}
            <View style={styles.pickerActions}>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('common.cancel')}
                disabled={addingTask} onPress={closeAddTask} style={styles.pickerCancel}>
                <Text style={{ color: tc.secondaryText }}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button"
                accessibilityLabel={pendingAddedTaskRef.current ? addTaskText.retryLabel : addTaskText.saveLabel}
                disabled={addingTask || !newTaskTitle.trim()} onPress={() => { void saveSectionTask(); }}
                style={[styles.pickerSave, { backgroundColor: tc.tint, opacity: addingTask || !newTaskTitle.trim() ? 0.5 : 1 }]}>
                <Text style={{ color: tc.onTint }}>
                  {pendingAddedTaskRef.current ? addTaskText.retryLabel : addTaskText.saveLabel}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <TaskEditModal
        visible={editingTask !== null}
        task={editingTask}
        onClose={() => setEditingTask(null)}
        onSave={handleSaveTask}
        defaultTab="view"
        onProjectNavigate={openProjectScreen}
        onContextNavigate={openContextsScreen}
        onTagNavigate={openContextsScreen}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    columnGap: 24,
    rowGap: 4,
  },
  statItem: {
    alignItems: 'center',
  },
  statValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#8B5CF6',
  },
  statLabel: {
    fontSize: 12,
    marginTop: 4,
  },
  taskListContent: {
    padding: 16,
  },
  summaryOverflow: { marginLeft: 'auto' },
  pickerOverlay: { alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.45)', flex: 1, justifyContent: 'center' },
  pickerCard: { borderRadius: 14, borderWidth: 1, gap: 12, maxHeight: '80%', padding: 16, width: '88%' },
  pickerTitle: { fontSize: 17, fontWeight: '700' },
  pickerOptions: { gap: 8 },
  pickerOption: { borderRadius: 8, borderWidth: 1, justifyContent: 'center', minHeight: 44, paddingHorizontal: 12 },
  pickerOptionText: { fontSize: 15 },
  pickerCancel: { justifyContent: 'center', minHeight: 44, paddingHorizontal: 12 },
  pickerActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  pickerSave: { borderRadius: 8, justifyContent: 'center', minHeight: 44, paddingHorizontal: 14 },
  taskTitleInput: { borderRadius: 8, borderWidth: 1, fontSize: 16, minHeight: 44, paddingHorizontal: 12 },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    paddingHorizontal: 24,
  },
  emptyIcon: {
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 20,
  },
});

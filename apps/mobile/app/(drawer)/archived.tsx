import React, { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, Alert, TextInput } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    getInlineMarkdownPreview,
    getTaskMetadataFilterVisibility,
    getUsedTaskTokens,
    projectMatchesAreaFilterSelection,
    resolveFeatureFlags,
    safeFormatDate,
    shallow,
    sortDoneTasksForListView,
    sortTasksBy,
    taskMatchesAreaFilterSelection,
    tFallback,
    useTaskStore,
} from '@mindwtr/core';
import type { Project, Task, TaskSortBy } from '@mindwtr/core';
import { FilterChip, TaskFilterSheet } from '@/components/task-filter-sheet';
import { resolveTimeEstimateFilterOptions } from '@/components/time-estimate-filter-utils';
import { taskMatchesFilterSelections, useTaskFilterSelections } from '@/hooks/use-task-filter-selections';
import { useLocalDayKey } from '@/hooks/use-local-day-key';
import { buildTaskGroupSections, getTaskGroupByLabel, type TaskGroupItem } from '@/lib/task-group-sections';
import { DONE_TASK_LIST_SORT_OPTIONS } from '@/lib/task-list-sort';
import {
    ARCHIVED_LIST_GROUP_OPTIONS,
    ARCHIVED_LIST_VIEW_STATE_STORAGE_KEY,
    DEFAULT_ARCHIVED_LIST_VIEW_STATE,
    readArchivedListViewState,
    serializeArchivedListViewState,
    type ArchivedListViewState,
} from '@/lib/view-state/archived-list-view-state';
import { useCollapsedTaskGroups } from '@/lib/view-state/task-group-collapse-state';
import { MarkdownInlineText } from '@/components/markdown-text';
import { useLanguage } from '../../contexts/language-context';

import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useThemeColors } from '@/hooks/use-theme-colors';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { TaskEditModal } from '@/components/task-edit-modal';
import { CompletedAtPicker } from '@/components/completed-at-picker';
import { assertBulkActionSucceeded, usePruneSelectionToVisible, useTaskListSelection } from '@/components/use-task-list-selection';
import { TASK_LIST_WINDOWING_PROPS } from '@/components/task-list-windowing';
import { Swipeable, GestureHandlerRootView } from 'react-native-gesture-handler';
import { Archive, ChevronDown, ChevronRight, SlidersHorizontal } from 'lucide-react-native';

function ArchivedTaskItem({
    task,
    tc,
    onOpen,
    onRestore,
    onDelete,
    onEditCompletedAt,
    onToggleSelect,
    completedLabel,
    editCompletedAtLabel,
    selectLabel,
    restoreLabel,
    deleteLabel,
    selectionMode,
    isSelected,
    isHighlighted,
}: {
    task: Task;
    tc: ThemeColors;
    onOpen: () => void;
    onRestore: () => void;
    onDelete: () => void;
    onEditCompletedAt: () => void;
    onToggleSelect: () => void;
    completedLabel: string;
    editCompletedAtLabel: string;
    selectLabel: string;
    restoreLabel: string;
    deleteLabel: string;
    selectionMode: boolean;
    isSelected: boolean;
    isHighlighted?: boolean;
}) {
    const swipeableRef = useRef<Swipeable>(null);
    const completionTimestamp = task.completedAt || task.updatedAt;
    const completionDateLabel = completionTimestamp
        ? safeFormatDate(completionTimestamp, 'Pp', completionTimestamp)
        : 'Unknown';

    const renderLeftActions = () => (
        <Pressable
            style={styles.swipeActionRestore}
            onPress={() => {
                swipeableRef.current?.close();
                onRestore();
            }}
        >
            <Text style={styles.swipeActionText}>↩️ {restoreLabel}</Text>
        </Pressable>
    );

    const renderRightActions = () => (
        <Pressable
            style={styles.swipeActionDelete}
            onPress={() => {
                swipeableRef.current?.close();
                onDelete();
            }}
        >
            <Text style={styles.swipeActionText}>🗑️ {deleteLabel}</Text>
        </Pressable>
    );

    return (
        <Swipeable
            ref={swipeableRef}
            renderLeftActions={selectionMode ? undefined : renderLeftActions}
            renderRightActions={selectionMode ? undefined : renderRightActions}
            overshootLeft={false}
            overshootRight={false}
        >
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={selectionMode ? `${selectLabel} ${task.title}` : `Open archived task details: ${task.title}`}
                accessibilityState={selectionMode ? { selected: isSelected } : undefined}
                onPress={selectionMode ? onToggleSelect : onOpen}
                style={({ pressed }) => [
                    styles.taskItem,
                    { backgroundColor: tc.taskItemBg, borderColor: tc.border },
                    pressed && styles.taskItemPressed,
                    isHighlighted && !selectionMode && { borderWidth: 2, borderColor: tc.tint },
                    selectionMode && isSelected && { borderWidth: 2, borderColor: tc.tint },
                ]}
            >
                {selectionMode && (
                    <View
                        style={[
                            styles.selectionIndicator,
                            { borderColor: tc.tint, backgroundColor: isSelected ? tc.tint : 'transparent' },
                        ]}
                    >
                        {isSelected && <Text style={[styles.selectionMark, { color: tc.onTint }]}>✓</Text>}
                    </View>
                )}
                <View style={styles.taskContent}>
                    <Text style={[styles.taskTitle, { color: tc.secondaryText }]} numberOfLines={2}>
                        {task.title}
                    </Text>
                    {task.description && (
                        <MarkdownInlineText
                            markdown={getInlineMarkdownPreview(task.description)}
                            tc={tc}
                            style={[styles.taskDescription, { color: tc.secondaryText }]}
                            numberOfLines={1}
                        />
                    )}
                    <Pressable
                        disabled={selectionMode}
                        onPress={(event) => {
                            event.stopPropagation();
                            onEditCompletedAt();
                        }}
                        hitSlop={6}
                        accessibilityRole="button"
                        accessibilityLabel={editCompletedAtLabel}
                        style={styles.archivedDateButton}
                    >
                        <Text style={[styles.archivedDate, { color: tc.secondaryText }]}>
                            {completedLabel}: {completionDateLabel}
                        </Text>
                    </Pressable>
                </View>
                <View style={[styles.statusIndicator, { backgroundColor: '#6B7280' }]} />
            </Pressable>
        </Swipeable>
    );
}

type ArchiveSegment = 'tasks' | 'projects';

function ArchivedProjectItem({
    project,
    tc,
    areaName,
    onOpen,
    onRestore,
    onDelete,
    completedLabel,
    restoreLabel,
    deleteLabel,
}: {
    project: Project;
    tc: ThemeColors;
    areaName?: string;
    onOpen: () => void;
    onRestore: () => void;
    onDelete: () => void;
    completedLabel: string;
    restoreLabel: string;
    deleteLabel: string;
}) {
    const swipeableRef = useRef<Swipeable>(null);
    const archivedDateLabel = project.updatedAt
        ? safeFormatDate(project.updatedAt, 'Pp', project.updatedAt)
        : 'Unknown';

    const renderLeftActions = () => (
        <Pressable
            style={styles.swipeActionRestore}
            onPress={() => {
                swipeableRef.current?.close();
                onRestore();
            }}
        >
            <Text style={styles.swipeActionText}>↩️ {restoreLabel}</Text>
        </Pressable>
    );

    const renderRightActions = () => (
        <Pressable
            style={styles.swipeActionDelete}
            onPress={() => {
                swipeableRef.current?.close();
                onDelete();
            }}
        >
            <Text style={styles.swipeActionText}>🗑️ {deleteLabel}</Text>
        </Pressable>
    );

    return (
        <Swipeable
            ref={swipeableRef}
            renderLeftActions={renderLeftActions}
            renderRightActions={renderRightActions}
            overshootLeft={false}
            overshootRight={false}
        >
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open archived project: ${project.title}`}
                onPress={onOpen}
                style={({ pressed }) => [
                    styles.taskItem,
                    { backgroundColor: tc.taskItemBg, borderColor: tc.border },
                    pressed && styles.taskItemPressed,
                ]}
            >
                <View style={styles.taskContent}>
                    <Text style={[styles.taskTitle, { color: tc.secondaryText }]} numberOfLines={2}>
                        {project.title}
                    </Text>
                    <Text style={[styles.archivedDate, { color: tc.secondaryText }]}>
                        {completedLabel}: {archivedDateLabel}
                    </Text>
                    {areaName ? (
                        <Text style={[styles.archivedDate, { color: tc.secondaryText }]}>{areaName}</Text>
                    ) : null}
                </View>
                <View style={[styles.statusIndicator, { backgroundColor: project.color || '#6B7280' }]} />
            </Pressable>
        </Swipeable>
    );
}

export default function ArchivedScreen() {
    const {
        _allTasks,
        projects,
        areas,
        settings,
        updateTask,
        deleteTask,
        updateProject,
        deleteProject,
        restoreTask,
        batchMoveTasks,
        batchDeleteTasks,
        batchUpdateTasks,
        highlightTaskId,
        setHighlightTask,
    } = useTaskStore((state) => ({
        _allTasks: state._allTasks,
        projects: state.projects,
        areas: state.areas,
        settings: state.settings,
        updateTask: state.updateTask,
        deleteTask: state.deleteTask,
        updateProject: state.updateProject,
        deleteProject: state.deleteProject,
        restoreTask: state.restoreTask,
        batchMoveTasks: state.batchMoveTasks,
        batchDeleteTasks: state.batchDeleteTasks,
        batchUpdateTasks: state.batchUpdateTasks,
        highlightTaskId: state.highlightTaskId,
        setHighlightTask: state.setHighlightTask,
    }), shallow);
    const { t } = useLanguage();
    const [segment, setSegment] = useState<ArchiveSegment>('tasks');
    const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

    const tc = useThemeColors();
    const { areaById, resolvedAreaFilter } = useMobileAreaFilter();
    const projectById = useMemo(
        () => new Map(projects.map((project) => [project.id, project])),
        [projects],
    );

    const [viewState, setViewState] = useState<ArchivedListViewState>(DEFAULT_ARCHIVED_LIST_VIEW_STATE);
    const viewStateTouchedRef = useRef(false);
    const [filtersVisible, setFiltersVisible] = useState(false);
    useEffect(() => {
        let active = true;
        void AsyncStorage.getItem(ARCHIVED_LIST_VIEW_STATE_STORAGE_KEY).then((raw) => {
            if (active && !viewStateTouchedRef.current) {
                setViewState(readArchivedListViewState(raw));
            }
        }).catch(() => undefined);
        return () => {
            active = false;
        };
    }, []);
    const updateViewState = useCallback((updates: Partial<ArchivedListViewState>) => {
        viewStateTouchedRef.current = true;
        setViewState((current) => {
            const next = { ...current, ...updates };
            void AsyncStorage.setItem(ARCHIVED_LIST_VIEW_STATE_STORAGE_KEY, serializeArchivedListViewState(next))
                .catch(() => undefined);
            return next;
        });
    }, []);

    const sortBy: TaskSortBy = viewState.sortBy ?? 'default';
    // Sorted once, then narrowed in stages. Every stage below only filters, and
    // filtering preserves relative order, so the visible order is the same as
    // sorting last would give — but the O(n log n) sort now hangs off _allTasks and
    // the chosen order alone. Hung off anything that churns per render (the area
    // maps, the filter criteria), it re-sorts the whole archive several times per
    // interaction and blows the large-store select-all budget: 5000 archived tasks
    // measured ~360ms against a 150ms budget, from 5 sorts where 1 was needed.
    const archivedByStatus = useMemo(
        () => _allTasks.filter((task) => task.status === 'archived' && !task.deletedAt),
        [_allTasks],
    );
    const sortedArchivedTasks = useMemo(() => (
        // Archive is a log like Done: with no explicit sort, newest completion first
        // beats the global task sort, which ranks by due date and priority — neither
        // of which means anything once a task is filed away.
        sortBy === 'default' ? sortDoneTasksForListView(archivedByStatus) : sortTasksBy(archivedByStatus, sortBy)
    ), [archivedByStatus, sortBy]);
    // Everything archived in the current area, before the filter sheet and search
    // narrow it. The bulk "select all" and the counts work off the narrowed list
    // below, so acting on a filtered view never reaches a row that is not on screen.
    const allArchivedTasks = useMemo(
        () => sortedArchivedTasks.filter((task) => taskMatchesAreaFilterSelection(task, resolvedAreaFilter, projectById, areaById)),
        [sortedArchivedTasks, resolvedAreaFilter, projectById, areaById],
    );

    const resolvedFeatureFlags = resolveFeatureFlags(settings);
    const metadataFilterVisibility = useMemo(
        () => getTaskMetadataFilterVisibility(allArchivedTasks, {
            prioritiesEnabled: resolvedFeatureFlags.priorities,
            timeEstimatesEnabled: resolvedFeatureFlags.timeEstimates,
        }),
        [allArchivedTasks, resolvedFeatureFlags.priorities, resolvedFeatureFlags.timeEstimates],
    );
    // view: 'list' on purpose — Archive shares its filter selections with the other
    // task lists, the same way desktop does, so a context picked in Next narrows
    // Archive too rather than each list holding a private set.
    const selections = useTaskFilterSelections({
        view: 'list',
        t,
        visibility: metadataFilterVisibility,
    });
    const timeEstimateFilterOptions = useMemo(
        () => resolveTimeEstimateFilterOptions(settings?.gtd?.timeEstimatePresets),
        [settings?.gtd?.timeEstimatePresets],
    );
    // Only worth scanning every row for its tokens once the sheet is open; until
    // then the selected ones are the only chips anybody can see.
    const tokenFilterOptions = useMemo(() => {
        if (!filtersVisible) return Array.from(new Set([...selections.tokens, ...selections.excludedTokens]));
        return getUsedTaskTokens(allArchivedTasks, (task) => [...(task.contexts ?? []), ...(task.tags ?? [])]);
    }, [allArchivedTasks, filtersVisible, selections.tokens, selections.excludedTokens]);

    const archivedTasks = useMemo(() => allArchivedTasks.filter((task) => taskMatchesFilterSelections(task, {
        criteria: selections.criteria,
        searchQuery: selections.searchQuery,
    })), [allArchivedTasks, selections.criteria, selections.searchQuery]);

    const groupBy = viewState.groupBy;
    const { collapsedGroupIds, toggleGroup } = useCollapsedTaskGroups('archived', groupBy);
    const localDayKey = useLocalDayKey(groupBy === 'completedDate');
    // Always the grouped row shape, even ungrouped: one list type keeps the FlatList
    // monomorphic instead of switching its data/renderItem/keyExtractor together.
    const listItems = useMemo<TaskGroupItem[]>(() => {
        if (groupBy === 'none') {
            return archivedTasks.map((task) => ({ type: 'task', task }));
        }
        // localDayKey is not read; it is a dependency so crossing midnight re-buckets.
        void localDayKey;
        return buildTaskGroupSections({
            groupBy,
            tasks: archivedTasks,
            areas,
            projectById,
            t,
            collapsedGroupIds,
        });
    }, [archivedTasks, areas, collapsedGroupIds, groupBy, localDayKey, projectById, t]);
    // Rows a folded heading has removed are not "on screen", so Select all and the
    // selection prune below both work off this rather than the filtered list.
    const visibleTaskIds = useMemo(
        () => Array.from(new Set(
            listItems.flatMap((item) => (item.type === 'task' ? [item.task.id] : [])),
        )),
        [listItems],
    );
    const archivedProjects = useMemo(
        () => projects
            .filter((project) => (
                project.status === 'archived'
                && projectMatchesAreaFilterSelection(project, resolvedAreaFilter, areaById)
            ))
            .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')),
        [projects, resolvedAreaFilter, areaById],
    );
    const selectedTask = useMemo(
        () => selectedTaskId ? _allTasks.find((task) => task.id === selectedTaskId && !task.deletedAt) ?? null : null,
        [_allTasks, selectedTaskId],
    );
    const tasksById = useMemo(
        () => archivedTasks.reduce((acc, task) => {
            acc[task.id] = task;
            return acc;
        }, {} as Record<string, Task>),
        [archivedTasks],
    );
    const restoreActionLabel = tFallback(t, 'trash.restoreToInbox', 'Restore');
    const {
        exitSelectionMode,
        handleBatchDelete,
        multiSelectedIds,
        runBulkAction,
        selectedIdsArray,
        selectionMode,
        setMultiSelectedIds,
        setSelectionMode,
        toggleMultiSelect,
    } = useTaskListSelection({
        batchDeleteTasks,
        batchMoveTasks,
        batchUpdateTasks,
        restoreActionLabel,
        restoreTask,
        t,
        tasksById,
    });
    const selectedIds = multiSelectedIds;
    const listExtraData = useMemo(
        () => ({ highlightTaskId, selectedIds, selectionMode }),
        [highlightTaskId, selectedIds, selectionMode],
    );

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

    useEffect(() => {
        if (selectedTaskId && !selectedTask) {
            setSelectedTaskId(null);
        }
    }, [selectedTask, selectedTaskId]);

    usePruneSelectionToVisible(setMultiSelectedIds, visibleTaskIds);

    const handleOpenTask = useCallback((taskId: string) => {
        setSelectedTaskId(taskId);
    }, []);

    const handleSaveTask = useCallback((taskId: string, updates: Partial<Task>) => {
        const result = updateTask(taskId, updates);
        setSelectedTaskId(null);
        return result;
    }, [updateTask]);

    const handleRestore = useCallback((taskId: string) => {
        updateTask(taskId, { status: 'inbox' });
    }, [updateTask]);

    const selectAllTasks = useCallback(() => {
        setMultiSelectedIds(new Set(visibleTaskIds));
    }, [setMultiSelectedIds, visibleTaskIds]);

    const handleBulkRestore = useCallback(async () => {
        if (selectedIdsArray.length === 0) return;
        await runBulkAction(restoreActionLabel, async () => {
            assertBulkActionSucceeded(await batchMoveTasks(selectedIdsArray, 'inbox'));
            exitSelectionMode();
        });
    }, [batchMoveTasks, exitSelectionMode, restoreActionLabel, runBulkAction, selectedIdsArray]);

    const [completedAtTaskId, setCompletedAtTaskId] = useState<string | null>(null);
    const completedAtTask = useMemo(
        () => completedAtTaskId ? _allTasks.find((task) => task.id === completedAtTaskId) ?? null : null,
        [_allTasks, completedAtTaskId],
    );
    const applyCompletedAt = useCallback((iso: string) => {
        const taskId = completedAtTaskId;
        setCompletedAtTaskId(null);
        if (!taskId) return;
        updateTask(taskId, { completedAt: iso });
    }, [completedAtTaskId, updateTask]);

    const handleDelete = useCallback((taskId: string) => {
        Alert.alert(
            tFallback(t, 'common.delete', 'Delete'),
            tFallback(t, 'task.deleteConfirmBody', 'Move this task to Trash?'),
            [
                { text: tFallback(t, 'common.cancel', 'Cancel'), style: 'cancel' },
                {
                    text: tFallback(t, 'common.delete', 'Delete'),
                    style: 'destructive',
                    onPress: () => {
                        void deleteTask(taskId);
                    },
                },
            ]
        );
    }, [deleteTask, t]);

    const handleRestoreProject = useCallback((projectId: string) => {
        void updateProject(projectId, { status: 'active' });
    }, [updateProject]);

    const handleDeleteProject = useCallback((projectId: string) => {
        const project = projects.find((item) => item.id === projectId);
        Alert.alert(
            project?.title || tFallback(t, 'common.delete', 'Delete'),
            tFallback(t, 'projects.deleteConfirm', 'Delete this project? Tasks in this project will be kept and moved to unassigned.'),
            [
                { text: tFallback(t, 'common.cancel', 'Cancel'), style: 'cancel' },
                {
                    text: tFallback(t, 'common.delete', 'Delete'),
                    style: 'destructive',
                    onPress: () => {
                        void deleteProject(projectId);
                    },
                },
            ],
        );
    }, [deleteProject, projects, t]);

    const handleSegmentChange = useCallback((next: ArchiveSegment) => {
        setSegment((current) => {
            if (current === next) return current;
            exitSelectionMode();
            return next;
        });
    }, [exitSelectionMode]);

    const renderArchivedProject = useCallback(({ item }: { item: Project }) => (
        <ArchivedProjectItem
            project={item}
            tc={tc}
            areaName={item.areaId ? areaById.get(item.areaId)?.name : undefined}
            onOpen={() => openProjectScreen(item.id)}
            onRestore={() => handleRestoreProject(item.id)}
            onDelete={() => handleDeleteProject(item.id)}
            completedLabel={tFallback(t, 'list.done', 'Completed')}
            restoreLabel={tFallback(t, 'trash.restore', 'Restore')}
            deleteLabel={tFallback(t, 'common.delete', 'Delete')}
        />
    ), [tc, areaById, handleRestoreProject, handleDeleteProject, t]);

    const renderArchivedTask = useCallback(({ item }: { item: Task }) => (
        <ArchivedTaskItem
            task={item}
            tc={tc}
            onOpen={() => handleOpenTask(item.id)}
            onRestore={() => handleRestore(item.id)}
            onDelete={() => handleDelete(item.id)}
            onEditCompletedAt={() => setCompletedAtTaskId(item.id)}
            onToggleSelect={() => toggleMultiSelect(item.id)}
            completedLabel={tFallback(t, 'list.done', 'Completed')}
            editCompletedAtLabel={tFallback(t, 'task.editCompletedAt', 'Edit completion time')}
            selectLabel={tFallback(t, 'bulk.select', 'Select')}
            restoreLabel={tFallback(t, 'trash.restore', 'Restore')}
            deleteLabel={tFallback(t, 'common.delete', 'Delete')}
            selectionMode={selectionMode}
            isSelected={selectedIds.has(item.id)}
            isHighlighted={item.id === highlightTaskId}
        />
    ), [tc, handleDelete, handleOpenTask, handleRestore, highlightTaskId, selectedIds, selectionMode, t, toggleMultiSelect]);

    const renderGroupedItem = useCallback(({ item }: { item: TaskGroupItem }) => {
        if (item.type === 'section') {
            const Chevron = item.collapsed ? ChevronRight : ChevronDown;
            return (
                <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: item.collapsed !== true }}
                    disabled={!item.collapsible}
                    onPress={() => toggleGroup(item.id)}
                    style={styles.groupHeader}
                    testID={`archived-group-header-${item.id}`}
                >
                    {item.collapsible ? <Chevron size={15} color={tc.secondaryText} /> : null}
                    <Text
                        style={[styles.groupHeaderText, { color: item.muted ? tc.secondaryText : tc.text }]}
                        numberOfLines={1}
                    >
                        {item.title}
                    </Text>
                    <Text style={[styles.groupHeaderCount, { color: tc.secondaryText }]}>{item.count}</Text>
                </Pressable>
            );
        }
        return renderArchivedTask({ item: item.task });
    }, [renderArchivedTask, tc.secondaryText, tc.text, toggleGroup]);

    // A multi-tag task appears under several headings, so its group is part of
    // the row identity. Prefix headings as well so no group id can collide with
    // a task row.
    const groupedKeyExtractor = useCallback(
        (item: TaskGroupItem) => (
            item.type === 'section'
                ? `section:${item.id}`
                : `task:${item.groupId ?? 'none'}:${item.task.id}`
        ),
        [],
    );

    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <View style={[styles.container, { backgroundColor: tc.bg }]}>
                <View style={styles.segmentRow}>
                    {(['tasks', 'projects'] as ArchiveSegment[]).map((value) => {
                        const selected = segment === value;
                        const label = value === 'tasks' ? tFallback(t, 'archived.tasksSegment', 'Tasks') : tFallback(t, 'projects.title', 'Projects');
                        return (
                            <Pressable
                                key={value}
                                onPress={() => handleSegmentChange(value)}
                                accessibilityRole="button"
                                accessibilityLabel={label}
                                accessibilityState={{ selected }}
                                style={[
                                    styles.segmentChip,
                                    { backgroundColor: selected ? tc.tint : tc.filterBg, borderColor: tc.border },
                                ]}
                            >
                                <Text style={[styles.segmentChipText, { color: selected ? tc.onTint : tc.text }]}>
                                    {label}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
                {segment === 'tasks' && (allArchivedTasks.length > 0 || selections.hasActive) && (
                    <View style={styles.searchRow}>
                        <TextInput
                            value={selections.searchQuery}
                            onChangeText={selections.setSearchQuery}
                            placeholder={tFallback(t, 'common.search', 'Search')}
                            placeholderTextColor={tc.secondaryText}
                            accessibilityLabel={tFallback(t, 'common.search', 'Search')}
                            autoCorrect={false}
                            returnKeyType="search"
                            style={[styles.searchInput, { borderColor: tc.border, backgroundColor: tc.inputBg, color: tc.text }]}
                        />
                        <Pressable
                            onPress={() => setFiltersVisible(true)}
                            accessibilityRole="button"
                            accessibilityLabel={tFallback(t, 'filters.title', 'Filters')}
                            style={[
                                styles.filtersButton,
                                {
                                    borderColor: selections.hasActive ? tc.tint : tc.border,
                                    backgroundColor: selections.hasActive ? tc.tint : tc.cardBg,
                                },
                            ]}
                        >
                            <SlidersHorizontal
                                size={16}
                                color={selections.hasActive ? tc.onTint : tc.text}
                                strokeWidth={1.75}
                            />
                            {selections.activeCount > 0 ? (
                                <Text style={[styles.filtersButtonText, { color: tc.onTint }]}>
                                    {selections.activeCount}
                                </Text>
                            ) : null}
                        </Pressable>
                    </View>
                )}
                {segment === 'tasks' && archivedTasks.length > 0 && (
                    <View style={styles.summaryRow}>
                        <Text style={[styles.summaryText, { color: tc.secondaryText }]}>
                            {archivedTasks.length} {tFallback(t, 'common.tasks', 'tasks')}
                        </Text>
                        <Pressable
                            onPress={selectionMode ? exitSelectionMode : () => setSelectionMode(true)}
                            accessibilityRole="button"
                            accessibilityLabel={selectionMode ? tFallback(t, 'common.done', 'Done') : tFallback(t, 'bulk.select', 'Select')}
                            style={[styles.selectButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                        >
                            <Text style={[styles.selectButtonText, { color: tc.text }]}>
                                {selectionMode ? tFallback(t, 'common.done', 'Done') : tFallback(t, 'bulk.select', 'Select')}
                            </Text>
                        </Pressable>
                    </View>
                )}
                {segment === 'projects' && archivedProjects.length > 0 && (
                    <View style={styles.summaryRow}>
                        <Text style={[styles.summaryText, { color: tc.secondaryText }]}>
                            {archivedProjects.length} {tFallback(t, 'projects.title', 'projects')}
                        </Text>
                    </View>
                )}
                {segment === 'tasks' && selectionMode && (
                    <View style={[styles.bulkBar, { borderColor: tc.border, backgroundColor: tc.cardBg }]}>
                        <Text
                            accessibilityLabel={`${selectedIds.size} ${t('bulk.selected')}`}
                            style={[styles.bulkCount, { color: tc.secondaryText }]}
                        >
                            {selectedIds.size} {t('bulk.selected')}
                        </Text>
                        <View style={styles.bulkActions}>
                            <Pressable
                                onPress={selectAllTasks}
                                disabled={visibleTaskIds.length === 0 || selectedIds.size === visibleTaskIds.length}
                                accessibilityRole="button"
                                accessibilityLabel={`${tFallback(t, 'bulk.select', 'Select')} ${tFallback(t, 'common.all', 'all')}`}
                                style={[styles.bulkButton, { backgroundColor: tc.taskItemBg }]}
                            >
                                <Text style={[styles.bulkButtonText, { color: tc.text }]}>
                                    {tFallback(t, 'bulk.select', 'Select')} {tFallback(t, 'common.all', 'all')}
                                </Text>
                            </Pressable>
                            <Pressable
                                onPress={() => { void handleBulkRestore(); }}
                                disabled={selectedIds.size === 0}
                                accessibilityRole="button"
                                accessibilityLabel={t('trash.restoreToInbox')}
                                style={[styles.bulkButton, { backgroundColor: tc.taskItemBg }]}
                            >
                                <Text style={[styles.bulkButtonText, { color: tc.text }]}>
                                    {t('trash.restoreToInbox')}
                                </Text>
                            </Pressable>
                            <Pressable
                                onPress={handleBatchDelete}
                                disabled={selectedIds.size === 0}
                                accessibilityRole="button"
                                accessibilityLabel={tFallback(t, 'common.delete', 'Delete')}
                                style={[styles.bulkButton, { backgroundColor: tc.taskItemBg }]}
                            >
                                <Text style={[styles.bulkButtonText, { color: tc.danger }]}>
                                    {tFallback(t, 'common.delete', 'Delete')}
                                </Text>
                            </Pressable>
                        </View>
                    </View>
                )}
                {segment === 'projects' ? (
                    <FlatList
                        data={archivedProjects}
                        renderItem={renderArchivedProject}
                        keyExtractor={(item) => item.id}
                        style={styles.taskList}
                        contentContainerStyle={[
                            styles.taskListContent,
                            archivedProjects.length === 0 && styles.emptyContent,
                        ]}
                        {...TASK_LIST_WINDOWING_PROPS}
                        showsVerticalScrollIndicator={false}
                        ListEmptyComponent={
                            <View style={styles.emptyState}>
                                <Archive size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
                                <Text style={[styles.emptyTitle, { color: tc.text }]}>
                                    {tFallback(t, 'archived.emptyProjects', 'No archived projects')}
                                </Text>
                                <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                                    {tFallback(t, 'archived.emptyProjectsHint', 'Projects you archive will appear here')}
                                </Text>
                            </View>
                        }
                    />
                ) : (
                <FlatList
                    data={listItems}
                    renderItem={renderGroupedItem}
                    keyExtractor={groupedKeyExtractor}
                    extraData={listExtraData}
                    style={styles.taskList}
                    contentContainerStyle={[
                        styles.taskListContent,
                        archivedTasks.length === 0 && styles.emptyContent,
                    ]}
                    {...TASK_LIST_WINDOWING_PROPS}
                    showsVerticalScrollIndicator={false}
                    ListEmptyComponent={
                        <View style={styles.emptyState}>
                            <Archive size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
                            <Text style={[styles.emptyTitle, { color: tc.text }]}>
                                {selections.hasActive
                                    ? tFallback(t, 'filters.noMatch', 'No tasks match these filters.')
                                    : (tFallback(t, 'archived.empty', 'No archived tasks'))}
                            </Text>
                            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                                {selections.hasActive
                                    ? selections.chips.slice(0, 3).map((chip) => chip.label).join(', ')
                                    : (tFallback(t, 'archived.emptyHint', 'Tasks you archive will appear here'))}
                            </Text>
                            {selections.hasActive ? (
                                <Pressable
                                    onPress={selections.clear}
                                    accessibilityRole="button"
                                    accessibilityLabel={tFallback(t, 'filters.clear', 'Clear')}
                                    style={[styles.selectButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                                >
                                    <Text style={[styles.selectButtonText, { color: tc.text }]}>
                                        {tFallback(t, 'filters.clear', 'Clear')}
                                    </Text>
                                </Pressable>
                            ) : null}
                        </View>
                    }
                />
                )}
                <TaskFilterSheet
                    visible={filtersVisible}
                    onClose={() => setFiltersVisible(false)}
                    selections={selections}
                    options={{
                        tokens: tokenFilterOptions,
                        timeEstimates: timeEstimateFilterOptions,
                        visibility: metadataFilterVisibility,
                    }}
                    themeColors={tc}
                    t={t}
                    topContent={(
                        <>
                            <Text style={[styles.sheetSectionLabel, { color: tc.secondaryText }]}>
                                {tFallback(t, 'sort.label', 'Sort')}
                            </Text>
                            <View style={styles.sheetChipRow}>
                                {DONE_TASK_LIST_SORT_OPTIONS.map((option) => (
                                    <FilterChip
                                        key={`sort:${option}`}
                                        label={t(`sort.${option}`)}
                                        selected={sortBy === option}
                                        themeColors={tc}
                                        onPress={() => updateViewState({ sortBy: option })}
                                    />
                                ))}
                            </View>

                            <Text style={[styles.sheetSectionLabel, { color: tc.secondaryText }]}>
                                {tFallback(t, 'list.groupBy', 'Group')}
                            </Text>
                            <View style={styles.sheetChipRow}>
                                {ARCHIVED_LIST_GROUP_OPTIONS.map((option) => (
                                    <FilterChip
                                        key={`group:${option}`}
                                        label={getTaskGroupByLabel(option, t)}
                                        selected={groupBy === option}
                                        themeColors={tc}
                                        onPress={() => updateViewState({ groupBy: option })}
                                    />
                                ))}
                            </View>
                        </>
                    )}
                />
                <TaskEditModal
                    visible={Boolean(selectedTask)}
                    task={selectedTask}
                    onClose={() => setSelectedTaskId(null)}
                    onSave={handleSaveTask}
                    defaultTab="view"
                    onProjectNavigate={openProjectScreen}
                    onContextNavigate={openContextsScreen}
                    onTagNavigate={openContextsScreen}
                />
                {completedAtTask ? (
                    <CompletedAtPicker
                        initialValue={completedAtTask.completedAt || completedAtTask.updatedAt}
                        onCancel={() => setCompletedAtTaskId(null)}
                        onConfirm={applyCompletedAt}
                        t={t}
                        tc={tc}
                    />
                ) : null}
            </View>
        </GestureHandlerRootView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    searchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingBottom: 8,
    },
    searchInput: {
        flex: 1,
        borderWidth: 1,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 8,
        fontSize: 15,
    },
    filtersButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderWidth: 1,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 9,
    },
    filtersButtonText: {
        fontSize: 13,
        fontWeight: '600',
    },
    groupHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        paddingHorizontal: 4,
        paddingTop: 14,
        paddingBottom: 6,
    },
    groupHeaderText: {
        flex: 1,
        fontSize: 13,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
    },
    groupHeaderCount: {
        fontSize: 12,
    },
    sheetSectionLabel: {
        fontSize: 12,
        fontWeight: '600',
        marginTop: 12,
        marginBottom: 6,
    },
    sheetChipRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    segmentRow: {
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 8,
        flexDirection: 'row',
        gap: 8,
    },
    segmentChip: {
        borderWidth: 1,
        borderRadius: 16,
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    segmentChipText: {
        fontSize: 12,
        fontWeight: '600',
    },
    summaryRow: {
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 2,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    summaryText: {
        fontSize: 13,
        fontWeight: '500',
    },
    selectButton: {
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    selectButtonText: {
        fontSize: 12,
        fontWeight: '600',
    },
    bulkBar: {
        marginHorizontal: 16,
        marginTop: 10,
        borderWidth: 1,
        borderRadius: 10,
        padding: 10,
        gap: 8,
    },
    bulkCount: {
        fontSize: 12,
        fontWeight: '600',
    },
    bulkActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    bulkButton: {
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 7,
    },
    bulkButtonText: {
        fontSize: 12,
        fontWeight: '600',
    },
    taskList: {
        flex: 1,
    },
    taskListContent: {
        padding: 16,
    },
    emptyContent: {
        flexGrow: 1,
    },
    taskItem: {
        flexDirection: 'row',
        borderRadius: 12,
        padding: 16,
        marginBottom: 12,
        borderWidth: 1,
    },
    taskItemPressed: {
        opacity: 0.85,
    },
    selectionIndicator: {
        width: 22,
        height: 22,
        borderWidth: 2,
        borderRadius: 11,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    selectionMark: {
        fontSize: 14,
        fontWeight: '700',
        lineHeight: 16,
    },
    taskContent: {
        flex: 1,
    },
    taskTitle: {
        fontSize: 16,
        fontWeight: '600',
        marginBottom: 4,
        textDecorationLine: 'line-through',
    },
    taskDescription: {
        fontSize: 14,
        marginBottom: 4,
    },
    archivedDate: {
        fontSize: 12,
        fontStyle: 'italic',
    },
    archivedDateButton: {
        alignSelf: 'flex-start',
    },
    statusIndicator: {
        width: 4,
        borderRadius: 2,
        marginLeft: 12,
    },
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
        marginBottom: 8,
    },
    emptyText: {
        fontSize: 14,
        textAlign: 'center',
    },
    swipeActionRestore: {
        backgroundColor: '#3B82F6',
        justifyContent: 'center',
        alignItems: 'center',
        width: 100,
        borderRadius: 12,
        marginBottom: 12,
        marginRight: 8,
    },
    swipeActionDelete: {
        backgroundColor: '#EF4444',
        justifyContent: 'center',
        alignItems: 'center',
        width: 100,
        borderRadius: 12,
        marginBottom: 12,
        marginLeft: 8,
    },
    swipeActionText: {
        color: '#FFFFFF',
        fontWeight: '600',
        fontSize: 14,
    },
});

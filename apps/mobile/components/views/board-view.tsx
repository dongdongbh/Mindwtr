import { View, Text, ScrollView, StyleSheet, Platform, Pressable, TextInput } from 'react-native';
import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureDetector, Gesture, Swipeable } from 'react-native-gesture-handler';
import { Clock3, Filter, Folder, X } from 'lucide-react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  runOnJS,
  type SharedValue,
} from 'react-native-reanimated';
import {
  BOARD_CARD_SWIPES,
  BOARD_COLUMNS,
  BOARD_FILTER_VISIBILITY,
  buildBoardColumns,
  getBoardCard,
  getBoardCardText,
  getBoardFilterOptions,
  getBoardFilterSummary,
  getBoardProjectBadges,
  planBoardDrop,
  selectBoardTasks,
  shallow,
  toggleBoardDuePreset,
  useTaskStore,
  resolveFeatureFlags,
} from '@mindwtr/core';
import type { BoardCard, BoardDuePreset, BoardProjectBadge, Task, FilterCriteria } from '@mindwtr/core';
import { useToast } from '@/contexts/toast-context';
import { useVisibleTaskContext } from '@/hooks/use-visible-tasks';
import { useThemeColors, type ThemeColors } from '@/hooks/use-theme-colors';
import { openContextsScreen, openProjectScreen, openTaskScreen } from '@/lib/task-meta-navigation';

import { useLanguage } from '../../contexts/language-context';
import { useThemePreset } from '@/hooks/use-eink-safe-color';
import { TaskEditModal } from '../task-edit-modal';
import { FilterChip, TaskFilterSheet, type TaskFilterSheetActiveChip } from '../task-filter-sheet';
import { useTaskFilterSelections } from '@/hooks/use-task-filter-selections';
import { resolveBoardColumnDropTarget, resolveBoardDropColumnIndex, resolveBoardDropColumnIndexFromY } from './board-view.utils';

type SwipeSide = keyof typeof BOARD_CARD_SWIPES;

type RelativeTaskLayout = {
  columnIndex: number;
  y: number;
  height: number;
};

type ColumnLayout = {
  y: number;
  height: number;
};

type DragStartMetrics = {
  taskId: string;
  topY: number;
  height: number;
};

interface DraggableTaskProps {
  task: Task;
  tc: ThemeColors;
  currentColumnIndex: number;
  onDrop: (taskId: string, translationYDelta: number) => void;
  onDragStart: (taskId: string, columnIndex: number) => void;
  onDragMove: (absoluteY: number, translationY: number) => void;
  onDragEnd: () => void;
  onTap: (task: Task) => void;
  onSwipe: (task: Task, side: SwipeSide) => void;
  deleteLabel: string;
  duplicateLabel: string;
  dragScrollCompensation: SharedValue<number>;
  isDragActive: boolean;
  card: BoardCard;
  onLayout: (taskId: string, columnIndex: number, y: number, height: number) => void;
}

function DraggableTask({
  task,
  tc,
  currentColumnIndex,
  onDrop,
  onDragStart,
  onDragMove,
  onDragEnd,
  onTap,
  onSwipe,
  deleteLabel,
  duplicateLabel,
  dragScrollCompensation,
  isDragActive,
  card,
  onLayout,
}: DraggableTaskProps) {
  const translateY = useSharedValue(0);
  const scale = useSharedValue(1);
  const zIndex = useSharedValue(1);
  const isDragging = useSharedValue(false);

  const handleDropAndEndFromGesture = useCallback((taskId: string, translationYDelta: number) => {
    onDrop(taskId, translationYDelta);
    onDragEnd();
  }, [onDrop, onDragEnd]);


  const tapGesture = Gesture.Tap()
    .onEnd(() => {
      runOnJS(onTap)(task);
    });


  const panGesture = Gesture.Pan()
    .activateAfterLongPress(180)
    .activeOffsetY([-12, 12])
    .failOffsetX([-24, 24])
    .onStart(() => {
      isDragging.value = true;
      scale.value = withSpring(1.05);
      zIndex.value = 1000;
      runOnJS(onDragStart)(task.id, currentColumnIndex);
    })
    .onUpdate((event) => {
      translateY.value = event.translationY;
      runOnJS(onDragMove)(event.absoluteY, event.translationY);
    })
    .onEnd((event) => {
      isDragging.value = false;
      runOnJS(handleDropAndEndFromGesture)(task.id, event.translationY);

      translateY.value = withSpring(0);
      scale.value = withSpring(1);
      zIndex.value = 1;
    });


  const composedGesture = Gesture.Race(
    panGesture,
    tapGesture
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: translateY.value + (isDragActive ? dragScrollCompensation.value : 0) },
      { scale: scale.value },
    ],
    position: 'relative',
    zIndex: zIndex.value,
    elevation: isDragging.value ? 100 : 1,
    opacity: isDragging.value ? 0.85 : 1,
  }));

  const { projectTitle, timeEstimateLabel } = card;
  const resolvedProjectColor = card.projectColor || tc.secondaryText;

  return (
    <GestureDetector gesture={composedGesture}>
      <Animated.View
        style={[
          styles.taskCardContainer,
          animatedStyle,
        ]}
        onLayout={(event) => {
          const { y, height } = event.nativeEvent.layout;
          onLayout(task.id, currentColumnIndex, y, height);
        }}
      >
        <Swipeable
          renderLeftActions={() => (
            <View style={[styles.duplicateAction, { backgroundColor: tc.bg, borderColor: tc.tint }]}>
              <Text style={[styles.duplicateActionText, { color: tc.text }]}>{duplicateLabel}</Text>
            </View>
          )}
          renderRightActions={() => (
            <View style={[styles.deleteAction, { backgroundColor: tc.bg, borderColor: tc.danger }]}>
              <Text style={[styles.deleteActionText, { color: tc.text }]}>{deleteLabel}</Text>
            </View>
          )}
          onSwipeableOpen={(side, swipeable) => { swipeable.close(); onSwipe(task, side); }}
        >
	          <View style={[
	            styles.taskCard,
	            { backgroundColor: tc.taskItemBg, borderColor: tc.border },
	          ]}>
	            <Text style={[styles.taskTitle, { color: tc.text }]} numberOfLines={2}>
	              {task.title}
	            </Text>
              {card.showMetaRow && (
                <View style={styles.contextsRow}>
                  {projectTitle && (
                    <View style={[styles.projectBadge, { backgroundColor: tc.filterBg, borderColor: resolvedProjectColor }]}>
                      <Folder size={12} color={tc.text} accessible={false} />
                      <Text style={[styles.projectBadgeText, { color: tc.text }]} numberOfLines={1}>
                        {projectTitle}
                      </Text>
                    </View>
                  )}
                  {card.tags.map((tag, idx) => (
                    <Text
                      key={`${tag}-${idx}`}
                      style={[
                        styles.tagChip,
                        { backgroundColor: tc.filterBg, borderColor: tc.border, color: tc.secondaryText },
                      ]}
                    >
                      {tag}
                    </Text>
                  ))}
                  {card.contexts.map((ctx, idx) => (
                    <Text
                      key={`${ctx}-${idx}`}
                      style={[
                        styles.contextTag,
                        { backgroundColor: tc.filterBg, borderColor: tc.border, color: tc.secondaryText },
                      ]}
                    >
                      {ctx}
                    </Text>
                  ))}
                  {timeEstimateLabel && (
                    <View style={[styles.timeEstimateBadge, { backgroundColor: tc.filterBg, borderColor: tc.border }]}>
                      <Clock3 size={12} color={tc.secondaryText} accessible={false} />
                      <Text style={[styles.timeEstimateText, { color: tc.secondaryText }]}>{timeEstimateLabel}</Text>
                    </View>
                  )}
                </View>
              )}
	          </View>
	        </Swipeable>
	      </Animated.View>
    </GestureDetector>
  );
}

interface ColumnProps {
  columnIndex: number;
  label: string;
  color: string;
  tasks: Task[];
  tc: ThemeColors;
  isDragSourceColumn: boolean;
  onDrop: (taskId: string, translationYDelta: number) => void;
  onDragStart: (taskId: string, columnIndex: number) => void;
  onDragMove: (absoluteY: number, translationY: number) => void;
  onDragEnd: () => void;
  onTap: (task: Task) => void;
  onSwipe: (task: Task, side: SwipeSide) => void;
  noTasksLabel: string | null;
  deleteLabel: string;
  duplicateLabel: string;
  draggingTaskId: string | null;
  dragScrollCompensation: SharedValue<number>;
  badges: Map<string, BoardProjectBadge>;
  timeEstimatesEnabled: boolean;
  t: (key: string) => string;
  onColumnLayout: (columnIndex: number, y: number, height: number) => void;
  onColumnContentLayout: (columnIndex: number, y: number) => void;
  onTaskLayout: (taskId: string, columnIndex: number, y: number, height: number) => void;
}

function Column({
  columnIndex,
  label,
  color,
  tasks,
  tc,
  isDragSourceColumn,
  onDrop,
  onDragStart,
  onDragMove,
  onDragEnd,
  onTap,
  onSwipe,
  noTasksLabel,
  deleteLabel,
  duplicateLabel,
  draggingTaskId,
  dragScrollCompensation,
  badges,
  timeEstimatesEnabled,
  t,
  onColumnLayout,
  onColumnContentLayout,
  onTaskLayout,
}: ColumnProps) {
  return (
    <View style={[
      styles.column,
      isDragSourceColumn ? styles.columnDragSource : null,
      { borderTopColor: color, backgroundColor: tc.cardBg },
    ]}
    onLayout={(event) => {
      const { y, height } = event.nativeEvent.layout;
      onColumnLayout(columnIndex, y, height);
    }}>
      <View style={[styles.columnHeader, { borderBottomColor: tc.border }]}>
        <Text style={[styles.columnTitle, { color: tc.text }]}>{label}</Text>
        <View style={[styles.badge, { backgroundColor: tc.filterBg, borderColor: color }]}>
          <Text style={[styles.badgeText, { color: tc.text }]}>{tasks.length}</Text>
        </View>
      </View>
      <View
        style={styles.columnContent}
        onLayout={(event) => {
          onColumnContentLayout(columnIndex, event.nativeEvent.layout.y);
        }}
      >
        {tasks.map((task) => (
          <DraggableTask
            key={task.id}
            task={task}
            tc={tc}
            currentColumnIndex={columnIndex}
            onDrop={onDrop}
            onDragStart={onDragStart}
            onDragMove={onDragMove}
            onDragEnd={onDragEnd}
            onTap={onTap}
            onSwipe={onSwipe}
            deleteLabel={deleteLabel}
            duplicateLabel={duplicateLabel}
            isDragActive={draggingTaskId === task.id}
            dragScrollCompensation={dragScrollCompensation}
            card={getBoardCard(task, { badges, timeEstimatesEnabled, t })}
            onLayout={onTaskLayout}
          />
        ))}
        {noTasksLabel !== null && (
          <View style={styles.emptyColumn}>
            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
              {noTasksLabel}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

export function BoardView() {
  const { tasks, projects, updateTask, deleteTask, duplicateTask, reorderBoardTasks, timeEstimatesEnabled } = useTaskStore((state) => ({
    tasks: state.tasks,
    projects: state.projects,
    updateTask: state.updateTask,
    deleteTask: state.deleteTask,
    duplicateTask: state.duplicateTask,
    reorderBoardTasks: state.reorderBoardTasks,
    timeEstimatesEnabled: resolveFeatureFlags(state.settings).timeEstimates,
  }), shallow);
  const tc = useThemeColors();
  const { t } = useLanguage();
  const { showToast } = useToast();
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [dragSourceColumnIndex, setDragSourceColumnIndex] = useState<number | null>(null);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [dueFilterExpanded, setDueFilterExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [boardCriteria, setBoardCriteria] = useState<FilterCriteria>({});
  const insets = useSafeAreaInsets();
  const boardScrollRef = useRef<ScrollView | null>(null);
  const draggingTaskIdRef = useRef<string | null>(null);
  const scrollOffsetRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const contentHeightRef = useRef(0);
  const dragStartScrollOffsetRef = useRef(0);
  const currentDragTranslationYRef = useRef(0);
  const dragScrollCompensationRef = useRef(0);
  const dragScrollCompensationSv = useSharedValue(0);
  const autoScrollDirectionRef = useRef<-1 | 0 | 1>(0);
  const autoScrollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const columnLayoutsRef = useRef<Record<number, ColumnLayout>>({});
  const columnContentOffsetRef = useRef<Record<number, number>>({});
  const taskLayoutsRef = useRef<Record<string, RelativeTaskLayout>>({});
  const dragStartMetricsRef = useRef<DragStartMetrics | null>(null);

  const navBarInset = Platform.OS === 'android' && insets.bottom >= 24 ? insets.bottom : 0;
  const boardContentStyle = useMemo(
    () => (navBarInset ? [styles.boardContent, { paddingBottom: 16 + navBarInset }] : styles.boardContent),
    [navBarInset],
  );

  const { areaById, resolvedAreaFilter, visibleTasks } = useVisibleTaskContext();
  const themePreset = useThemePreset();
  const badges = useMemo(() => getBoardProjectBadges(projects, areaById, themePreset), [areaById, projects, themePreset]);


  const areaActiveTasks = useMemo(() => selectBoardTasks(visibleTasks), [visibleTasks]);

  const filterOptions = useMemo(() => getBoardFilterOptions({
    tasks: areaActiveTasks, projects, areaFilter: resolvedAreaFilter, areaById, badges, t,
  }), [areaActiveTasks, projects, resolvedAreaFilter, areaById, badges, t]);
  const projectFilterOptionIds = useMemo(
    () => filterOptions.projects.map((project) => project.id),
    [filterOptions.projects],
  );
  const clearBoardFilterExtras = useCallback(() => {
    setBoardCriteria({});
    setDueFilterExpanded(false);
    setSearchQuery('');
  }, []);
  const selections = useTaskFilterSelections({


    view: 'focus',
    t,
    visibility: BOARD_FILTER_VISIBILITY,
    retainTokens: filterOptions.tokens,
    retainProjects: projectFilterOptionIds,
    getProjectLabel: filterOptions.getProjectLabel,
    onClear: clearBoardFilterExtras,
  });
  const {
    contextMatchMode,
    setMatchMode,
    tagMatchMode,
    tokens: selectedFilterTokens,
  } = selections;
  useEffect(() => {


    if (!selectedFilterTokens.some((token) => token.startsWith('@')) && contextMatchMode !== 'any') {
      setMatchMode('context', 'any');
    }
    if (!selectedFilterTokens.some((token) => token.startsWith('#')) && tagMatchMode !== 'any') {
      setMatchMode('tag', 'any');
    }
  }, [
    contextMatchMode,
    selectedFilterTokens,
    setMatchMode,
    tagMatchMode,
  ]);
  const criteria = useMemo<FilterCriteria>(() => ({
    ...selections.criteria,
    ...boardCriteria,
  }), [boardCriteria, selections.criteria]);
  const summary = useMemo(() => getBoardFilterSummary({ criteria, searchQuery, t }), [criteria, searchQuery, t]);
  const activeDuePreset = summary.duePreset;
  const additionalActiveChips = useMemo<TaskFilterSheetActiveChip[]>(() => summary.chips.map((chip) => ({
    ...chip,
    onPress: chip.id === 'board-search'
      ? () => setSearchQuery('')
      : () => {
        setBoardCriteria((current) => {
          const next = { ...current };
          delete next.dueDateRange;
          return next;
        });
        setDueFilterExpanded(false);
      },
  })), [summary.chips]);

  const searchActive = summary.searchActive;
  const boardFiltersActive = summary.active;


  const columns = useMemo(() => buildBoardColumns({
    tasks: areaActiveTasks, criteria, searchQuery, projects, now: new Date(), t,
  }), [areaActiveTasks, criteria, searchQuery, projects, t]);
  const cardText = useMemo(() => getBoardCardText(t), [t]);

  const handleToggleDuePreset = useCallback((preset: BoardDuePreset) => {
    setBoardCriteria((prev) => toggleBoardDuePreset(prev, preset));
    setDueFilterExpanded(false);
  }, []);
  const clearFilters = selections.clear;
  const clearSearch = useCallback(() => setSearchQuery(''), []);
  const closeFilters = useCallback(() => {
    setFiltersOpen(false);
    setDueFilterExpanded(false);
  }, []);

  const getTaskTopInContent = useCallback((taskId: string): number | null => {
    const taskLayout = taskLayoutsRef.current[taskId];
    if (!taskLayout) return null;
    const columnLayout = columnLayoutsRef.current[taskLayout.columnIndex];
    if (!columnLayout) return null;
    const columnContentOffset = columnContentOffsetRef.current[taskLayout.columnIndex] ?? 0;
    return columnLayout.y + columnContentOffset + taskLayout.y;
  }, []);

  const getColumnBounds = useCallback(() => {
    const bounds = BOARD_COLUMNS.map((_, index) => {
      const layout = columnLayoutsRef.current[index];
      if (!layout) return null;
      return {
        index,
        top: layout.y,
        bottom: layout.y + layout.height,
      };
    }).filter((item): item is { index: number; top: number; bottom: number } => item !== null);
    return bounds;
  }, []);

  const handleColumnLayout = useCallback((columnIndex: number, y: number, height: number) => {
    columnLayoutsRef.current[columnIndex] = { y, height };
  }, []);

  const handleColumnContentLayout = useCallback((columnIndex: number, y: number) => {
    columnContentOffsetRef.current[columnIndex] = y;
  }, []);

  const handleTaskLayout = useCallback((taskId: string, columnIndex: number, y: number, height: number) => {
    taskLayoutsRef.current[taskId] = { columnIndex, y, height };
  }, []);

  const handleDrop = useCallback((taskId: string, translationYDelta: number) => {
    const effectiveTranslationY = translationYDelta + dragScrollCompensationRef.current;
    const currentTask = tasks.find((item) => item.id === taskId);
    const currentStatus = currentTask?.status;
    const currentColumnIndex = BOARD_COLUMNS.findIndex((column) => column.status === currentStatus);
    if (currentColumnIndex < 0) return;

    let newColumnIndex = currentColumnIndex;
    let dragCenterY: number | null = null;
    const dragStartMetrics = dragStartMetricsRef.current;
    if (dragStartMetrics?.taskId === taskId) {
      dragCenterY = dragStartMetrics.topY + effectiveTranslationY + (dragStartMetrics.height / 2);
      const columnBounds = getColumnBounds();
      if (columnBounds.length > 0) {
        newColumnIndex = resolveBoardDropColumnIndexFromY({
          dragCenterY,
          currentColumnIndex,
          columnBounds,
        });
      } else {
        newColumnIndex = resolveBoardDropColumnIndex({
          translationX: effectiveTranslationY,
          currentColumnIndex,
          columnCount: BOARD_COLUMNS.length,
        });
      }
    } else {
      newColumnIndex = resolveBoardDropColumnIndex({
        translationX: effectiveTranslationY,
        currentColumnIndex,
        columnCount: BOARD_COLUMNS.length,
      });
    }

    if (newColumnIndex < 0 || newColumnIndex >= BOARD_COLUMNS.length || !currentTask) return;


    let target: { columnIds: string[]; afterId?: string | null } = { columnIds: [] };
    if (newColumnIndex === currentColumnIndex) {
      if (dragCenterY === null) return;
      const columnTaskLayouts = columns[currentColumnIndex].tasks
        .map((columnTask) => {
          const top = getTaskTopInContent(columnTask.id);
          const height = taskLayoutsRef.current[columnTask.id]?.height;
          if (top === null || typeof height !== 'number' || !Number.isFinite(height)) return null;
          return { id: columnTask.id, top, height };
        })
        .filter((item): item is { id: string; top: number; height: number } => item !== null);
      const measured = resolveBoardColumnDropTarget({
        taskId,
        dragCenterY,
        columnTasks: columnTaskLayouts,
      });
      if (!measured) return;
      target = measured;
    }

    const plan = planBoardDrop({ task: currentTask, status: BOARD_COLUMNS[newColumnIndex].status, ...target });
    if (plan?.kind === 'reorder') void reorderBoardTasks(plan.status, plan.orderedIds, plan.taskId);
    else if (plan?.kind === 'status') updateTask(plan.taskId, { status: plan.status });
  }, [columns, getColumnBounds, getTaskTopInContent, reorderBoardTasks, tasks, updateTask]);

  const handleTap = useCallback((task: Task) => {
    setEditingTask(task);
  }, []);

  const handleSave = useCallback((taskId: string, updates: Partial<Task>) => {
    return updateTask(taskId, updates);
  }, [updateTask]);

  const handleDelete = useCallback((taskId: string) => {
    deleteTask(taskId);
  }, [deleteTask]);

  const handleDuplicate = useCallback(async (task: Task) => {
    try {
      const result = await duplicateTask(task.id, false);
      if (!result.success || !result.id) {
        showToast({
          title: cardText.errorTitle,
          message: result.error || cardText.duplicateFailed,
          tone: 'error',
        });
        return;
      }
      openTaskScreen(result.id, task.projectId, 'task');
    } catch {
      showToast({
        title: cardText.errorTitle,
        message: cardText.duplicateFailed,
        tone: 'error',
      });
    }
  }, [cardText, duplicateTask, showToast]);

  const handleSwipe = useCallback((task: Task, side: SwipeSide) => {
    for (const action of BOARD_CARD_SWIPES[side].actions) {
      if (action === 'duplicate') void handleDuplicate(task);
      else handleDelete(task.id);
    }
  }, [handleDelete, handleDuplicate]);

  const stopAutoScroll = useCallback(() => {
    autoScrollDirectionRef.current = 0;
    if (autoScrollIntervalRef.current) {
      clearInterval(autoScrollIntervalRef.current);
      autoScrollIntervalRef.current = null;
    }
  }, []);

  const startAutoScroll = useCallback((direction: -1 | 1) => {
    if (autoScrollDirectionRef.current === direction && autoScrollIntervalRef.current) {
      return;
    }
    stopAutoScroll();
    autoScrollDirectionRef.current = direction;
    autoScrollIntervalRef.current = setInterval(() => {
      const maxOffset = Math.max(0, contentHeightRef.current - viewportHeightRef.current);
      if (maxOffset <= 0) {
        stopAutoScroll();
        return;
      }
      const edgeDistanceTop = currentDragTranslationYRef.current;
      const speed = Math.max(6, Math.min(14, Math.floor(Math.abs(edgeDistanceTop) / 24)));
      const nextOffset = Math.max(0, Math.min(maxOffset, scrollOffsetRef.current + (direction * speed)));
      if (nextOffset === scrollOffsetRef.current) {
        stopAutoScroll();
        return;
      }
      scrollOffsetRef.current = nextOffset;
      if (draggingTaskIdRef.current) {
        const nextCompensation = nextOffset - dragStartScrollOffsetRef.current;
        dragScrollCompensationRef.current = nextCompensation;
        dragScrollCompensationSv.value = nextCompensation;
      }
      boardScrollRef.current?.scrollTo({ y: nextOffset, animated: false });
    }, 16);
  }, [dragScrollCompensationSv, stopAutoScroll]);

  const handleDragStart = useCallback((taskId: string, columnIndex: number) => {
    setDraggingTaskId(taskId);
    draggingTaskIdRef.current = taskId;
    setDragSourceColumnIndex(columnIndex);
    dragStartScrollOffsetRef.current = scrollOffsetRef.current;
    currentDragTranslationYRef.current = 0;
    dragScrollCompensationRef.current = 0;
    dragScrollCompensationSv.value = 0;
    const dragTaskHeight = taskLayoutsRef.current[taskId]?.height;
    const dragTaskTopY = getTaskTopInContent(taskId);
    if (
      dragTaskTopY !== null &&
      Number.isFinite(dragTaskHeight) &&
      typeof dragTaskHeight === 'number' &&
      dragTaskHeight > 0
    ) {
      dragStartMetricsRef.current = {
        taskId,
        topY: dragTaskTopY,
        height: dragTaskHeight,
      };
    } else {
      dragStartMetricsRef.current = null;
    }
    stopAutoScroll();
  }, [dragScrollCompensationSv, getTaskTopInContent, stopAutoScroll]);

  const handleDragMove = useCallback((absoluteY: number, translationY: number) => {
    currentDragTranslationYRef.current = translationY;
    const viewportHeight = viewportHeightRef.current;
    if (viewportHeight <= 0) return;
    const edgeThreshold = 72;
    if (absoluteY <= edgeThreshold) {
      startAutoScroll(-1);
      return;
    }
    if (absoluteY >= (viewportHeight - edgeThreshold)) {
      startAutoScroll(1);
      return;
    }
    stopAutoScroll();
  }, [startAutoScroll, stopAutoScroll]);

  const handleDragEnd = useCallback(() => {
    setDraggingTaskId(null);
    draggingTaskIdRef.current = null;
    setDragSourceColumnIndex(null);
    currentDragTranslationYRef.current = 0;
    dragScrollCompensationRef.current = 0;
    dragScrollCompensationSv.value = 0;
    dragStartMetricsRef.current = null;
    stopAutoScroll();
  }, [dragScrollCompensationSv, stopAutoScroll]);

  useEffect(() => {
    return () => {
      stopAutoScroll();
    };
  }, [stopAutoScroll]);

  useEffect(() => {
    const liveTaskIds = new Set(tasks.map((task) => task.id));
    for (const taskId of Object.keys(taskLayoutsRef.current)) {
      if (!liveTaskIds.has(taskId)) {
        delete taskLayoutsRef.current[taskId];
      }
    }
    if (dragStartMetricsRef.current && !liveTaskIds.has(dragStartMetricsRef.current.taskId)) {
      dragStartMetricsRef.current = null;
    }
  }, [tasks]);

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <View style={[styles.filterBar, { borderBottomColor: tc.border }]}>
        <View style={styles.filterControlsRow} testID="board-filter-controls">
          <View style={styles.searchRow}>
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={summary.searchPlaceholder}
              placeholderTextColor={tc.secondaryText}
              accessibilityLabel={summary.searchPlaceholder}
              returnKeyType="search"
              clearButtonMode="while-editing"
              style={[
                styles.searchInput,
                searchActive ? styles.searchInputWithClear : null,
                {
                  backgroundColor: searchActive ? tc.filterBg : tc.inputBg,
                  borderColor: searchActive ? tc.tint : tc.border,
                  color: tc.text,
                },
              ]}
            />
            {searchActive && (
              <Pressable
                onPress={clearSearch}
                accessibilityRole="button"
                accessibilityLabel={summary.clearLabel}
                hitSlop={8}
                style={[styles.searchClearButton, { backgroundColor: tc.cardBg }]}
              >
                <X size={16} color={tc.secondaryText} />
              </Pressable>
            )}
          </View>
          <View style={styles.filterActionsRow}>
            {boardFiltersActive && (
              <Pressable onPress={clearFilters} accessibilityRole="button" hitSlop={8} style={styles.filterClearButton}>
                <Text style={[styles.filterClearText, { color: tc.tint }]}>{summary.clearLabel}</Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => setFiltersOpen(true)}
              accessibilityRole="button"
              accessibilityState={{ expanded: filtersOpen }}
              style={[
                styles.filterToggle,
                {
                  backgroundColor: boardFiltersActive ? tc.tint : tc.filterBg,
                  borderColor: boardFiltersActive ? tc.tint : tc.border,
                },
              ]}
            >
              <Filter size={14} color={boardFiltersActive ? tc.onTint : tc.secondaryText} />
              <Text style={[styles.filterToggleText, { color: boardFiltersActive ? tc.onTint : tc.text }]}>
                {summary.filterLabel}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
      <ScrollView
        ref={boardScrollRef}
        showsVerticalScrollIndicator={false}
        style={styles.boardScroll}
        contentContainerStyle={boardContentStyle}
        onLayout={(event) => {
          viewportHeightRef.current = event.nativeEvent.layout.height;
        }}
        onContentSizeChange={(_w, h) => {
          contentHeightRef.current = h;
        }}
        onScroll={(event) => {
          const nextOffset = event.nativeEvent.contentOffset.y;
          scrollOffsetRef.current = nextOffset;
          if (draggingTaskIdRef.current) {
            const nextCompensation = nextOffset - dragStartScrollOffsetRef.current;
            dragScrollCompensationRef.current = nextCompensation;
            dragScrollCompensationSv.value = nextCompensation;
          }
        }}
        scrollEventThrottle={16}
      >
        {columns.map((column, index) => (
          <Column
            key={column.status}
            columnIndex={index}
            label={column.label}
            color={tc[column.tone]}
            tasks={column.tasks}
            tc={tc}
            isDragSourceColumn={dragSourceColumnIndex === index}
            onDrop={handleDrop}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onTap={handleTap}
            onSwipe={handleSwipe}
            noTasksLabel={column.empty}
            deleteLabel={cardText.delete}
            duplicateLabel={cardText.duplicate}
            draggingTaskId={draggingTaskId}
            dragScrollCompensation={dragScrollCompensationSv}
            badges={badges}
            timeEstimatesEnabled={timeEstimatesEnabled}
            t={t}
            onColumnLayout={handleColumnLayout}
            onColumnContentLayout={handleColumnContentLayout}
            onTaskLayout={handleTaskLayout}
          />
        ))}
      </ScrollView>

      <TaskFilterSheet
        visible={filtersOpen}
        onClose={closeFilters}
        selections={selections}
        options={{
          tokens: filterOptions.tokens,
          projects: filterOptions.projects,
          timeEstimates: [],
          visibility: BOARD_FILTER_VISIBILITY,
        }}
        themeColors={tc}
        t={t}
        hasAdditionalActiveFilters={additionalActiveChips.length > 0}
        additionalActiveChips={additionalActiveChips}
        topContent={(
          <View style={styles.filterSection}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: dueFilterExpanded }}
              accessibilityLabel={summary.due.accessibilityLabel}
              onPress={() => setDueFilterExpanded((expanded) => !expanded)}
              style={[styles.dueFilterDisclosure, { backgroundColor: tc.bg, borderColor: tc.border }]}
            >
              <View style={styles.dueFilterDisclosureText}>
                <Text style={[styles.dueFilterLabel, { color: tc.text }]}>
                  {summary.due.label}
                </Text>
                <Text style={[styles.dueFilterSummary, { color: activeDuePreset ? tc.tint : tc.secondaryText }]}>
                  {summary.due.summary}
                </Text>
              </View>
              <Text style={[styles.dueFilterDisclosureMark, { color: tc.secondaryText }]}>
                {dueFilterExpanded ? '−' : '+'}
              </Text>
            </Pressable>
            {dueFilterExpanded ? (
              <View style={styles.filterChipRow}>
                {summary.due.presets.map(({ preset, label, selected }) => (
                  <FilterChip
                    key={`due:${preset}`}
                    label={label}
                    selected={selected}
                    themeColors={tc}
                    onPress={() => handleToggleDuePreset(preset)}
                  />
                ))}
              </View>
            ) : null}
          </View>
        )}
      />

      {                     }
      <TaskEditModal
        visible={!!editingTask}
        task={editingTask}
        onClose={() => setEditingTask(null)}
        onSave={handleSave}
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
  },
  filterBar: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  filterControlsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
  },
  filterActionsRow: {
    marginLeft: 'auto',
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  filterToggle: {
    minHeight: 44,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  filterToggleText: {
    fontSize: 13,
    fontWeight: '600',
  },
  filterClearText: {
    fontSize: 13,
    fontWeight: '500',
  },
  filterClearButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchRow: {
    flexBasis: 180,
    flexGrow: 1,
    minWidth: 140,
    position: 'relative',
  },
  searchInput: {
    width: '100%',
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 14,
  },
  searchInputWithClear: {
    paddingRight: 44,
  },
  searchClearButton: {
    position: 'absolute',
    right: 8,
    top: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterSection: {
    gap: 8,
  },
  dueFilterDisclosure: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  dueFilterDisclosureText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  dueFilterLabel: {
    fontSize: 15,
    fontWeight: '500',
  },
  dueFilterSummary: {
    fontSize: 13,
  },
  dueFilterDisclosureMark: {
    width: 20,
    fontSize: 20,
    fontWeight: '400',
    textAlign: 'center',
  },
  filterChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  boardScroll: {
    flex: 1,
  },
  boardContent: {
    padding: 16,
    gap: 16,
    overflow: 'visible',
  },
  column: {
    width: '100%',
    borderRadius: 12,
    borderTopWidth: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
    minHeight: 100,
    overflow: 'visible',
  },
  columnDragSource: {
    zIndex: 500,
    elevation: 500,
  },
  columnHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: 1,
  },
  columnTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    borderWidth: 1,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  columnContent: {
    padding: 10,
    minHeight: 50,
    overflow: 'visible',
  },
  emptyColumn: {
    alignItems: 'center',
    paddingVertical: 16,
  },
  emptyText: {
    fontSize: 13,
  },
  taskCard: {
    borderRadius: 8,
    padding: 12,

    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 3,
    borderWidth: 1,
  },
  taskCardContainer: {
    marginBottom: 8,
    borderRadius: 8,
    overflow: 'visible',
  },
  deleteAction: {
    justifyContent: 'center',
    alignItems: 'flex-end',
    flex: 1,
    paddingRight: 20,
    borderRadius: 8,
    borderWidth: 1,
  },
  deleteActionText: {
    fontWeight: '600',
    fontSize: 14,
  },
  duplicateAction: {
    justifyContent: 'center',
    alignItems: 'flex-start',
    flex: 1,
    paddingLeft: 20,
    borderRadius: 8,
    borderWidth: 1,
  },
  duplicateActionText: {
    fontWeight: '600',
    fontSize: 14,
  },
  taskTitle: {
    fontSize: 14,
    fontWeight: '500',
  },
  contextsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 6,
  },
  projectBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 1,
    alignSelf: 'flex-start',
  },
  projectBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 14,
  },
  contextTag: {
    fontSize: 11,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    lineHeight: 14,
    borderWidth: 1,
  },
  tagChip: {
    fontSize: 11,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    lineHeight: 14,
    borderWidth: 1,
  },
  timeEstimateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
  },
  timeEstimateText: {
    fontSize: 11,
    fontWeight: '600',
    lineHeight: 14,
  },
});

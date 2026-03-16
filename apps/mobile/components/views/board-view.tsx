import { View, Text, ScrollView, StyleSheet, Platform } from 'react-native';
import { useTaskStore } from '@mindwtr/core';
import type { Task, TaskStatus } from '@mindwtr/core';
import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useTheme } from '../../contexts/theme-context';
import { useLanguage } from '../../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { taskMatchesAreaFilter } from '@/lib/area-filter';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureDetector, Gesture, Swipeable } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  runOnJS,
  type SharedValue,
} from 'react-native-reanimated';
import { TaskEditModal } from '../task-edit-modal';
import { resolveBoardDropColumnIndex, resolveBoardDropColumnIndexFromY } from './board-view.utils';

const COLUMNS: { id: TaskStatus; label: string; labelKey: string; color: string }[] = [
  { id: 'inbox', label: 'Inbox', labelKey: 'status.inbox', color: '#6B7280' },
  { id: 'next', label: 'Next', labelKey: 'status.next', color: '#3B82F6' },
  { id: 'waiting', label: 'Waiting', labelKey: 'status.waiting', color: '#F59E0B' },
  { id: 'someday', label: 'Someday', labelKey: 'status.someday', color: '#8B5CF6' },
  { id: 'done', label: 'Done', labelKey: 'status.done', color: '#10B981' },
];

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
  isDark: boolean;
  currentColumnIndex: number;
  onDrop: (taskId: string, translationYDelta: number) => void;
  onDragStart: (taskId: string, columnIndex: number) => void;
  onDragMove: (absoluteY: number, translationY: number) => void;
  onDragEnd: () => void;
  onTap: (task: Task) => void;
  onDelete: (taskId: string) => void;
  onDuplicate: (task: Task) => void;
  deleteLabel: string;
  duplicateLabel: string;
  dragScrollCompensation: SharedValue<number>;
  isDragActive: boolean;
  projectTitle?: string;
  projectColor?: string;
  timeEstimatesEnabled: boolean;
  onLayout: (taskId: string, columnIndex: number, y: number, height: number) => void;
}

function DraggableTask({
  task,
  isDark,
  currentColumnIndex,
  onDrop,
  onDragStart,
  onDragMove,
  onDragEnd,
  onTap,
  onDelete,
  onDuplicate,
  deleteLabel,
  duplicateLabel,
  dragScrollCompensation,
  isDragActive,
  projectTitle,
  projectColor,
  timeEstimatesEnabled,
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

  // Tap gesture for editing
  const tapGesture = Gesture.Tap()
    .onEnd(() => {
      runOnJS(onTap)(task);
    });

  // On mobile the board columns are stacked vertically, so status drag is vertical.
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

  // Combine gestures - tap works immediately, drag requires hold
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

  const timeEstimateLabel = (() => {
    if (!timeEstimatesEnabled || !task.timeEstimate) return null;
    const estimate = String(task.timeEstimate);
    if (estimate.endsWith('min')) return estimate.replace('min', 'm');
    if (estimate.endsWith('hr+')) return estimate.replace('hr+', 'h+');
    if (estimate.endsWith('hr')) return estimate.replace('hr', 'h');
    return estimate;
  })();

  const resolvedProjectColor = projectColor || '#6B7280';
  const showMetaRow = Boolean(projectTitle) || (task.tags?.length ?? 0) > 0 || (task.contexts?.length ?? 0) > 0 || Boolean(timeEstimateLabel);

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
            <View style={styles.duplicateAction}>
              <Text style={styles.duplicateActionText}>{duplicateLabel}</Text>
            </View>
          )}
          onSwipeableLeftOpen={() => onDuplicate(task)}
          renderRightActions={() => (
            <View style={styles.deleteAction}>
              <Text style={styles.deleteActionText}>{deleteLabel}</Text>
            </View>
          )}
          onSwipeableOpen={() => onDelete(task.id)}
        >
	          <View style={[
	            styles.taskCard,
	            { backgroundColor: isDark ? '#374151' : '#FFFFFF' }
	          ]}>
	            <Text style={[styles.taskTitle, { color: isDark ? '#FFFFFF' : '#111827' }]} numberOfLines={2}>
	              {task.title}
	            </Text>
              {showMetaRow && (
                <View style={styles.contextsRow}>
                  {projectTitle && (
                    <View style={[styles.projectBadge, { backgroundColor: resolvedProjectColor + '20', borderColor: resolvedProjectColor }]}>
                      <Text style={[styles.projectBadgeText, { color: resolvedProjectColor }]} numberOfLines={1}>
                        📁 {projectTitle}
                      </Text>
                    </View>
                  )}
                  {(task.tags || []).slice(0, 6).map((tag, idx) => (
                    <Text
                      key={`${tag}-${idx}`}
                      style={[
                        styles.tagChip,
                        isDark ? styles.tagChipDark : styles.tagChipLight,
                      ]}
                    >
                      {tag}
                    </Text>
                  ))}
                  {(task.contexts || []).slice(0, 6).map((ctx, idx) => (
                    <Text
                      key={`${ctx}-${idx}`}
                      style={[
                        styles.contextTag,
                        isDark ? styles.contextTagDark : styles.contextTagLight,
                      ]}
                    >
                      {ctx}
                    </Text>
                  ))}
                  {timeEstimateLabel && (
                    <View style={styles.timeEstimateBadge}>
                      <Text style={styles.timeEstimateText}>⏱ {timeEstimateLabel}</Text>
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
  isDark: boolean;
  isDragSourceColumn: boolean;
  onDrop: (taskId: string, translationYDelta: number) => void;
  onDragStart: (taskId: string, columnIndex: number) => void;
  onDragMove: (absoluteY: number, translationY: number) => void;
  onDragEnd: () => void;
  onTap: (task: Task) => void;
  onDelete: (taskId: string) => void;
  onDuplicate: (task: Task) => void;
  noTasksLabel: string;
  deleteLabel: string;
  duplicateLabel: string;
  draggingTaskId: string | null;
  dragScrollCompensation: SharedValue<number>;
  projectById: Record<string, { title: string; color?: string }>;
  timeEstimatesEnabled: boolean;
  onColumnLayout: (columnIndex: number, y: number, height: number) => void;
  onColumnContentLayout: (columnIndex: number, y: number) => void;
  onTaskLayout: (taskId: string, columnIndex: number, y: number, height: number) => void;
}

function Column({
  columnIndex,
  label,
  color,
  tasks,
  isDark,
  isDragSourceColumn,
  onDrop,
  onDragStart,
  onDragMove,
  onDragEnd,
  onTap,
  onDelete,
  onDuplicate,
  noTasksLabel,
  deleteLabel,
  duplicateLabel,
  draggingTaskId,
  dragScrollCompensation,
  projectById,
  timeEstimatesEnabled,
  onColumnLayout,
  onColumnContentLayout,
  onTaskLayout,
}: ColumnProps) {
  return (
    <View style={[
      styles.column,
      isDragSourceColumn ? styles.columnDragSource : null,
      { borderTopColor: color, backgroundColor: isDark ? '#1F2937' : '#F3F4F6' },
    ]}
    onLayout={(event) => {
      const { y, height } = event.nativeEvent.layout;
      onColumnLayout(columnIndex, y, height);
    }}>
      <View style={[styles.columnHeader, { borderBottomColor: isDark ? '#374151' : '#E5E7EB' }]}>
        <Text style={[styles.columnTitle, { color: isDark ? '#FFFFFF' : '#111827' }]}>{label}</Text>
        <View style={[styles.badge, { backgroundColor: color }]}>
          <Text style={styles.badgeText}>{tasks.length}</Text>
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
            isDark={isDark}
            currentColumnIndex={columnIndex}
            onDrop={onDrop}
            onDragStart={onDragStart}
            onDragMove={onDragMove}
            onDragEnd={onDragEnd}
            onTap={onTap}
            onDelete={onDelete}
            onDuplicate={onDuplicate}
            deleteLabel={deleteLabel}
            duplicateLabel={duplicateLabel}
            isDragActive={draggingTaskId === task.id}
            dragScrollCompensation={dragScrollCompensation}
            projectTitle={task.projectId ? projectById[task.projectId]?.title : undefined}
            projectColor={task.projectId ? projectById[task.projectId]?.color : undefined}
            timeEstimatesEnabled={timeEstimatesEnabled}
            onLayout={onTaskLayout}
          />
        ))}
        {tasks.length === 0 && (
          <View style={styles.emptyColumn}>
            <Text style={[styles.emptyText, { color: isDark ? '#6B7280' : '#9CA3AF' }]}>
              {noTasksLabel}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

export function BoardView() {
  const { tasks, projects, areas, updateTask, deleteTask, duplicateTask } = useTaskStore();
  const { isDark } = useTheme();
  const tc = useThemeColors();
  const { t } = useLanguage();
  const timeEstimatesEnabled = useTaskStore((state) => state.settings?.features?.timeEstimates === true);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [dragSourceColumnIndex, setDragSourceColumnIndex] = useState<number | null>(null);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
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

  const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
  const { resolvedAreaFilter } = useMobileAreaFilter();
  const projectById = useMemo(() => {
    return projects.reduce((acc, project) => {
      const projectColor = project.areaId ? areaById.get(project.areaId)?.color : undefined;
      acc[project.id] = { title: project.title, color: projectColor };
      return acc;
    }, {} as Record<string, { title: string; color?: string }>);
  }, [projects, areaById]);

  // Filter active tasks and group by status
  const tasksByStatus = useMemo(() => {
    const projectMap = new Map(projects.map((project) => [project.id, project]));
    const activeTasks = tasks.filter((task) => (
      !task.deletedAt
      && task.status !== 'reference'
      && taskMatchesAreaFilter(task, resolvedAreaFilter, projectMap, areaById)
    ));
    const grouped: Record<string, Task[]> = {};
    COLUMNS.forEach(col => {
      grouped[col.id] = activeTasks.filter(t => t.status === col.id);
    });
    return grouped;
  }, [tasks, projects, resolvedAreaFilter, areaById]);

  const getTaskTopInContent = useCallback((taskId: string): number | null => {
    const taskLayout = taskLayoutsRef.current[taskId];
    if (!taskLayout) return null;
    const columnLayout = columnLayoutsRef.current[taskLayout.columnIndex];
    if (!columnLayout) return null;
    const columnContentOffset = columnContentOffsetRef.current[taskLayout.columnIndex] ?? 0;
    return columnLayout.y + columnContentOffset + taskLayout.y;
  }, []);

  const getColumnBounds = useCallback(() => {
    const bounds = COLUMNS.map((_, index) => {
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
    const currentColumnIndex = COLUMNS.findIndex((column) => column.id === currentStatus);
    if (currentColumnIndex < 0) return;

    let newColumnIndex = currentColumnIndex;
    const dragStartMetrics = dragStartMetricsRef.current;
    if (dragStartMetrics?.taskId === taskId) {
      const dragCenterY = dragStartMetrics.topY + effectiveTranslationY + (dragStartMetrics.height / 2);
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
          columnCount: COLUMNS.length,
        });
      }
    } else {
      newColumnIndex = resolveBoardDropColumnIndex({
        translationX: effectiveTranslationY,
        currentColumnIndex,
        columnCount: COLUMNS.length,
      });
    }

    if (newColumnIndex >= 0 && newColumnIndex < COLUMNS.length) {
      const newStatus = COLUMNS[newColumnIndex].id;
      updateTask(taskId, { status: newStatus });
    }
  }, [getColumnBounds, tasks, updateTask]);

  const handleTap = useCallback((task: Task) => {
    setEditingTask(task);
  }, []);

  const handleSave = useCallback((taskId: string, updates: Partial<Task>) => {
    updateTask(taskId, updates);
  }, [updateTask]);

  const handleDelete = useCallback((taskId: string) => {
    deleteTask(taskId);
  }, [deleteTask]);

  const handleDuplicate = useCallback((task: Task) => {
    duplicateTask(task.id, false);
  }, [duplicateTask]);

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
        {COLUMNS.map((col, index) => (
          <Column
            key={col.id}
            columnIndex={index}
            label={t(col.labelKey) || col.label}
            color={col.color}
            tasks={tasksByStatus[col.id] || []}
            isDark={isDark}
            isDragSourceColumn={dragSourceColumnIndex === index}
            onDrop={handleDrop}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onTap={handleTap}
            onDelete={handleDelete}
            onDuplicate={handleDuplicate}
            noTasksLabel={t('board.noTasks')}
            deleteLabel={t('board.delete')}
            duplicateLabel={t('taskEdit.duplicateTask')}
            draggingTaskId={draggingTaskId}
            dragScrollCompensation={dragScrollCompensationSv}
            projectById={projectById}
            timeEstimatesEnabled={timeEstimatesEnabled}
            onColumnLayout={handleColumnLayout}
            onColumnContentLayout={handleColumnContentLayout}
            onTaskLayout={handleTaskLayout}
          />
        ))}
      </ScrollView>

      {/* Task Edit Modal */}
      <TaskEditModal
        visible={!!editingTask}
        task={editingTask}
        onClose={() => setEditingTask(null)}
        onSave={handleSave}
        defaultTab="view"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
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
    backgroundColor: '#FFFFFF',
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
    borderBottomColor: '#E5E7EB',
  },
  columnTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  badgeText: {
    fontSize: 12,
    color: '#FFFFFF',
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
    color: '#9CA3AF',
  },
  taskCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    padding: 12,
    // marginBottom removed - handled by container for swipe support
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 3,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  taskCardContainer: {
    marginBottom: 8,
    borderRadius: 8,
    overflow: 'visible',
  },
  deleteAction: {
    backgroundColor: '#EF4444',
    justifyContent: 'center',
    alignItems: 'flex-end',
    flex: 1,
    paddingRight: 20,
    borderRadius: 8,
  },
  deleteActionText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 14,
  },
  duplicateAction: {
    backgroundColor: '#3B82F6',
    justifyContent: 'center',
    alignItems: 'flex-start',
    flex: 1,
    paddingLeft: 20,
    borderRadius: 8,
  },
  duplicateActionText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 14,
  },
  taskTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: '#111827',
  },
  contextsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 6,
  },
  projectBadge: {
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
  },
  contextTagLight: {
    color: '#1D4ED8',
    backgroundColor: '#EFF6FF',
  },
  contextTagDark: {
    color: '#93C5FD',
    backgroundColor: 'rgba(59,130,246,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.35)',
  },
  tagChip: {
    fontSize: 11,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    lineHeight: 14,
  },
  tagChipLight: {
    color: '#6D28D9',
    backgroundColor: '#F5F3FF',
  },
  tagChipDark: {
    color: '#C4B5FD',
    backgroundColor: 'rgba(139,92,246,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(139,92,246,0.35)',
  },
  timeEstimateBadge: {
    backgroundColor: '#DBEAFE',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  timeEstimateText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#1D4ED8',
    lineHeight: 14,
  },
});

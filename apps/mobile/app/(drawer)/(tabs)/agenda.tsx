import { View, Text, SectionList, Pressable, StyleSheet } from 'react-native';
import { useMemo, useState, useCallback } from 'react';

import { useTaskStore, Task, safeFormatDate, safeParseDate, isDueForReview, getChecklistProgress, type TaskStatus } from '@mindwtr/core';

import { useLanguage } from '../../../contexts/language-context';
import { useTheme } from '../../../contexts/theme-context';

import { useThemeColors, ThemeColors } from '@/hooks/use-theme-colors';


function TaskCard({ task, onPress, onToggleFocus, tc, isDark, focusedCount, projectTitle, projectColor, onUpdateTask, t }: {
  task: Task;
  onPress: () => void;
  onToggleFocus?: () => void;
  tc: ThemeColors;
  isDark: boolean;
  focusedCount?: number;
  projectTitle?: string;
  projectColor?: string;
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void;
  t: (key: string) => string;
}) {
  const [showChecklist, setShowChecklist] = useState(false);
  const getStatusColor = (status: string) => {
    const colors: Record<string, string> = {
      next: '#3B82F6',
      waiting: '#F59E0B',
      inbox: '#6B7280',
      someday: '#8B5CF6',
      done: '#10B981',
    };
    return colors[status] || '#6B7280';
  };

  const getStatusLabel = (status: string) => {
    const labels: Record<string, string> = {
      next: '▶️ Next',
      waiting: '⏸️ Waiting',
      inbox: '📥 Inbox',
      someday: '💭 Someday',
      done: '✅ Done',
    };
    return labels[status] || status;
  };

  const dueDate = safeParseDate(task.dueDate);
  const now = new Date();
  const isOverdue = dueDate && dueDate < now;
  const isDueToday = dueDate && dueDate.toDateString() === now.toDateString();
  const resolvedProjectColor = projectColor || tc.tint;
  const checklistProgress = getChecklistProgress(task);

  // Can focus if: already focused, or we have room for more
  const canFocus = task.isFocusedToday || (focusedCount !== undefined && focusedCount < 3);

  return (
    <Pressable style={[styles.taskCard, { backgroundColor: tc.cardBg }, task.isFocusedToday && styles.focusedCard]} onPress={onPress}>
      <View style={[styles.statusBar, { backgroundColor: getStatusColor(task.status) }]} />
        <View style={styles.taskContent}>
          <View style={styles.taskTitleRow}>
            <Text style={[styles.taskTitle, { color: tc.text, flex: 1 }]} numberOfLines={2}>
            {(task.isFocusedToday ? '⭐ ' : '')}{task.title}
            </Text>
            {onToggleFocus && (
              <Pressable
                onPress={(e) => { e.stopPropagation(); onToggleFocus(); }}
                style={[styles.focusButton, !canFocus && styles.focusButtonDisabled]}
              disabled={!canFocus}
            >
              <Text style={styles.focusButtonText}>
                {task.isFocusedToday ? '⭐' : '☆'}
              </Text>
            </Pressable>
          )}
        </View>

        {task.description && (
          <Text style={[styles.taskDescription, { color: tc.secondaryText }]} numberOfLines={1}>
            {task.description}
          </Text>
        )}

        {projectTitle && (
          <View style={[styles.projectBadge, { backgroundColor: `${resolvedProjectColor}20`, borderColor: resolvedProjectColor }]}>
            <Text style={[styles.projectBadgeText, { color: resolvedProjectColor }]} numberOfLines={1}>
              📁 {projectTitle}
            </Text>
          </View>
        )}

        <View style={styles.taskMeta}>
          <View style={[styles.statusBadge, { backgroundColor: getStatusColor(task.status) }]}>
            <Text style={styles.statusText}>{getStatusLabel(task.status)}</Text>
          </View>

          {task.dueDate && (
            <Text style={[
              styles.dueDate,
              isOverdue && styles.overdue,
              isDueToday && styles.dueToday,
            ]}>
              {isOverdue ? '🔴 Overdue' : isDueToday ? '🟡 Today' :
                safeFormatDate(task.dueDate, 'P')}
            </Text>
          )}
        </View>

        {checklistProgress && (
          <Pressable
            onPress={(e) => {
              e.stopPropagation();
              setShowChecklist((v) => !v);
            }}
            style={styles.checklistRow}
            accessibilityRole="button"
            accessibilityLabel={t('checklist.progress')}
          >
            <Text style={[styles.checklistText, { color: tc.secondaryText }]}>
              {checklistProgress.completed}/{checklistProgress.total}
            </Text>
            <View style={[styles.checklistBar, { backgroundColor: tc.border }]}>
              <View
                style={[
                  styles.checklistBarFill,
                  { width: `${Math.round(checklistProgress.percent * 100)}%`, backgroundColor: tc.tint }
                ]}
              />
            </View>
          </Pressable>
        )}

        {showChecklist && (task.checklist || []).length > 0 && (
          <View style={styles.checklistItems}>
            {(task.checklist || []).map((item, index) => (
              <Pressable
                key={item.id || index}
                onPress={(e) => {
                  e.stopPropagation();
                  const nextList = (task.checklist || []).map((it, i) =>
                    i === index ? { ...it, isCompleted: !it.isCompleted } : it
                  );
                  const isListMode = task.taskMode === 'list';
                  const allComplete = nextList.length > 0 && nextList.every((entry) => entry.isCompleted);
                  const nextStatus = isListMode
                    ? allComplete
                      ? 'done'
                      : task.status === 'done'
                        ? 'next'
                        : undefined
                    : undefined;
                  onUpdateTask(task.id, { checklist: nextList, ...(nextStatus ? { status: nextStatus } : {}) });
                }}
                style={styles.checklistItem}
                accessibilityRole="button"
              >
                <Text
                  style={[
                    styles.checklistItemText,
                    { color: tc.secondaryText },
                    item.isCompleted && styles.checklistItemCompleted
                  ]}
                  numberOfLines={1}
                >
                  {item.isCompleted ? '✓ ' : '○ '} {item.title}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {task.contexts && task.contexts.length > 0 && (
          <View style={styles.contextsRow}>
            {task.contexts.slice(0, 3).map((ctx, idx) => (
              <Text
                key={idx}
                style={[
                  styles.contextTag,
                  isDark ? styles.contextTagDark : styles.contextTagLight,
                ]}
              >
                {ctx}
              </Text>
            ))}
          </View>
        )}
      </View>
    </Pressable>
  );
}

export default function AgendaScreen() {
  const { tasks, projects, updateTask } = useTaskStore();

  const { t } = useLanguage();
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const { isDark } = useTheme();

  // Theme colors
  // Theme colors
  const tc = useThemeColors();

    const sections = useMemo(() => {
        const activeTasks = tasks.filter(t => t.status !== 'done' && !t.deletedAt);

        // Today's Focus: tasks marked as isFocusedToday
        const focusedTasks = activeTasks.filter(t => t.isFocusedToday);

    const overdueTasks = activeTasks.filter(t => {
      const dd = safeParseDate(t.dueDate);
      return dd && dd < new Date() && !t.isFocusedToday;
    });
    const todayTasks = activeTasks.filter(t => {
      const dd = safeParseDate(t.dueDate);
      return dd && dd.toDateString() === new Date().toDateString() &&
        !t.isFocusedToday;
    });
    const nextTasks = activeTasks.filter(t => t.status === 'next' && !t.isFocusedToday).slice(0, 5);
    const reviewDueTasks = activeTasks.filter(t =>
      (t.status === 'waiting' || t.status === 'someday') &&
      isDueForReview(t.reviewAt, new Date()) &&
      !t.isFocusedToday
    );
    const upcomingTasks = activeTasks
      .filter(t => {
        const dd = safeParseDate(t.dueDate);
        return dd && dd > new Date() && !t.isFocusedToday;
      })
      .sort((a, b) => {
        const da = safeParseDate(a.dueDate);
        const db = safeParseDate(b.dueDate);
        return (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
      })
      .slice(0, 5);

    const result = [];
    // Today's Focus always at the top (max 3)
    if (focusedTasks.length > 0) result.push({ title: `🎯 ${t('agenda.todaysFocus') || "Today's Focus"}`, data: focusedTasks.slice(0, 3) });
    if (overdueTasks.length > 0) result.push({ title: `🔴 ${t('agenda.overdue')}`, data: overdueTasks });
    if (todayTasks.length > 0) result.push({ title: `🟡 ${t('agenda.dueToday')}`, data: todayTasks });
    if (nextTasks.length > 0) result.push({ title: `▶️ ${t('agenda.nextActions')}`, data: nextTasks });
    if (reviewDueTasks.length > 0) result.push({ title: `⏰ ${t('agenda.reviewDue') || 'Review Due'}`, data: reviewDueTasks });
    if (upcomingTasks.length > 0) result.push({ title: `📆 ${t('agenda.upcoming')}`, data: upcomingTasks });

    return result;
  }, [tasks, t]);

  // Count focused tasks (max 3)
  const focusedCount = tasks.filter(t => t.isFocusedToday && !t.deletedAt && t.status !== 'done').length;

  const handleToggleFocus = useCallback((taskId: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    // If already focused, unfocus it
    if (task.isFocusedToday) {
      updateTask(taskId, { isFocusedToday: false });
    } else {
      // Only allow 3 focused tasks max
      if (focusedCount >= 3) {
        // Optionally show alert - for now just don't add
        return;
      }
      updateTask(taskId, { isFocusedToday: true });
    }
  }, [tasks, focusedCount, updateTask]);

  const listKey = useMemo(() => {
    return sections
      .map((section) => `${section.title}:${section.data.map((task) => `${task.id}-${task.updatedAt ?? ''}-${task.isFocusedToday ? '1' : '0'}`).join(',')}`)
      .join('|');
  }, [sections]);

  const handleTaskPress = useCallback((task: Task) => {
    setSelectedTask(task);
  }, []);

  const handleStatusChange = (status: TaskStatus) => {
    if (selectedTask) {
      updateTask(selectedTask.id, { status });
      setSelectedTask(null);
    }
  };

  const projectById = useMemo(() => {
    return projects.reduce<Record<string, { title: string; color: string }>>((acc, project) => {
      acc[project.id] = { title: project.title, color: project.color };
      return acc;
    }, {});
  }, [projects]);

  const renderItem = useCallback(({ item }: { item: Task }) => (
    <TaskCard
      task={item}
      onPress={() => handleTaskPress(item)}
      onToggleFocus={() => handleToggleFocus(item.id)}
      focusedCount={focusedCount}
      isDark={isDark}
      tc={tc}
      projectTitle={item.projectId ? projectById[item.projectId]?.title : undefined}
      projectColor={item.projectId ? projectById[item.projectId]?.color : undefined}
      onUpdateTask={updateTask}
      t={t}
    />
  ), [handleTaskPress, handleToggleFocus, focusedCount, isDark, tc, projectById, updateTask, t]);

  const renderSectionHeader = useCallback(({ section: { title } }: { section: { title: string } }) => (
    <View style={[styles.sectionHeaderContainer, { backgroundColor: tc.bg }]}>
      <Text style={[
        styles.sectionTitle,
        { color: tc.text },
        title.includes('Overdue') && styles.overdueTitle
      ]}>{title}</Text>
    </View>
  ), [tc]);

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      {sections.length > 0 && (
        <View style={styles.summaryRow}>
          <Text style={[styles.summaryText, { color: tc.secondaryText }]}>
            {sections.reduce((acc, sec) => acc + sec.data.length, 0)} {t('agenda.active')}
          </Text>
        </View>
      )}
      <SectionList
        key={listKey}
        sections={sections}
        keyExtractor={(item) => `${item.id}:${item.updatedAt ?? ''}:${item.isFocusedToday ? 'focus' : 'rest'}`}
        extraData={tasks}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        contentContainerStyle={styles.content}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>✨</Text>
            <Text style={[styles.emptyTitle, { color: tc.text }]}>{t('agenda.allClear')}</Text>
            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{t('agenda.noTasks')}</Text>
          </View>
        }
      />

      {/* Quick Action Modal */}
      {selectedTask && (
        <View style={styles.modal}>
          <View style={[styles.modalContent, { backgroundColor: tc.cardBg }]}>
            <Text style={[styles.modalTitle, { color: tc.text }]}>{selectedTask.title}</Text>
            <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>Update Status:</Text>
            <View style={styles.actionButtons}>
              <Pressable
                style={[styles.actionButton, styles.inboxButton]}
                onPress={() => handleStatusChange('inbox')}
              >
                <Text style={styles.actionButtonText}>📥 Inbox</Text>
              </Pressable>
              <Pressable
                style={[styles.actionButton, styles.nextButton]}
                onPress={() => handleStatusChange('next')}
              >
                <Text style={styles.actionButtonText}>▶️ Next</Text>
              </Pressable>
              <Pressable
                style={[styles.actionButton, styles.waitingButton]}
                onPress={() => handleStatusChange('waiting')}
              >
                <Text style={styles.actionButtonText}>⏸️ Waiting</Text>
              </Pressable>
              <Pressable
                style={[styles.actionButton, styles.somedayButton]}
                onPress={() => handleStatusChange('someday')}
              >
                <Text style={styles.actionButtonText}>💭 Someday</Text>
              </Pressable>
              <Pressable
                style={[styles.actionButton, styles.doneButton]}
                onPress={() => handleStatusChange('done')}
              >
                <Text style={styles.actionButtonText}>✅ Done</Text>
              </Pressable>
            </View>
            <Pressable
              style={styles.cancelButton}
              onPress={() => setSelectedTask(null)}
            >
              <Text style={[styles.cancelButtonText, { color: tc.secondaryText }]}>{t('common.cancel')}</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  content: {
    flexGrow: 1,
    paddingBottom: 24,
  },
  summaryRow: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 2,
  },
  summaryText: {
    fontSize: 13,
    fontWeight: '500',
  },
  sectionHeaderContainer: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
    backgroundColor: '#F9FAFB',
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
  },
  overdueTitle: {
    color: '#DC2626',
  },
  taskCard: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    marginBottom: 12,
    marginHorizontal: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
    overflow: 'hidden',
  },
  statusBar: {
    width: 4,
  },
  taskContent: {
    flex: 1,
    padding: 12,
  },
  taskTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 4,
  },
  taskDescription: {
    fontSize: 14,
    color: '#6B7280',
    marginBottom: 8,
  },
  projectBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    marginBottom: 8,
  },
  projectBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  taskMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusText: {
    fontSize: 11,
    color: '#FFFFFF',
    fontWeight: '600',
  },
  dueDate: {
    fontSize: 12,
    color: '#6B7280',
  },
  overdue: {
    color: '#DC2626',
    fontWeight: '600',
  },
  dueToday: {
    color: '#F59E0B',
    fontWeight: '600',
  },
  contextsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  contextTag: {
    fontSize: 11,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
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
  checklistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  checklistText: {
    fontSize: 12,
    fontWeight: '600',
  },
  checklistBar: {
    flex: 1,
    height: 6,
    borderRadius: 4,
    overflow: 'hidden',
  },
  checklistBarFill: {
    height: '100%',
    borderRadius: 4,
  },
  checklistItems: {
    gap: 6,
    marginBottom: 8,
  },
  checklistItem: {
    paddingVertical: 4,
  },
  checklistItemText: {
    fontSize: 12,
  },
  checklistItemCompleted: {
    textDecorationLine: 'line-through',
    opacity: 0.7,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 80,
  },
  emptyIcon: {
    fontSize: 64,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
  },
  modal: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 24,
    width: '85%',
    maxWidth: 400,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 16,
  },
  modalLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#6B7280',
    marginBottom: 12,
  },
  actionButtons: {
    gap: 8,
    marginBottom: 16,
  },
  actionButton: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  inboxButton: {
    backgroundColor: '#6B7280',
  },
  nextButton: {
    backgroundColor: '#3B82F6',
  },
  waitingButton: {
    backgroundColor: '#F59E0B',
  },
  somedayButton: {
    backgroundColor: '#8B5CF6',
  },
  doneButton: {
    backgroundColor: '#10B981',
  },
  actionButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  cancelButton: {
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: '#F3F4F6',
  },
  cancelButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6B7280',
  },
  // Focus-related styles
  focusedCard: {
    borderWidth: 2,
    borderColor: '#F59E0B',
    shadowColor: '#F59E0B',
    shadowOpacity: 0.3,
  },
  taskTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  focusButton: {
    padding: 8,
    marginLeft: 8,
  },
  focusButtonDisabled: {
    opacity: 0.3,
  },
  focusButtonText: {
    fontSize: 20,
  },
});

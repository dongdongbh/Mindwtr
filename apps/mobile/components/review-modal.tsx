import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Modal, TouchableOpacity, ScrollView, TextInput, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
    createAIProvider,
    getStaleItems,
    isDueForReview,
    safeFormatDate,
    safeParseDate,
    safeParseDueDate,
    type ExternalCalendarEvent,
    type ReviewSuggestion,
    type AIProviderId,
    type Task,
    type TaskStatus,
    useTaskStore,
} from '@mindwtr/core';
import { useTheme } from '../contexts/theme-context';
import { useLanguage } from '../contexts/language-context';
import { useQuickCapture } from '../contexts/quick-capture-context';

import { SwipeableTaskItem } from './swipeable-task-item';
import { TaskEditModal } from './task-edit-modal';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import {
    X,
    Inbox,
    Sparkles,
    Calendar as CalendarIcon,
    Clock,
    Tag,
    FolderOpen,
    Lightbulb,
    CheckCircle2,
    PartyPopper,
    type LucideIcon,
} from 'lucide-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { buildAIConfig, isAIKeyRequired, loadAIKey } from '../lib/ai-config';
import { logError } from '../lib/app-log';
import { fetchExternalCalendarEvents } from '../lib/external-calendar';
import { getReviewLabels } from './review-modal.labels';
import { styles } from './review-modal.styles';

type ReviewStep = 'inbox' | 'ai' | 'calendar' | 'waiting' | 'contexts' | 'projects' | 'someday' | 'completed';
type ExternalCalendarDaySummary = {
    dayStart: Date;
    events: ExternalCalendarEvent[];
    totalCount: number;
};
type ContextReviewGroup = {
    context: string;
    tasks: Task[];
};
type CalendarTaskReviewEntry = {
    task: Task;
    date: Date;
    kind: 'due' | 'start';
};

interface ReviewModalProps {
    visible: boolean;
    onClose: () => void;
}

// Helper to check review time (kept for backward compatibility)
export const checkReviewTime = () => {
    return true;
};

export function ReviewModal({ visible, onClose }: ReviewModalProps) {
    const { tasks, projects, areas, updateTask, deleteTask, settings, batchUpdateTasks, addTask } = useTaskStore();
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const { isDark } = useTheme();
    const { language } = useLanguage();
    const { openQuickCapture } = useQuickCapture();
    const [currentStep, setCurrentStep] = useState<ReviewStep>('inbox');
    const [editingTask, setEditingTask] = useState<Task | null>(null);
    const [showEditModal, setShowEditModal] = useState(false);
    const [expandedProject, setExpandedProject] = useState<string | null>(null);
    const [aiSuggestions, setAiSuggestions] = useState<ReviewSuggestion[]>([]);
    const [aiSelectedIds, setAiSelectedIds] = useState<Set<string>>(new Set());
    const [aiLoading, setAiLoading] = useState(false);
    const [aiError, setAiError] = useState<string | null>(null);
    const [aiRan, setAiRan] = useState(false);
    const [externalCalendarEvents, setExternalCalendarEvents] = useState<ExternalCalendarEvent[]>([]);
    const [externalCalendarLoading, setExternalCalendarLoading] = useState(false);
    const [externalCalendarError, setExternalCalendarError] = useState<string | null>(null);
    const [expandedExternalDays, setExpandedExternalDays] = useState<Set<string>>(new Set());
    const [expandedContextGroups, setExpandedContextGroups] = useState<Set<string>>(new Set());
    const [projectTaskPrompt, setProjectTaskPrompt] = useState<{ projectId: string; projectTitle: string } | null>(null);
    const [projectTaskTitle, setProjectTaskTitle] = useState('');

    const labels = getReviewLabels(language);
    const tc = useThemeColors();
    const aiEnabled = settings?.ai?.enabled === true;
    const includeContextStep = settings?.gtd?.weeklyReview?.includeContextStep !== false;
    const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;

    const steps = useMemo<{ id: ReviewStep; title: string; Icon: LucideIcon }[]>(() => {
        const list: { id: ReviewStep; title: string; Icon: LucideIcon }[] = [
            { id: 'inbox', title: labels.inbox, Icon: Inbox },
        ];
        if (aiEnabled) {
            list.push({ id: 'ai', title: labels.ai, Icon: Sparkles });
        }
        list.push(
            { id: 'calendar', title: labels.calendar, Icon: CalendarIcon },
            { id: 'waiting', title: labels.waiting, Icon: Clock },
        );
        if (includeContextStep) {
            list.push({ id: 'contexts', title: labels.contexts, Icon: Tag });
        }
        list.push(
            { id: 'projects', title: labels.projects, Icon: FolderOpen },
            { id: 'someday', title: labels.someday, Icon: Lightbulb },
            { id: 'completed', title: labels.done, Icon: CheckCircle2 },
        );
        return list;
    }, [aiEnabled, includeContextStep, labels]);

    const currentStepIndex = steps.findIndex(s => s.id === currentStep);
    const safeStepIndex = currentStepIndex >= 0 ? currentStepIndex : 0;
    const progress = (safeStepIndex / Math.max(1, steps.length - 1)) * 100;

    const nextStep = () => {
        if (currentStepIndex < 0) {
            setCurrentStep(steps[0].id);
            return;
        }
        if (currentStepIndex < steps.length - 1) {
            setCurrentStep(steps[currentStepIndex + 1].id);
        }
    };

    const prevStep = () => {
        if (currentStepIndex < 0) {
            setCurrentStep(steps[0].id);
            return;
        }
        if (currentStepIndex > 0) {
            setCurrentStep(steps[currentStepIndex - 1].id);
        }
    };

    const handleClose = () => {
        setCurrentStep('inbox');
        setExpandedExternalDays(new Set());
        setExpandedContextGroups(new Set());
        onClose();
    };

    const handleTaskPress = (task: Task) => {
        setEditingTask(task);
        setShowEditModal(true);
    };

    const handleStatusChange = (taskId: string, status: string) => {
        updateTask(taskId, { status: status as TaskStatus });
    };

    const handleDelete = (taskId: string) => {
        deleteTask(taskId);
    };

    const openReviewQuickAdd = (initialProps?: Partial<Task>) => {
        openQuickCapture({ initialProps });
    };

    const openProjectTaskPrompt = (projectId: string, projectTitle: string) => {
        setProjectTaskPrompt({ projectId, projectTitle });
        setProjectTaskTitle('');
    };

    const closeProjectTaskPrompt = () => {
        setProjectTaskPrompt(null);
        setProjectTaskTitle('');
    };

    const submitProjectTask = async () => {
        const title = projectTaskTitle.trim();
        const targetProject = projectTaskPrompt;
        if (!title || !targetProject) return;
        try {
            await addTask(title, { projectId: targetProject.projectId, status: 'next' });
            closeProjectTaskPrompt();
        } catch (error) {
            void logError(error, {
                scope: 'review',
                extra: { message: 'Failed to add task from project review', projectId: targetProject.projectId },
            });
        }
    };

    const toggleExternalDayExpanded = (dayKey: string) => {
        setExpandedExternalDays((prev) => {
            const next = new Set(prev);
            if (next.has(dayKey)) {
                next.delete(dayKey);
            } else {
                next.add(dayKey);
            }
            return next;
        });
    };

    const toggleContextGroupExpanded = (contextKey: string) => {
        setExpandedContextGroups((prev) => {
            const next = new Set(prev);
            if (next.has(contextKey)) {
                next.delete(contextKey);
            } else {
                next.add(contextKey);
            }
            return next;
        });
    };

    useEffect(() => {
        if (!visible) return;
        let cancelled = false;
        const loadCalendar = async () => {
            setExternalCalendarLoading(true);
            setExternalCalendarError(null);
            try {
                const now = new Date();
                const rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                const rangeEnd = new Date(rangeStart);
                rangeEnd.setDate(rangeEnd.getDate() + 7);
                rangeEnd.setMilliseconds(-1);
                const { events } = await fetchExternalCalendarEvents(rangeStart, rangeEnd);
                if (cancelled) return;
                setExternalCalendarEvents(events);
            } catch (error) {
                if (cancelled) return;
                setExternalCalendarError(error instanceof Error ? error.message : String(error));
                setExternalCalendarEvents([]);
            } finally {
                if (!cancelled) setExternalCalendarLoading(false);
            }
        };
        loadCalendar();
        return () => {
            cancelled = true;
        };
    }, [visible]);

    const handleFinish = async () => {
        try {
            await AsyncStorage.setItem('lastWeeklyReview', new Date().toISOString());
        } catch (e) {
            void logError(e, { scope: 'review', extra: { message: 'Failed to save review time' } });
        }
        handleClose();
    };

    const staleItems = getStaleItems(tasks, projects);
    const staleItemTitleMap = staleItems.reduce((acc, item) => {
        acc[item.id] = item.title;
        return acc;
    }, {} as Record<string, string>);

    useEffect(() => {
        if (!steps.some((step) => step.id === currentStep)) {
            setCurrentStep(steps[0].id);
        }
    }, [currentStep, steps]);

    const isActionableSuggestion = (suggestion: ReviewSuggestion) => {
        if (suggestion.id.startsWith('project:')) return false;
        return suggestion.action === 'someday' || suggestion.action === 'archive';
    };

    const toggleSuggestion = (id: string) => {
        setAiSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    const runAiAnalysis = async () => {
        setAiError(null);
        setAiRan(true);
        if (!aiEnabled) {
            setAiError('AI is disabled. Enable it in Settings.');
            return;
        }
        const apiKey = await loadAIKey(aiProvider);
        if (isAIKeyRequired(settings) && !apiKey) {
            setAiError('Missing API key. Add it in Settings.');
            return;
        }
        if (staleItems.length === 0) {
            setAiSuggestions([]);
            setAiSelectedIds(new Set());
            return;
        }
        setAiLoading(true);
        try {
            const provider = createAIProvider(buildAIConfig(settings, apiKey));
            const response = await provider.analyzeReview({ items: staleItems });
            const suggestions = response.suggestions || [];
            setAiSuggestions(suggestions);
            const defaultSelected = new Set(
                suggestions.filter(isActionableSuggestion).map((suggestion) => suggestion.id),
            );
            setAiSelectedIds(defaultSelected);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setAiError(message || 'AI request failed.');
        } finally {
            setAiLoading(false);
        }
    };

    const applyAiSuggestions = async () => {
        const updates = aiSuggestions
            .filter((suggestion) => aiSelectedIds.has(suggestion.id))
            .filter(isActionableSuggestion)
            .map((suggestion) => {
                if (suggestion.action === 'someday') {
                    return { id: suggestion.id, updates: { status: 'someday' as TaskStatus } };
                }
                if (suggestion.action === 'archive') {
                    return { id: suggestion.id, updates: { status: 'archived' as TaskStatus, completedAt: new Date().toISOString() } };
                }
                return null;
            })
            .filter(Boolean) as { id: string; updates: Partial<Task> }[];

        if (updates.length === 0) return;
        await batchUpdateTasks(updates);
    };

    const inboxTasks = tasks.filter(t => t.status === 'inbox' && !t.deletedAt);
    const waitingTasks = tasks.filter(t => t.status === 'waiting' && !t.deletedAt);
    const somedayTasks = tasks.filter(t => t.status === 'someday' && !t.deletedAt);
    const waitingDue = waitingTasks.filter(t => isDueForReview(t.reviewAt));
    const waitingFuture = waitingTasks.filter(t => !isDueForReview(t.reviewAt));
    const orderedWaitingTasks = [...waitingDue, ...waitingFuture];
    const somedayDue = somedayTasks.filter(t => isDueForReview(t.reviewAt));
    const somedayFuture = somedayTasks.filter(t => !isDueForReview(t.reviewAt));
    const orderedSomedayTasks = [...somedayDue, ...somedayFuture];
    const activeProjects = projects.filter(p => p.status === 'active');
    const dueProjects = activeProjects.filter(p => isDueForReview(p.reviewAt));
    const futureProjects = activeProjects.filter(p => !isDueForReview(p.reviewAt));
    const orderedProjects = [...dueProjects, ...futureProjects];
    const calendarReviewItems = useMemo<CalendarTaskReviewEntry[]>(() => {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const upcomingEnd = new Date(startOfToday);
        upcomingEnd.setDate(upcomingEnd.getDate() + 7);
        const entries: CalendarTaskReviewEntry[] = [];

        tasks.forEach((task) => {
            if (task.deletedAt) return;
            if (task.status === 'done' || task.status === 'archived' || task.status === 'reference') return;
            const dueDate = safeParseDueDate(task.dueDate);
            if (dueDate) entries.push({ task, date: dueDate, kind: 'due' });
            const startTime = safeParseDate(task.startTime);
            if (startTime) entries.push({ task, date: startTime, kind: 'start' });
        });

        return entries
            .filter((entry) => entry.date >= startOfToday && entry.date < upcomingEnd)
            .sort((a, b) => a.date.getTime() - b.date.getTime());
    }, [tasks]);

    const externalCalendarReviewItems = useMemo<ExternalCalendarDaySummary[]>(() => {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const summaries: ExternalCalendarDaySummary[] = [];
        for (let offset = 0; offset < 7; offset += 1) {
            const dayStart = new Date(startOfToday);
            dayStart.setDate(dayStart.getDate() + offset);
            const dayEnd = new Date(dayStart);
            dayEnd.setDate(dayEnd.getDate() + 1);
            const dayEvents = externalCalendarEvents
                .filter((event) => {
                    const start = safeParseDate(event.start);
                    const end = safeParseDate(event.end);
                    if (!start || !end) return false;
                    return start.getTime() < dayEnd.getTime() && end.getTime() > dayStart.getTime();
                })
                .sort((a, b) => {
                    const aStart = safeParseDate(a.start)?.getTime() ?? Number.POSITIVE_INFINITY;
                    const bStart = safeParseDate(b.start)?.getTime() ?? Number.POSITIVE_INFINITY;
                    return aStart - bStart;
                });
            if (dayEvents.length > 0) {
                summaries.push({
                    dayStart,
                    events: dayEvents,
                    totalCount: dayEvents.length,
                });
            }
        }
        return summaries;
    }, [externalCalendarEvents]);
    const contextReviewGroups = useMemo<ContextReviewGroup[]>(() => {
        const groups = new Map<string, Task[]>();
        tasks.forEach((task) => {
            if (task.deletedAt) return;
            if (task.status === 'done' || task.status === 'archived' || task.status === 'reference') return;
            (task.contexts ?? []).forEach((contextValue) => {
                const normalized = contextValue.trim();
                if (!normalized) return;
                const existing = groups.get(normalized) ?? [];
                existing.push(task);
                groups.set(normalized, existing);
            });
        });
        return Array.from(groups.entries())
            .map(([context, contextTasks]) => ({
                context,
                tasks: contextTasks.sort((a, b) => a.title.localeCompare(b.title)),
            }))
            .sort((a, b) => (b.tasks.length - a.tasks.length) || a.context.localeCompare(b.context));
    }, [tasks]);
    const handleNavigateToProject = (projectId: string) => {
        onClose();
        openProjectScreen(projectId);
    };
    const handleNavigateToToken = (token: string) => {
        onClose();
        openContextsScreen(token);
    };

    const renderTaskList = (taskList: Task[]) => (
        <ScrollView style={styles.taskList}>
            {taskList.map(task => (
                <SwipeableTaskItem
                    key={task.id}
                    task={task}
                    isDark={isDark}
                    tc={tc}
                    onPress={() => handleTaskPress(task)}
                    onStatusChange={(status) => handleStatusChange(task.id, status)}
                    onDelete={() => handleDelete(task.id)}
                    onProjectPress={handleNavigateToProject}
                    onContextPress={handleNavigateToToken}
                    onTagPress={handleNavigateToToken}
                />
            ))}
        </ScrollView>
    );

    const renderExternalCalendarList = (days: ExternalCalendarDaySummary[]) => {
        if (externalCalendarLoading) {
            return (
                <View style={styles.loadingRow}>
                    <ActivityIndicator size="small" color={tc.tint} />
                    <Text style={[styles.calendarEventMeta, { color: tc.secondaryText }]}>{labels.loading}</Text>
                </View>
            );
        }
        if (externalCalendarError) {
            return <Text style={[styles.calendarEventMeta, { color: tc.secondaryText }]}>{externalCalendarError}</Text>;
        }
        if (days.length === 0) {
            return <Text style={[styles.calendarEventMeta, { color: tc.secondaryText }]}>{labels.calendarEmpty}</Text>;
        }
        return (
            <View style={styles.calendarEventList}>
                {days.map((day) => (
                    <View key={day.dayStart.toISOString()} style={[styles.calendarDayCard, { borderColor: tc.border }]}>
                        {(() => {
                            const dayKey = day.dayStart.toISOString();
                            const isExpanded = expandedExternalDays.has(dayKey);
                            const visibleEvents = isExpanded ? day.events : day.events.slice(0, 2);
                            return (
                                <>
                        <Text style={[styles.calendarDayTitle, { color: tc.secondaryText }]}>
                            {safeFormatDate(day.dayStart, 'EEEE, PP')} · {day.totalCount}
                        </Text>
                        {visibleEvents.map((event) => {
                            const start = safeParseDate(event.start);
                            const timeLabel = event.allDay || !start ? labels.allDay : safeFormatDate(start, 'p');
                            return (
                                <View key={`${event.sourceId}-${event.id}-${event.start}`} style={styles.calendarEventRow}>
                                    <Text style={[styles.calendarEventMeta, { color: tc.secondaryText }]}>
                                        {timeLabel}
                                    </Text>
                                    <Text style={[styles.calendarEventTitle, { color: tc.text }]} numberOfLines={1}>
                                        {event.title}
                                    </Text>
                                </View>
                            );
                        })}
                        {day.totalCount > 2 && (
                            <TouchableOpacity onPress={() => toggleExternalDayExpanded(dayKey)}>
                                <Text style={[styles.calendarEventMeta, styles.calendarToggleText, { color: tc.secondaryText }]}>
                                    {isExpanded
                                        ? labels.less
                                        : `+${day.totalCount - visibleEvents.length} ${labels.more}`}
                                </Text>
                            </TouchableOpacity>
                        )}
                                </>
                            );
                        })()}
                    </View>
                ))}
            </View>
        );
    };
    const renderCalendarTaskList = (items: CalendarTaskReviewEntry[]) => {
        if (items.length === 0) {
            return <Text style={[styles.calendarEventMeta, { color: tc.secondaryText }]}>{labels.calendarTasksEmpty}</Text>;
        }
        return (
            <View style={styles.calendarEventList}>
                {items.slice(0, 12).map((entry) => (
                    <View
                        key={`${entry.kind}-${entry.task.id}-${entry.date.toISOString()}`}
                        style={[styles.calendarDayCard, { borderColor: tc.border }]}
                    >
                        <Text style={[styles.calendarEventTitle, { color: tc.text }]} numberOfLines={1}>
                            {entry.task.title}
                        </Text>
                        <Text style={[styles.calendarEventMeta, { color: tc.secondaryText }]}>
                            {(entry.kind === 'due' ? labels.dueLabel : labels.startLabel)} · {safeFormatDate(entry.date, 'Pp')}
                        </Text>
                    </View>
                ))}
            </View>
        );
    };

    const renderStepContent = () => {
        switch (currentStep) {
            case 'inbox':
                return (
                    <View style={styles.stepContent}>
                        <View style={styles.stepTitleRow}>
                            <Inbox size={22} color={tc.text} strokeWidth={2} />
                            <Text style={[styles.stepTitleInline, { color: tc.text }]}>
                                {labels.inboxDesc}
                            </Text>
                        </View>
                        <View style={[styles.infoBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            <Text style={[styles.infoText, { color: tc.text }]}>
                                <Text style={{ fontWeight: '700' }}>{inboxTasks.length}</Text> {labels.itemsInInbox}
                            </Text>
                            <Text style={[styles.guideText, { color: tc.secondaryText }]}>
                                {labels.inboxGuide}
                            </Text>
                        </View>
                        {inboxTasks.length === 0 ? (
                            <View style={styles.emptyState}>
                                <CheckCircle2 size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
                                <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                                    {labels.inboxEmpty}
                                </Text>
                            </View>
                        ) : (
                            renderTaskList(inboxTasks)
                        )}
                    </View>
                );

            case 'ai':
                return (
                    <View style={styles.stepContent}>
                        <View style={styles.stepTitleRow}>
                            <Sparkles size={22} color={tc.text} strokeWidth={2} />
                            <Text style={[styles.stepTitleInline, { color: tc.text }]}>
                                {labels.ai}
                            </Text>
                        </View>
                        <Text style={[styles.hint, { color: tc.secondaryText }]}>
                            {labels.aiDesc}
                        </Text>
                        <TouchableOpacity
                            style={[styles.primaryButton, { backgroundColor: tc.tint, marginTop: 12 }]}
                            onPress={runAiAnalysis}
                            disabled={aiLoading}
                        >
                            <Text style={styles.primaryButtonText}>
                                {aiLoading ? labels.aiRunning : labels.aiRun}
                            </Text>
                        </TouchableOpacity>

                        {aiError && (
                            <Text style={[styles.hint, { color: '#EF4444', marginTop: 12 }]}>
                                {aiError}
                            </Text>
                        )}

                        {aiRan && !aiLoading && aiSuggestions.length === 0 && !aiError && (
                            <Text style={[styles.hint, { color: tc.secondaryText, marginTop: 12 }]}>
                                {labels.aiEmpty}
                            </Text>
                        )}

                        {aiSuggestions.length > 0 && (
                            <ScrollView style={styles.taskList}>
                                {aiSuggestions.map((suggestion) => {
                                    const actionable = isActionableSuggestion(suggestion);
                                    const label = suggestion.action === 'someday'
                                        ? labels.aiActionSomeday
                                        : suggestion.action === 'archive'
                                            ? labels.aiActionArchive
                                            : suggestion.action === 'breakdown'
                                                ? labels.aiActionBreakdown
                                                : labels.aiActionKeep;
                                    return (
                                        <TouchableOpacity
                                            key={suggestion.id}
                                            style={[styles.aiItemRow, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                            onPress={() => actionable && toggleSuggestion(suggestion.id)}
                                            disabled={!actionable}
                                        >
                                            <View
                                                style={[
                                                    styles.aiCheckbox,
                                                    {
                                                        borderColor: tc.border,
                                                        backgroundColor: aiSelectedIds.has(suggestion.id) ? tc.tint : 'transparent',
                                                    },
                                                ]}
                                            >
                                                {aiSelectedIds.has(suggestion.id) && <Text style={styles.aiCheckboxText}>✓</Text>}
                                            </View>
                                            <View style={{ flex: 1 }}>
                                                <Text style={[styles.aiItemTitle, { color: tc.text }]}>
                                                    {staleItemTitleMap[suggestion.id] || suggestion.id}
                                                </Text>
                                                <Text style={[styles.aiItemMeta, { color: tc.secondaryText }]}>
                                                    {label} · {suggestion.reason}
                                                </Text>
                                            </View>
                                        </TouchableOpacity>
                                    );
                                })}
                                <TouchableOpacity
                                    style={[styles.primaryButton, { backgroundColor: tc.tint, marginTop: 12 }]}
                                    onPress={applyAiSuggestions}
                                    disabled={aiSelectedIds.size === 0}
                                >
                                    <Text style={styles.primaryButtonText}>
                                        {labels.aiApply} ({aiSelectedIds.size})
                                    </Text>
                                </TouchableOpacity>
                            </ScrollView>
                        )}
                    </View>
                );

            case 'calendar':
                return (
                    <ScrollView
                        style={styles.stepContent}
                        contentContainerStyle={styles.calendarStepContent}
                        showsVerticalScrollIndicator
                    >
                        <View style={styles.stepTitleRow}>
                            <CalendarIcon size={22} color={tc.text} strokeWidth={2} />
                            <Text style={[styles.stepTitleInline, { color: tc.text }]}>
                                {labels.calendar}
                            </Text>
                        </View>
                        <TouchableOpacity
                            style={[styles.reviewAddTaskButton, { borderColor: tc.border }]}
                            onPress={() => openReviewQuickAdd({ status: 'inbox' })}
                        >
                            <Text style={[styles.reviewAddTaskButtonText, { color: tc.text }]}>{labels.addTask}</Text>
                        </TouchableOpacity>
                        <Text style={[styles.hint, { color: tc.secondaryText }]}>
                            {labels.calendarDesc}
                        </Text>
                        <View style={[styles.calendarColumn, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            <Text style={[styles.calendarColumnTitle, { color: tc.secondaryText }]}>{labels.calendarUpcoming}</Text>
                            {renderExternalCalendarList(externalCalendarReviewItems)}
                        </View>
                        <View style={[styles.calendarColumn, { backgroundColor: tc.cardBg, borderColor: tc.border, marginTop: 12 }]}>
                            <Text style={[styles.calendarColumnTitle, { color: tc.secondaryText }]}>{labels.calendarTasks}</Text>
                            {renderCalendarTaskList(calendarReviewItems)}
                        </View>
                    </ScrollView>
                );

            case 'waiting':
                return (
                    <View style={styles.stepContent}>
                        <View style={styles.stepTitleRow}>
                            <Clock size={22} color={tc.text} strokeWidth={2} />
                            <Text style={[styles.stepTitleInline, { color: tc.text }]}>
                                {labels.waitingDesc}
                            </Text>
                        </View>
                        <Text style={[styles.hint, { color: tc.secondaryText }]}>
                            {labels.waitingGuide}
                        </Text>
                        {waitingTasks.length === 0 ? (
                            <View style={styles.emptyState}>
                                <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                                    {labels.nothingWaiting}
                                </Text>
                            </View>
                        ) : (
                            renderTaskList(orderedWaitingTasks)
                        )}
                    </View>
                );

            case 'contexts':
                return (
                    <View style={styles.stepContent}>
                        <View style={styles.stepTitleRow}>
                            <Tag size={22} color={tc.text} strokeWidth={2} />
                            <Text style={[styles.stepTitleInline, { color: tc.text }]}>
                                {labels.contexts}
                            </Text>
                        </View>
                        <Text style={[styles.hint, { color: tc.secondaryText }]}>
                            {labels.contextsDesc}
                        </Text>
                        {contextReviewGroups.length === 0 ? (
                            <View style={styles.emptyState}>
                                <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                                    {labels.contextsEmpty}
                                </Text>
                            </View>
                        ) : (
                            <ScrollView style={styles.taskList}>
                                {contextReviewGroups.map((group) => (
                                    <View key={group.context} style={[styles.contextGroupCard, { borderColor: tc.border, backgroundColor: tc.cardBg }]}>
                                        <View style={styles.contextGroupHeader}>
                                            <Text style={[styles.contextGroupTitle, { color: tc.text }]}>{group.context}</Text>
                                            <Text style={[styles.contextGroupCount, { color: tc.secondaryText }]}>{group.tasks.length}</Text>
                                        </View>
                                        {(() => {
                                            const contextKey = group.context;
                                            const isExpanded = expandedContextGroups.has(contextKey);
                                            const visibleTasks = isExpanded ? group.tasks : group.tasks.slice(0, 4);
                                            return (
                                                <>
                                                    {visibleTasks.map((task) => (
                                                        <TouchableOpacity
                                                            key={`${group.context}-${task.id}`}
                                                            style={[styles.contextTaskRow, { borderTopColor: tc.border }]}
                                                            onPress={() => handleTaskPress(task)}
                                                        >
                                                            <Text style={[styles.contextTaskTitle, { color: tc.text }]} numberOfLines={1}>
                                                                {task.title}
                                                            </Text>
                                                        </TouchableOpacity>
                                                    ))}
                                                    {group.tasks.length > 4 && (
                                                        <TouchableOpacity onPress={() => toggleContextGroupExpanded(contextKey)}>
                                                            <Text style={[styles.contextMoreText, { color: tc.secondaryText }]}>
                                                                {isExpanded
                                                                    ? labels.less
                                                                    : `+${group.tasks.length - visibleTasks.length} ${labels.more}`}
                                                            </Text>
                                                        </TouchableOpacity>
                                                    )}
                                                </>
                                            );
                                        })()}
                                    </View>
                                ))}
                            </ScrollView>
                        )}
                    </View>
                );

            case 'projects':
                return (
                    <View style={styles.stepContent}>
                        <View style={styles.stepTitleRow}>
                            <FolderOpen size={22} color={tc.text} strokeWidth={2} />
                            <Text style={[styles.stepTitleInline, { color: tc.text }]}>
                                {labels.projectsDesc}
                            </Text>
                        </View>
                        <Text style={[styles.hint, { color: tc.secondaryText }]}>
                            {labels.projectsGuide}
                        </Text>
                        {activeProjects.length === 0 ? (
                            <View style={styles.emptyState}>
                                <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                                    {labels.noActiveProjects}
                                </Text>
                            </View>
                        ) : (
                            <ScrollView style={styles.taskList}>
	                                {orderedProjects.map(project => {
                                    const projectTasks = tasks.filter(task => task.projectId === project.id && task.status !== 'done' && task.status !== 'reference' && !task.deletedAt);
                                    // A project has a next action if it has at least one task marked 'next'.
                                    const hasNextAction = projectTasks.some(task => task.status === 'next');
                                    const isExpanded = expandedProject === project.id;

                                    return (
                                        <View key={project.id}>
                                            <TouchableOpacity
                                                style={[styles.projectItem, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                                onPress={() => setExpandedProject(isExpanded ? null : project.id)}
                                            >
                                                <View style={styles.projectHeader}>
                                                    <View style={[styles.projectDot, { backgroundColor: (project.areaId ? areaById.get(project.areaId)?.color : undefined) || tc.tint }]} />
                                                    <Text style={[styles.projectTitle, { color: tc.text }]}>{project.title}</Text>
                                                    <TouchableOpacity
                                                        style={[styles.reviewProjectAddTaskButton, { borderColor: tc.border }]}
                                                        onPress={(event) => {
                                                            event.stopPropagation();
                                                            openProjectTaskPrompt(project.id, project.title);
                                                        }}
                                                    >
                                                        <Text style={[styles.reviewProjectAddTaskButtonText, { color: tc.text }]}>
                                                            {labels.addTask}
                                                        </Text>
                                                    </TouchableOpacity>
                                                    <View style={[styles.statusBadge, { backgroundColor: hasNextAction ? '#10B98120' : '#EF444420' }]}>
                                                        <Text style={[styles.statusText, { color: hasNextAction ? '#10B981' : '#EF4444' }]}>
                                                            {hasNextAction ? labels.hasNext : labels.needsAction}
                                                        </Text>
                                                    </View>
                                                </View>
                                                <View style={styles.projectMeta}>
                                                    <Text style={[styles.taskCount, { color: tc.secondaryText }]}>
                                                        {projectTasks.length} {labels.activeTasks}
                                                    </Text>
                                                    <Text style={[styles.expandIcon, { color: tc.secondaryText }]}>
                                                        {isExpanded ? '▼' : '▶'}
                                                    </Text>
                                                </View>
                                            </TouchableOpacity>
                                            {isExpanded && projectTasks.length > 0 && (
                                                <View style={styles.projectTasks}>
                                                    {projectTasks.map(task => (
                                                        <SwipeableTaskItem
                                                            key={task.id}
                                                            task={task}
                                                            isDark={isDark}
                                                            tc={tc}
                                                            onPress={() => handleTaskPress(task)}
                                                            onStatusChange={(status) => handleStatusChange(task.id, status)}
                                                            onDelete={() => handleDelete(task.id)}
                                                            onProjectPress={handleNavigateToProject}
                                                            onContextPress={handleNavigateToToken}
                                                            onTagPress={handleNavigateToToken}
                                                        />
                                                    ))}
                                                </View>
                                            )}
                                        </View>
                                    );
                                })}
                            </ScrollView>
                        )}
                    </View>
                );

            case 'someday':
                return (
                    <View style={styles.stepContent}>
                        <View style={styles.stepTitleRow}>
                            <Lightbulb size={22} color={tc.text} strokeWidth={2} />
                            <Text style={[styles.stepTitleInline, { color: tc.text }]}>
                                {labels.somedayDesc}
                            </Text>
                        </View>
                        <Text style={[styles.hint, { color: tc.secondaryText }]}>
                            {labels.somedayGuide}
                        </Text>
                        {somedayTasks.length === 0 ? (
                            <View style={styles.emptyState}>
                                <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                                    {labels.listEmpty}
                                </Text>
                            </View>
                        ) : (
                            renderTaskList(orderedSomedayTasks)
                        )}
                    </View>
                );

            case 'completed':
                return (
                    <View style={styles.centerContent}>
                        <PartyPopper size={64} color={tc.tint} strokeWidth={1.5} style={styles.bigIcon} />
                        <Text style={[styles.heading, { color: tc.text }]}>
                            {labels.reviewComplete}
                        </Text>
                        <Text style={[styles.description, { color: tc.secondaryText }]}>
                            {labels.completeDesc}
                        </Text>
                        <TouchableOpacity style={styles.primaryButton} onPress={handleFinish}>
                            <Text style={styles.primaryButtonText}>
                                {labels.finish}
                            </Text>
                        </TouchableOpacity>
                    </View>
                );
        }
    };

    return (
        <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal onRequestClose={handleClose}>
            <GestureHandlerRootView style={{ flex: 1 }}>
                <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['top', 'bottom']}>
                    {/* Header */}
                    <View style={[styles.header, { borderBottomColor: tc.border }]}>
                        <TouchableOpacity
                            onPress={handleClose}
                            style={styles.closeButton}
                            accessibilityRole="button"
                            accessibilityLabel="Close"
                            hitSlop={8}
                        >
                            <X size={22} color={tc.text} strokeWidth={2} />
                        </TouchableOpacity>
                        <View style={styles.headerTitleRow}>
                            {(() => {
                                const HeaderIcon = steps[safeStepIndex].Icon;
                                return <HeaderIcon size={18} color={tc.text} strokeWidth={2} />;
                            })()}
                            <Text style={[styles.headerTitle, { color: tc.text }]}>
                                {steps[safeStepIndex].title}
                            </Text>
                        </View>
                        <Text style={[styles.stepIndicator, { color: tc.secondaryText }]}>
                            {safeStepIndex + 1}/{steps.length}
                        </Text>
                    </View>

                    {/* Progress bar */}
                    <View style={[styles.progressContainer, { backgroundColor: tc.border }]}>
                        <View style={[styles.progressBar, { width: `${progress}%` }]} />
                    </View>

                    {/* Content */}
                    <View style={styles.content}>
                        {renderStepContent()}
                    </View>

                    {/* Navigation */}
                    {currentStep !== 'completed' && (
                        <View style={[styles.footer, { borderTopColor: tc.border }]}>
                            <TouchableOpacity style={styles.backButton} onPress={prevStep}>
                                <Text style={[styles.backButtonText, { color: tc.secondaryText }]}>← {labels.back}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.primaryButton} onPress={nextStep}>
                                <Text style={styles.primaryButtonText}>{labels.next} →</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                </SafeAreaView>

                {/* Task Edit Modal */}
                <TaskEditModal
                    visible={showEditModal}
                    task={editingTask}
                    onClose={() => setShowEditModal(false)}
                    onSave={(taskId, updates) => updateTask(taskId, updates)}
                    defaultTab="view"
                    onProjectNavigate={handleNavigateToProject}
                    onContextNavigate={handleNavigateToToken}
                    onTagNavigate={handleNavigateToToken}
                />

                <Modal
                    visible={Boolean(projectTaskPrompt)}
                    transparent
                    animationType="fade"
                    onRequestClose={closeProjectTaskPrompt}
                >
                    <View style={styles.promptBackdrop}>
                        <View style={[styles.promptCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            <Text style={[styles.promptTitle, { color: tc.text }]}>{labels.addTask}</Text>
                            <Text style={[styles.promptProject, { color: tc.secondaryText }]}>
                                {projectTaskPrompt?.projectTitle}
                            </Text>
                            <TextInput
                                value={projectTaskTitle}
                                onChangeText={setProjectTaskTitle}
                                placeholder={labels.addTaskPlaceholder}
                                placeholderTextColor={tc.secondaryText}
                                autoFocus
                                style={[styles.promptInput, { color: tc.text, borderColor: tc.border, backgroundColor: tc.bg }]}
                                returnKeyType="done"
                                onSubmitEditing={() => {
                                    void submitProjectTask();
                                }}
                            />
                            <View style={styles.promptActions}>
                                <TouchableOpacity
                                    style={[styles.promptButton, { borderColor: tc.border }]}
                                    onPress={closeProjectTaskPrompt}
                                >
                                    <Text style={[styles.promptButtonText, { color: tc.text }]}>{labels.cancel}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[
                                        styles.promptButtonPrimary,
                                        { opacity: projectTaskTitle.trim().length > 0 ? 1 : 0.5 },
                                    ]}
                                    onPress={() => {
                                        void submitProjectTask();
                                    }}
                                    disabled={projectTaskTitle.trim().length === 0}
                                >
                                    <Text style={styles.promptButtonPrimaryText}>{labels.add}</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    </View>
                </Modal>
            </GestureHandlerRootView>
        </Modal>
    );
}

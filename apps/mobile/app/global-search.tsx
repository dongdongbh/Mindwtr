import React, { useMemo, useState, useEffect, useRef } from 'react';
import {
    View,
    Text,
    TextInput,
    FlatList,
    TouchableOpacity,
    StyleSheet,
    Modal,
    ActivityIndicator,
    ScrollView,
    KeyboardAvoidingView,
    Platform,
    Pressable,
} from 'react-native';
import { useTaskStore,
    generateUUID,
    SavedSearch,
    SearchProjectResult,
    SearchResults,
    SearchTaskResult,
    Task,
    getStorageAdapter,
    formatI18nTemplate,
    getTaskUrgency,
    hasTimeComponent,
    isTaskFinished,
    safeFormatDate,
    TaskStatus,
    PRESET_CONTEXTS,
    PRESET_TAGS,
    shallow,
    undoTaskCompletion,
    formatTaskMarkedDoneMessage,
    translateWithFallback, tFallback, } from '@mindwtr/core';
import {
    computeGlobalSearchResults,
    getGlobalSearchFilterPresentation,
    type DuePreset,
    type GlobalSearchScope,
} from '@mindwtr/core/global-search-filter';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useLanguage } from '../contexts/language-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Search, X, Folder, CheckCircle, ChevronRight, SlidersHorizontal } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TaskEditModal } from '@/components/task-edit-modal';
import { ThemedAlertHost } from '@/components/themed-alert';
import { settleStoreAction } from '@/components/store-action-result';
import { useToast, ToastViewport } from '../contexts/toast-context';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { useFutureStartRevealTick, useLocalDayKey } from '@/hooks/use-local-day-key';

const firstSearchParam = (value: string | string[] | undefined): string => {
    if (Array.isArray(value)) return value[0] ?? '';
    return typeof value === 'string' ? value : '';
};

const decodeSearchParam = (value: string | string[] | undefined): string => {
    const raw = firstSearchParam(value);
    if (!raw) return '';
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
};

export default function SearchScreen() {
    const { _allTasks, projects, areas, settings, updateSettings, updateTask, setHighlightTask } = useTaskStore((state) => ({
        _allTasks: state._allTasks,
        projects: state.projects,
        areas: state.areas,
        settings: state.settings,
        updateSettings: state.updateSettings,
        updateTask: state.updateTask,
        setHighlightTask: state.setHighlightTask,
    }), shallow);
    const tc = useThemeColors();
    const { t } = useLanguage();
    const { showToast } = useToast();
    const router = useRouter();
  const params = useLocalSearchParams<{ q?: string }>();
  const requestedQuery = decodeSearchParam(params.q);
  const [query, setQuery] = useState(requestedQuery);
  const [ftsResults, setFtsResults] = useState<SearchResults | null>(null);
  // Which query the current ftsResults answer — stale answers must not merge
  // in front of fresh in-memory results while the user is still typing.
  const [ftsQuery, setFtsQuery] = useState('');
  const [ftsLoading, setFtsLoading] = useState(false);
  const [debouncedQuery, setDebouncedQuery] = useState('');
    const [showSaveModal, setShowSaveModal] = useState(false);
    const [saveName, setSaveName] = useState('');
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [includeCompleted, setIncludeCompleted] = useState(false);
    const [includeReference, setIncludeReference] = useState(true);
    const [hideFutureTasks, setHideFutureTasks] = useState(false);
    const [selectedStatuses, setSelectedStatuses] = useState<TaskStatus[]>([]);
    const [selectedArea, setSelectedArea] = useState<'all' | 'none' | string>('all');
    const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
    const [locationQuery, setLocationQuery] = useState('');
    const [duePreset, setDuePreset] = useState<DuePreset>('any');
    const [scope, setScope] = useState<GlobalSearchScope>('all');
    const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
    const inputRef = useRef<TextInput>(null);
    const futureStartDayKey = useLocalDayKey(hideFutureTasks);
    const futureStartRevealTick = useFutureStartRevealTick(_allTasks, hideFutureTasks);

    useEffect(() => {
        // Auto-focus after mounting
        setTimeout(() => inputRef.current?.focus(), 100);
    }, []);

    useEffect(() => {
        setQuery(requestedQuery);
    }, [requestedQuery]);

    const placeholderColor = tc.secondaryText;

  const trimmedQuery = query.trim();
  const shouldUseFts = debouncedQuery.length > 0 && !/\b\w+:/i.test(debouncedQuery);

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(trimmedQuery), 200);
    return () => clearTimeout(handle);
  }, [trimmedQuery]);

  useEffect(() => {
    let cancelled = false;
    if (!shouldUseFts) {
      setFtsResults(null);
      setFtsLoading(false);
      return;
    }
    const adapter = getStorageAdapter();
    if (!adapter.searchAll) {
      setFtsResults(null);
      setFtsLoading(false);
      return;
    }
    setFtsLoading(true);
    adapter.searchAll(debouncedQuery)
      .then((results) => {
        if (!cancelled) {
          setFtsResults(results);
          setFtsQuery(debouncedQuery);
        }
      })
      .catch(() => {
        if (!cancelled) setFtsResults(null);
      })
      .finally(() => {
        if (!cancelled) setFtsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, shouldUseFts]);

    const {
        totalResultsLabel,
        results,
        isTruncated,
        hasActiveSearch,
        hasActiveFilters,
        hiddenCompletedCount,
    } = useMemo(
        () => {
            // These clock hooks deliberately invalidate otherwise unchanged
            // search inputs at midnight and at the next timed start.
            void futureStartDayKey;
            void futureStartRevealTick;
            return computeGlobalSearchResults({
                query,
                tasks: _allTasks,
                projects,
                areas,
                includeCompleted,
                includeReference,
                hideFutureTasks,
                selectedStatuses,
                selectedArea,
                selectedTokens,
                locationQuery,
                duePreset,
                scope,
                weekStart: settings?.weekStart,
                ftsResults,
                ftsQuery,
            });
        },
        [
            query,
            _allTasks,
            projects,
            areas,
            includeCompleted,
            includeReference,
            hideFutureTasks,
            selectedStatuses,
            selectedArea,
            selectedTokens,
            locationQuery,
            duePreset,
            scope,
            settings?.weekStart,
            ftsResults,
            ftsQuery,
            futureStartDayKey,
            futureStartRevealTick,
        ]
    );
    const editingTask = useMemo<Task | null>(
        () => editingTaskId
            ? _allTasks.find((task) => task.id === editingTaskId && !task.deletedAt) ?? null
            : null,
        [_allTasks, editingTaskId]
    );
    const taskById = useMemo(() => new Map(_allTasks.map((task) => [task.id, task])), [_allTasks]);
    // Search rows are SearchTaskResult, which deliberately carries no
    // completedAt — the full task behind the row does (#991). The label word is
    // what tells a completion date from a deadline, so neither is ever shown
    // bare; a finished task with no completedAt shows nothing rather than
    // falling back to its due date.
    const resolveResultDate = (result: SearchTaskResult): { color: string; label: string } | null => {
        const task = taskById.get(result.id);
        if (!task) return null;
        if (isTaskFinished(task)) {
            if (!task.completedAt) return null;
            return {
                color: tc.secondaryText,
                label: formatI18nTemplate(t('search.completedDate'), {
                    date: safeFormatDate(task.completedAt, hasTimeComponent(task.completedAt) ? 'Pp' : 'P'),
                }),
            };
        }
        if (!task.dueDate) return null;
        // Same mapping the task rows use: red is reserved for a date that has
        // already passed (#640).
        const urgency = getTaskUrgency(task);
        const dueColor = urgency === 'overdue'
            ? tc.danger
            : urgency === 'urgent' || urgency === 'upcoming'
                ? tc.warning
                : tc.secondaryText;
        return {
            color: dueColor,
            label: formatI18nTemplate(t('search.dueDate'), {
                date: safeFormatDate(task.dueDate, hasTimeComponent(task.dueDate) ? 'Pp' : 'P'),
            }),
        };
    };
    const noResultsLabel = trimmedQuery ? t('search.noResults') + ' "' + trimmedQuery + '"' : t('search.noResults');

    const savedSearches = settings?.savedSearches || [];
    const canSave = trimmedQuery.length > 0;

    const openFilters = () => {
        inputRef.current?.blur();
        setFiltersOpen(true);
    };

    const openSaveModal = () => {
        setSaveName(trimmedQuery);
        setShowSaveModal(true);
    };

    const handleSaveSearch = async () => {
        if (!canSave) return;
        const name = saveName.trim();
        if (!name) return;
        const existing = savedSearches.find(s => s.query === trimmedQuery);
        if (existing) {
            setShowSaveModal(false);
            router.push(`/saved-search/${existing.id}`);
            return;
        }

        const newSearch: SavedSearch = {
            id: generateUUID(),
            name,
            query: trimmedQuery,
        };
        await updateSettings({ savedSearches: [...savedSearches, newSearch] });
        setShowSaveModal(false);
        router.push(`/saved-search/${newSearch.id}`);
    };

    const navigateToTaskList = (task: SearchTaskResult) => {
        const status = task.status;
        setHighlightTask(task.id);
        if (status === 'done') {
            router.push('/done' as never);
            return;
        }
        if (status === 'archived') {
            router.push('/archived');
            return;
        }
        if (task.projectId) {
            router.push({ pathname: '/projects-screen', params: { projectId: task.projectId, taskId: task.id, openToken: String(Date.now()) } });
            return;
        }

        // Map status to route
        if (status === 'inbox') router.push('/inbox');
        else if (status === 'next') router.push('/focus');
        else if (status === 'waiting') router.push('/waiting');
        else if (status === 'someday') router.push('/someday');
        else if (status === 'reference') router.push('/reference' as never);
        else router.push('/focus');
    };

    const showTaskActionFailure = (message?: string) => {
        showToast({
            title: tFallback(t, 'common.error', 'Error'),
            message: message || tFallback(t, 'task.updateFailed', 'Could not update task.'),
            tone: 'error',
            durationMs: 4200,
        });
    };

    // The row's check icon completes the task in place (#1051) — same
    // immediate-complete-with-undo-toast contract as the task list rows.
    const completeTaskFromSearch = (result: SearchTaskResult) => {
        const task = _allTasks.find((item) => item.id === result.id && !item.deletedAt);
        if (!task || isTaskFinished(task)) return;
        const previousStatus = task.status;
        const wasFocusedToday = task.isFocusedToday === true;
        void settleStoreAction(() => updateTask(task.id, { status: 'done' }))
            .then((outcome) => {
                if (!outcome.ok) {
                    showTaskActionFailure(outcome.message);
                    return;
                }
                showToast({
                    message: formatTaskMarkedDoneMessage(t, task.title),
                    tone: 'info',
                    actionLabel: tFallback(t, 'common.undo', 'Undo'),
                    onAction: () => {
                        void settleStoreAction(() => (
                            undoTaskCompletion(task.id, previousStatus, wasFocusedToday)
                        )).then((undoOutcome) => {
                            if (!undoOutcome.ok) showTaskActionFailure(undoOutcome.message);
                        });
                    },
                    durationMs: 5200,
                });
            });
    };

    const handleSelect = (result: { type: 'project'; item: SearchProjectResult } | { type: 'task'; item: SearchTaskResult }) => {
        if (result.type === 'project') {
            router.push({ pathname: '/projects-screen', params: { projectId: result.item.id, openToken: String(Date.now()) } });
            return;
        }

        const task = _allTasks.find((item) => item.id === result.item.id && !item.deletedAt);
        if (!task) {
            navigateToTaskList(result.item);
            return;
        }

        setHighlightTask(task.id);
        setEditingTaskId(task.id);
    };

    const statusOptions: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'done', 'reference', 'archived'];
    const allTokens = useMemo(() => {
        const tokens = new Set<string>([...PRESET_CONTEXTS, ...PRESET_TAGS]);
        _allTasks.forEach((task) => {
            task.contexts?.forEach((ctx) => tokens.add(ctx));
            task.tags?.forEach((tag) => tokens.add(tag));
        });
        return Array.from(tokens).filter(Boolean).sort();
    }, [_allTasks]);
    const filterPresentation = getGlobalSearchFilterPresentation(t);
    const toggleStatus = (status: TaskStatus) => {
        setSelectedStatuses((prev) => (
            prev.includes(status) ? prev.filter((item) => item !== status) : [...prev, status]
        ));
    };
    const toggleToken = (token: string) => {
        setSelectedTokens((prev) => (
            prev.includes(token) ? prev.filter((item) => item !== token) : [...prev, token]
        ));
    };
    const clearFilters = () => {
        setSelectedStatuses([]);
        setSelectedArea('all');
        setSelectedTokens([]);
        setLocationQuery('');
        setDuePreset('any');
        setScope('all');
        setIncludeCompleted(false);
        setIncludeReference(true);
        setHideFutureTasks(false);
    };
    const activeChips: { key: string; label: string; onPress: () => void }[] = [];
    selectedStatuses.forEach((status) => {
        activeChips.push({
            key: `status:${status}`,
            label: tFallback(t, `status.${status}`, status),
            onPress: () => toggleStatus(status),
        });
    });
    if (selectedArea !== 'all') {
        const label = selectedArea === 'none'
            ? t('taskEdit.noAreaOption')
            : (areas.find((area) => area.id === selectedArea)?.name ?? selectedArea);
        activeChips.push({
            key: `area:${selectedArea}`,
            label: `${t('taskEdit.areaLabel')}: ${label}`,
            onPress: () => setSelectedArea('all'),
        });
    }
    selectedTokens.forEach((token) => {
        activeChips.push({
            key: `token:${token}`,
            label: token,
            onPress: () => toggleToken(token),
        });
    });
    if (locationQuery.trim()) {
        activeChips.push({
            key: 'location',
            label: `${t('taskEdit.locationLabel')}: ${locationQuery.trim()}`,
            onPress: () => setLocationQuery(''),
        });
    }
    if (duePreset !== 'any') {
        activeChips.push({
            key: `due:${duePreset}`,
            label: `${filterPresentation.sections.due}: ${filterPresentation.due[duePreset]}`,
            onPress: () => setDuePreset('any'),
        });
    }
    if (scope !== 'all') {
        activeChips.push({
            key: `scope:${scope}`,
            label: filterPresentation.scope[scope],
            onPress: () => setScope('all'),
        });
    }
    if (includeCompleted) {
        activeChips.push({
            key: 'includeCompleted',
            label: t('search.includeCompleted'),
            onPress: () => setIncludeCompleted(false),
        });
    }
    const hideLabel = translateWithFallback(t, 'filters.hide', 'Hide');
    if (!includeReference) {
        activeChips.push({
            key: 'hideReference',
            label: `${hideLabel}: ${tFallback(t, 'status.reference', 'Reference')}`,
            onPress: () => setIncludeReference(true),
        });
    }
    const hideFutureTasksLabel = translateWithFallback(t, 'filters.hideFutureTasks', 'Hide future tasks');
    if (hideFutureTasks) {
        activeChips.push({
            key: 'hideFutureTasks',
            label: hideFutureTasksLabel,
            onPress: () => setHideFutureTasks(false),
        });
    }

    const renderChip = (label: string, selected: boolean, onPress: () => void) => (
        <TouchableOpacity
            key={label}
            onPress={onPress}
            style={[
                styles.chip,
                {
                    backgroundColor: selected ? tc.tint : tc.filterBg,
                    borderColor: tc.border,
                },
            ]}
        >
            <Text
                style={[
                    styles.chipText,
                    { color: selected ? tc.onTint : tc.text },
                ]}
            >
                {label}
            </Text>
        </TouchableOpacity>
    );
    const filtersActive = filtersOpen || hasActiveFilters;
    const searchPlaceholderRaw = t('search.placeholder');
    const searchPlaceholder = searchPlaceholderRaw === 'search.placeholder'
      ? t('common.search')
      : searchPlaceholderRaw;

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['top']}>
            <View style={[styles.header, { borderBottomColor: tc.border }]}>
                <Search size={20} color={tc.secondaryText} style={styles.searchIcon} />
                <TextInput
                    ref={inputRef}
                    style={[styles.input, { color: tc.text }]}
                    placeholder={searchPlaceholder}
                    placeholderTextColor={placeholderColor}
                    value={query}
                    onChangeText={setQuery}
                    returnKeyType="search"
                />
                {query.length > 0 && (
                    <TouchableOpacity onPress={() => setQuery('')}>
                        <X size={20} color={tc.secondaryText} />
                    </TouchableOpacity>
                )}
                <TouchableOpacity
                    accessibilityLabel={t('filters.label')}
                    accessibilityRole="button"
                    onPress={openFilters}
                    style={[
                        styles.filterButton,
                        {
                            borderColor: filtersActive ? tc.tint : tc.border,
                            backgroundColor: filtersActive ? tc.filterBg : 'transparent',
                        },
                    ]}
                >
                    <SlidersHorizontal size={18} color={filtersActive ? tc.tint : tc.secondaryText} />
                </TouchableOpacity>
                {canSave && (
                    <TouchableOpacity onPress={openSaveModal} style={styles.saveButton}>
                        <Text style={[styles.saveButtonText, { color: tc.tint }]}>{t('search.saveSearch')}</Text>
                    </TouchableOpacity>
                )}
            </View>

            {trimmedQuery !== '' && (
                <Text style={[styles.helpText, { color: tc.secondaryText }]}>
                    {t('search.helpOperators')}
                </Text>
            )}
            {activeChips.length > 0 && (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.activeChips}
                >
                    {activeChips.map((chip) => renderChip(chip.label, true, chip.onPress))}
                </ScrollView>
            )}
            <Modal
                animationType="fade"
                accessibilityViewIsModal
                onRequestClose={() => setFiltersOpen(false)}
                transparent
                visible={filtersOpen}
            >
                <KeyboardAvoidingView
                    behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                    style={styles.filtersSheetRoot}
                >
                    <Pressable
                        accessibilityLabel={t('common.close')}
                        accessibilityRole="button"
                        onPress={() => setFiltersOpen(false)}
                        style={styles.filtersSheetBackdrop}
                    />
                    <View style={[styles.filtersSheet, { borderColor: tc.border, backgroundColor: tc.cardBg }]}>
                        <View style={styles.filtersHeader}>
                            <Text style={[styles.filtersTitle, { color: tc.text }]}>{t('filters.label')}</Text>
                            <View style={styles.filtersHeaderActions}>
                                {hasActiveFilters && (
                                    <TouchableOpacity
                                        accessibilityRole="button"
                                        onPress={clearFilters}
                                        style={styles.filtersTextButton}
                                    >
                                        <Text style={[styles.clearFiltersText, { color: tc.tint }]}>{filterPresentation.clear}</Text>
                                    </TouchableOpacity>
                                )}
                                <TouchableOpacity
                                    accessibilityLabel={t('common.close')}
                                    accessibilityRole="button"
                                    onPress={() => setFiltersOpen(false)}
                                    style={styles.filtersIconButton}
                                >
                                    <X size={18} color={tc.secondaryText} />
                                </TouchableOpacity>
                            </View>
                        </View>
                        <ScrollView
                            style={styles.filtersScroll}
                            contentContainerStyle={styles.filtersContent}
                            keyboardShouldPersistTaps="handled"
                            showsVerticalScrollIndicator={false}
                        >
                            <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>
                                {filterPresentation.sections.due}
                            </Text>
                            <View style={styles.chipRow}>
                                {(['any', 'overdue', 'today', 'tomorrow', 'this_week', 'next_week', 'none'] as const).map((value) =>
                                    renderChip(filterPresentation.due[value], duePreset === value, () => setDuePreset(value))
                                )}
                            </View>

                            <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>
                                {tFallback(t, 'taskEdit.locationLabel', 'Location')}
                            </Text>
                            <TextInput
                                accessibilityLabel={tFallback(t, 'taskEdit.locationLabel', 'Location')}
                                autoCapitalize="none"
                                autoCorrect={false}
                                style={[styles.filterInput, { color: tc.text, borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                value={locationQuery}
                                onChangeText={setLocationQuery}
                                placeholder={tFallback(t, 'taskEdit.locationPlaceholder', 'e.g. Office')}
                                placeholderTextColor={tc.secondaryText}
                                returnKeyType="done"
                            />

                            <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>
                                {filterPresentation.sections.tokens}
                            </Text>
                            <View style={styles.chipRow}>
                                {allTokens.map((token) => renderChip(token, selectedTokens.includes(token), () => toggleToken(token)))}
                            </View>

                            <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>
                                {tFallback(t, 'search.include.label', 'Include')}
                            </Text>
                            <View style={styles.chipRow}>
                                {renderChip(
                                    t('search.includeCompleted'),
                                    includeCompleted,
                                    () => setIncludeCompleted((prev) => !prev)
                                )}
                                {renderChip(
                                    t('search.includeReference'),
                                    includeReference,
                                    () => setIncludeReference((prev) => !prev)
                                )}
                                {renderChip(
                                    hideFutureTasksLabel,
                                    hideFutureTasks,
                                    () => setHideFutureTasks((prev) => !prev)
                                )}
                            </View>

                            <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>
                                {filterPresentation.sections.status}
                            </Text>
                            <View style={styles.chipRow}>
                                {statusOptions.map((status) =>
                                    renderChip(
                                        tFallback(t, `status.${status}`, status),
                                        selectedStatuses.includes(status),
                                        () => toggleStatus(status)
                                    )
                                )}
                            </View>

                            <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>
                                {filterPresentation.sections.scope}
                            </Text>
                            <View style={styles.chipRow}>
                                {(['all', 'projects', 'tasks', 'project_tasks'] as const).map((value) =>
                                    renderChip(filterPresentation.scope[value], scope === value, () => setScope(value))
                                )}
                            </View>

                            <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>
                                {filterPresentation.sections.area}
                            </Text>
                            <View style={styles.chipRow}>
                                {renderChip(
                                    `${t('common.all')} ${tFallback(t, 'taskEdit.areaLabel', 'Area')}`,
                                    selectedArea === 'all',
                                    () => setSelectedArea('all')
                                )}
                                {renderChip(
                                    tFallback(t, 'taskEdit.noAreaOption', 'No Area'),
                                    selectedArea === 'none',
                                    () => setSelectedArea('none')
                                )}
                                {areas.map((area) =>
                                    renderChip(area.name, selectedArea === area.id, () => setSelectedArea(area.id))
                                )}
                            </View>
                        </ScrollView>
                    </View>
                </KeyboardAvoidingView>
            </Modal>
            {hasActiveSearch && isTruncated && (
                <Text style={[styles.helpText, { color: tc.secondaryText }]}>
                    {t('search.showingFirst')
                        .replace('{shown}', String(results.length))
                        .replace('{total}', totalResultsLabel)}
                </Text>
            )}
            {ftsLoading && trimmedQuery !== '' && (
                <View style={styles.loadingRow}>
                    <ActivityIndicator size="small" color={tc.tint} />
                    <Text style={[styles.loadingText, { color: tc.secondaryText }]}>
                        {t('search.searching')}
                    </Text>
                </View>
            )}
            {hasActiveSearch && hiddenCompletedCount > 0 && (
                <TouchableOpacity
                    onPress={() => setIncludeCompleted(true)}
                    accessibilityRole="button"
                    style={[styles.hiddenMatchesHint, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                >
                    <Text style={[styles.hiddenMatchesHintText, { color: tc.tint }]}>
                        {t('search.hiddenCompletedMatches').replace('{{count}}', String(hiddenCompletedCount))}
                    </Text>
                </TouchableOpacity>
            )}

            <FlatList
                data={results}
                keyExtractor={(item) => `${item.type}-${item.item.id}`}
                contentContainerStyle={styles.listContent}
                keyboardShouldPersistTaps="handled"
                ListEmptyComponent={
                    hasActiveSearch && !ftsLoading ? (
                        <View style={styles.emptyContainer}>
                            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                                {noResultsLabel}
                            </Text>
                        </View>
                    ) : null
                }
                renderItem={({ item }) => {
                    const resultDate = item.type === 'task' ? resolveResultDate(item.item) : null;
                    return (
                        <TouchableOpacity
                            style={[styles.resultItem, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                            onPress={() => handleSelect(item)}
                        >
                            {item.type === 'project' ? (
                                <Folder size={24} color={tc.tint} />
                            ) : isTaskFinished(item.item as SearchTaskResult) ? (
                                <CheckCircle size={24} color={tc.tint} />
                            ) : (
                                <TouchableOpacity
                                    onPress={() => completeTaskFromSearch(item.item as SearchTaskResult)}
                                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                    accessibilityRole="button"
                                    accessibilityLabel={tFallback(t, 'review.markDone', 'Mark Done')}
                                >
                                    <CheckCircle size={24} color={tc.secondaryText} />
                                </TouchableOpacity>
                            )}
                            <View style={styles.resultText}>
                                <Text style={[styles.resultTitle, { color: tc.text }]}>{item.item.title}</Text>
                                <Text style={[styles.resultSubtitle, { color: tc.secondaryText }]}>
                                    {item.type === 'project'
                                        ? t('search.resultProject')
                                        : (item.item as SearchTaskResult).projectId
                                            ? `${t('search.resultTask')} • ${t('search.inProjectSuffix')}`
                                            : t('search.resultTask')}
                                </Text>
                                {resultDate && (
                                    <Text style={[styles.resultDate, { color: resultDate.color }]}>
                                        {resultDate.label}
                                    </Text>
                                )}
                            </View>
                            <ChevronRight size={20} color={tc.secondaryText} />
                        </TouchableOpacity>
                    );
                }}
              removeClippedSubviews={false}
            />

            <Modal
                visible={showSaveModal}
                transparent
                animationType="fade"
                onRequestClose={() => setShowSaveModal(false)}
            >
                <View style={styles.modalOverlay}>
                    <View style={[styles.saveModal, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                        <Text style={[styles.modalTitle, { color: tc.text }]}>{t('search.saveSearch')}</Text>
                        <TextInput
                            style={[styles.modalInput, { color: tc.text, borderColor: tc.border }]}
                            placeholder={t('search.saveSearchPrompt')}
                            placeholderTextColor={placeholderColor}
                            value={saveName}
                            onChangeText={setSaveName}
                            autoFocus
                        />
                        <View style={styles.modalActions}>
                            <TouchableOpacity onPress={() => setShowSaveModal(false)} style={styles.modalButton}>
                                <Text style={[styles.modalButtonText, { color: tc.secondaryText }]}>{t('common.cancel')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity onPress={handleSaveSearch} style={styles.modalButton}>
                                <Text style={[styles.modalButtonText, { color: tc.text }]}>{t('common.save')}</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>
            <TaskEditModal
                visible={Boolean(editingTask)}
                task={editingTask}
                onClose={() => setEditingTaskId(null)}
                onSave={(taskId, updates) => {
                    const result = updateTask(taskId, updates);
                    setEditingTaskId(null);
                    return result;
                }}
                defaultTab="view"
                onProjectNavigate={openProjectScreen}
                onContextNavigate={openContextsScreen}
                onTagNavigate={openContextsScreen}
                onFocusMode={(taskId) => {
                    setEditingTaskId(null);
                    router.push(`/check-focus?id=${taskId}`);
                }}
            />
            {/* This route is presented modally, so a root-level alert never
                reaches the screen on iOS (#940). */}
            <ThemedAlertHost />
            {/* Same modal-covering problem for toasts: the completion undo
                toast must render inside this screen, not the root overlay. */}
            <ToastViewport />
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 16,
        borderBottomWidth: 1,
        gap: 12,
    },
    saveButton: {
        marginLeft: 4,
    },
    saveButtonText: {
        fontSize: 14,
        fontWeight: '600',
    },
    filterButton: {
        borderWidth: 1,
        borderRadius: 8,
        padding: 6,
        marginLeft: 2,
    },
    helpText: {
        fontSize: 12,
        paddingHorizontal: 16,
        paddingTop: 8,
    },
    loadingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingTop: 8,
    },
    hiddenMatchesHint: {
        marginHorizontal: 16,
        marginTop: 8,
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
    },
    hiddenMatchesHintText: {
        fontSize: 13,
        fontWeight: '600',
        textAlign: 'center',
    },
    loadingText: {
        fontSize: 12,
    },
    searchIcon: {
        marginRight: 4,
    },
    input: {
        flex: 1,
        fontSize: 16,
        height: 40,
    },
    activeChips: {
        paddingHorizontal: 16,
        paddingTop: 8,
        alignItems: 'center',
        gap: 8,
    },
    filtersSheetRoot: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    filtersSheetBackdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.45)',
    },
    filtersSheet: {
        maxHeight: '82%',
        marginHorizontal: 12,
        marginBottom: 12,
        padding: 12,
        borderRadius: 16,
        borderWidth: 1,
        gap: 12,
    },
    filtersHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    filtersHeaderActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    filtersTitle: {
        fontSize: 14,
        fontWeight: '600',
    },
    filtersTextButton: {
        minHeight: 36,
        justifyContent: 'center',
        paddingHorizontal: 8,
    },
    filtersIconButton: {
        minWidth: 36,
        minHeight: 36,
        alignItems: 'center',
        justifyContent: 'center',
    },
    clearFiltersText: {
        fontSize: 12,
        fontWeight: '600',
    },
    filtersScroll: {
        flexGrow: 0,
    },
    filtersContent: {
        gap: 12,
        paddingBottom: 12,
    },
    sectionLabel: {
        fontSize: 12,
        fontWeight: '600',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
    },
    chipRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    chip: {
        borderWidth: 1,
        borderRadius: 16,
        paddingHorizontal: 10,
        paddingVertical: 6,
    },
    chipText: {
        fontSize: 12,
        fontWeight: '600',
    },
    filterInput: {
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: 13,
    },
    listContent: {
        padding: 16,
        gap: 12,
    },
    resultItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        gap: 12,
    },
    resultText: {
        flex: 1,
    },
    resultTitle: {
        fontSize: 16,
        fontWeight: '500',
        marginBottom: 2,
    },
    resultSubtitle: {
        fontSize: 12,
    },
    resultDate: {
        fontSize: 12,
        marginTop: 2,
    },
    emptyContainer: {
        padding: 32,
        alignItems: 'center',
    },
    emptyText: {
        fontSize: 16,
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    saveModal: {
        width: '100%',
        borderRadius: 12,
        padding: 16,
        borderWidth: 1,
        gap: 12,
    },
    modalTitle: {
        fontSize: 16,
        fontWeight: '600',
    },
    modalInput: {
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        fontSize: 16,
    },
    modalActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 12,
    },
    modalButton: {
        paddingHorizontal: 8,
        paddingVertical: 6,
    },
    modalButtonText: {
        fontSize: 14,
        fontWeight: '600',
    },
});

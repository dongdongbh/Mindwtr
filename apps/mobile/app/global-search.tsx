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
    SearchProjectResult,
    SearchResults,
    SearchTaskResult,
    Task,
    getStorageAdapter,
    isTaskFinished,
    isTaskCancelled,
    safeFormatDate,
    TaskStatus,
    shallow,
    undoTaskCompletion,
    formatTaskMarkedDoneMessage,
    tFallback,
    createSearchHighlighter,
    DEFAULT_GLOBAL_SEARCH_FILTERS,
    fetchGlobalSearchAdapterResults,
    getGlobalSearchActiveChips,
    getGlobalSearchFilterOptions,
    getGlobalSearchResultDate,
    getGlobalSearchTaskListTarget,
    resolveSavedSearch,
    shouldRequestGlobalSearchFts,
    type GlobalSearchFilterState,
} from '@mindwtr/core';
import {
    computeGlobalSearchResults,
    type DuePreset,
    type GlobalSearchScope,
} from '@mindwtr/core/global-search-filter';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useLanguage } from '../contexts/language-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Search, X, Folder, CheckCircle, ChevronRight, SlidersHorizontal, XCircle } from 'lucide-react-native';
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

export default function SearchScreen() {
    const { _allTasks, _tasksById, projects, areas, settings, updateSettings, updateTask, setHighlightTask } = useTaskStore((state) => ({
        _allTasks: state._allTasks,
        _tasksById: state._tasksById,
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
  const params = useLocalSearchParams<{ q?: string; includeCompleted?: string }>();
  const requestedQuery = firstSearchParam(params.q);
  const requestedIncludeCompleted = firstSearchParam(params.includeCompleted).toLowerCase() === 'true';
  const [query, setQuery] = useState(requestedQuery);
  const [ftsResults, setFtsResults] = useState<SearchResults | null>(null);


  const [ftsQuery, setFtsQuery] = useState('');
  const [ftsLoading, setFtsLoading] = useState(false);
  const [debouncedQuery, setDebouncedQuery] = useState('');
    const [showSaveModal, setShowSaveModal] = useState(false);
    const [saveName, setSaveName] = useState('');
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [includeCompleted, setIncludeCompleted] = useState(requestedIncludeCompleted);
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
        const handle = setTimeout(() => {
            if (requestedQuery.trim()) inputRef.current?.blur();
            else inputRef.current?.focus();
        }, 100);
        return () => clearTimeout(handle);
    }, [requestedQuery]);

    useEffect(() => {
        setQuery(requestedQuery);
        setIncludeCompleted(requestedIncludeCompleted);
    }, [requestedIncludeCompleted, requestedQuery]);

    const placeholderColor = tc.secondaryText;

  const trimmedQuery = query.trim();
  const highlightText = useMemo(() => createSearchHighlighter(query), [query]);
  const shouldUseFts = shouldRequestGlobalSearchFts(debouncedQuery);

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
    fetchGlobalSearchAdapterResults(debouncedQuery, adapter.searchAll.bind(adapter))
      .then((results) => {
        if (!cancelled) {
          setFtsResults(results);
          setFtsQuery(debouncedQuery);
        }
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


    const taskById = _tasksById;


    const resolveResultDate = (result: SearchTaskResult): { color: string; label: string } | null => {
        const date = getGlobalSearchResultDate(taskById.get(result.id), t, safeFormatDate);
        return date ? { label: date.label, color: date.tone === 'danger' ? tc.danger
            : date.tone === 'warning' ? tc.warning : tc.secondaryText } : null;
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
        const resolved = resolveSavedSearch(savedSearches, trimmedQuery, name, generateUUID());
        if (resolved.existing) {
            setShowSaveModal(false);
            router.push(`/saved-search/${resolved.search.id}`);
            return;
        }
        await updateSettings({ savedSearches: [...savedSearches, resolved.search] });
        setShowSaveModal(false);
        router.push(`/saved-search/${resolved.search.id}`);
    };

    const navigateToTaskList = (task: SearchTaskResult) => {
        setHighlightTask(task.id);
        const target = getGlobalSearchTaskListTarget(task);
        if (target.projectId) {
            router.push({ pathname: '/projects-screen', params: { projectId: target.projectId, taskId: task.id, openToken: String(Date.now()) } });
            return;
        }
        router.push(target.route as never);
    };

    const showTaskActionFailure = (message?: string) => {
        showToast({
            title: tFallback(t, 'common.error', 'Error'),
            message: message || tFallback(t, 'task.updateFailed', 'Could not update task.'),
            tone: 'error',
            durationMs: 4200,
        });
    };


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

    const filterOptions = useMemo(() => getGlobalSearchFilterOptions(_allTasks, areas, t), [_allTasks, areas, t]);
    const filterPresentation = filterOptions.presentation;
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
    const filterState: GlobalSearchFilterState = {
        includeCompleted, includeReference, hideFutureTasks, selectedStatuses, selectedArea,
        selectedTokens, locationQuery, duePreset, scope,
    };
    const applyFilters = (next: GlobalSearchFilterState) => {
        setSelectedStatuses(next.selectedStatuses);
        setSelectedArea(next.selectedArea);
        setSelectedTokens(next.selectedTokens);
        setLocationQuery(next.locationQuery ?? '');
        setDuePreset(next.duePreset);
        setScope(next.scope);
        setIncludeCompleted(next.includeCompleted);
        setIncludeReference(next.includeReference);
        setHideFutureTasks(next.hideFutureTasks);
    };
    const clearFilters = () => applyFilters(DEFAULT_GLOBAL_SEARCH_FILTERS);
    const activeChips = getGlobalSearchActiveChips(filterState, areas, t);
    const clearChip = (key: string) => {
        if (key.startsWith('status:')) setSelectedStatuses((prev) => prev.filter((status) => status !== key.slice(7)));
        else if (key.startsWith('token:')) setSelectedTokens((prev) => prev.filter((token) => token !== key.slice(6)));
        else if (key.startsWith('area:')) setSelectedArea('all');
        else if (key.startsWith('due:')) setDuePreset('any');
        else if (key.startsWith('scope:')) setScope('all');
        else if (key === 'location') setLocationQuery('');
        else if (key === 'includeCompleted') setIncludeCompleted(false);
        else if (key === 'hideReference') setIncludeReference(true);
        else if (key === 'hideFutureTasks') setHideFutureTasks(false);
    };

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
                {activeChips.map((chip) => renderChip(chip.label, true, () => clearChip(chip.key)))}
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
                                {filterOptions.due.map(({ value, label }) =>
                                    renderChip(label, duePreset === value, () => setDuePreset(value))
                                )}
                            </View>

                            <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>
                                {filterOptions.location.label}
                            </Text>
                            <TextInput
                                accessibilityLabel={filterOptions.location.label}
                                autoCapitalize="none"
                                autoCorrect={false}
                                style={[styles.filterInput, { color: tc.text, borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                value={locationQuery}
                                onChangeText={setLocationQuery}
                                placeholder={filterOptions.location.placeholder}
                                placeholderTextColor={tc.secondaryText}
                                returnKeyType="done"
                            />

                            <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>
                                {filterPresentation.sections.tokens}
                            </Text>
                            <View style={styles.chipRow}>
                                {filterOptions.tokens.map((token) => renderChip(token, selectedTokens.includes(token), () => toggleToken(token)))}
                            </View>

                            <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>
                                {filterOptions.include.label}
                            </Text>
                            <View style={styles.chipRow}>
                                {renderChip(
                                    filterOptions.include.completed,
                                    includeCompleted,
                                    () => setIncludeCompleted((prev) => !prev)
                                )}
                                {renderChip(
                                    filterOptions.include.reference,
                                    includeReference,
                                    () => setIncludeReference((prev) => !prev)
                                )}
                                {renderChip(
                                    filterOptions.include.hideFutureTasks,
                                    hideFutureTasks,
                                    () => setHideFutureTasks((prev) => !prev)
                                )}
                            </View>

                            <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>
                                {filterPresentation.sections.status}
                            </Text>
                            <View style={styles.chipRow}>
                                {filterOptions.statuses.map(({ value: status, label }) =>
                                    renderChip(
                                        label,
                                        selectedStatuses.includes(status),
                                        () => toggleStatus(status)
                                    )
                                )}
                            </View>

                            <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>
                                {filterPresentation.sections.scope}
                            </Text>
                            <View style={styles.chipRow}>
                                {filterOptions.scope.map(({ value, label }) =>
                                    renderChip(label, scope === value, () => setScope(value))
                                )}
                            </View>

                            <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>
                                {filterPresentation.sections.area}
                            </Text>
                            <View style={styles.chipRow}>
                                {filterOptions.areas.map(({ value, label }) =>
                                    renderChip(label, selectedArea === value, () => setSelectedArea(value))
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
                            ) : isTaskCancelled(taskById.get(item.item.id)) ? (
                                <XCircle size={24} color={tc.secondaryText} />
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
                                <Text
                                    style={[styles.resultTitle, { color: tc.text }]}
                                    accessibilityLabel={item.item.title}
                                >
                                    {highlightText(item.item.title).map((segment, index) => (
                                        segment.highlighted ? (
                                            <Text key={index} style={{ color: tc.tint, fontWeight: '600' }}>
                                                {segment.text}
                                            </Text>
                                        ) : segment.text
                                    ))}
                                </Text>
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
            />
            {
                                                    }
            <ThemedAlertHost />
            {
                                                                              }
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

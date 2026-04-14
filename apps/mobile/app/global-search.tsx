import React, { useMemo, useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet, Modal, ActivityIndicator, ScrollView } from 'react-native';
import {
    useTaskStore,
    searchAll,
    generateUUID,
    SavedSearch,
    SearchProjectResult,
    SearchResults,
    SearchTaskResult,
    getStorageAdapter,
    TaskStatus,
    PRESET_CONTEXTS,
    PRESET_TAGS,
    matchesHierarchicalToken,
    safeParseDueDate,
} from '@mindwtr/core';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useLanguage } from '../contexts/language-context';
import { useRouter } from 'expo-router';
import { Search, X, Folder, CheckCircle, ChevronRight, SlidersHorizontal } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function SearchScreen() {
    const { _allTasks, projects, areas, settings, updateSettings, setHighlightTask } = useTaskStore();
    const tc = useThemeColors();
    const { t } = useLanguage();
    const router = useRouter();
  const [query, setQuery] = useState('');
  const [ftsResults, setFtsResults] = useState<SearchResults | null>(null);
  const [ftsLoading, setFtsLoading] = useState(false);
  const [debouncedQuery, setDebouncedQuery] = useState('');
    const [showSaveModal, setShowSaveModal] = useState(false);
    const [saveName, setSaveName] = useState('');
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [includeCompleted, setIncludeCompleted] = useState(false);
    const [includeReference, setIncludeReference] = useState(true);
    const [selectedStatuses, setSelectedStatuses] = useState<TaskStatus[]>([]);
    const [selectedArea, setSelectedArea] = useState<'all' | 'none' | string>('all');
    const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
    const [duePreset, setDuePreset] = useState<'any' | 'overdue' | 'today' | 'tomorrow' | 'this_week' | 'next_week' | 'none'>('any');
    const [scope, setScope] = useState<'all' | 'projects' | 'tasks' | 'project_tasks'>('all');
    const inputRef = useRef<TextInput>(null);

    useEffect(() => {
        // Auto-focus after mounting
        setTimeout(() => inputRef.current?.focus(), 100);
    }, []);

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
        if (!cancelled) setFtsResults(results);
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

  const fallbackResults = trimmedQuery === ''
    ? { tasks: [] as SearchTaskResult[], projects: [] as SearchProjectResult[] }
    : searchAll(_allTasks, projects, trimmedQuery);
  const effectiveResults = ftsResults && (ftsResults.tasks.length + ftsResults.projects.length) > 0
    ? ftsResults
    : fallbackResults;
  const { tasks: taskResults, projects: projectResults } = effectiveResults;
    const hasStatusFilter = selectedStatuses.length > 0;
    const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
    const matchesArea = (areaId?: string | null) => {
        if (selectedArea === 'all') return true;
        if (selectedArea === 'none') return !areaId;
        return areaId === selectedArea;
    };
    const matchesTaskArea = (task: SearchTaskResult) => {
        if (selectedArea === 'all') return true;
        if (task.projectId) {
            const project = projectById.get(task.projectId);
            return matchesArea(project?.areaId ?? null);
        }
        return matchesArea(task.areaId ?? null);
    };
    const matchesTokens = (task: SearchTaskResult) => {
        if (selectedTokens.length === 0) return true;
        const taskTokens = [...(task.contexts || []), ...(task.tags || [])];
        return selectedTokens.every((token) =>
            taskTokens.some((taskToken) => matchesHierarchicalToken(token, taskToken))
        );
    };
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = settings?.weekStart === 'monday' ? 1 : 0;
    const startOfWeek = new Date(startOfToday);
    const weekday = startOfWeek.getDay();
    const diffToWeekStart = weekStart === 1 ? (weekday + 6) % 7 : weekday;
    startOfWeek.setDate(startOfWeek.getDate() - diffToWeekStart);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(endOfWeek.getDate() + 7);
    const nextWeekStart = new Date(endOfWeek);
    const nextWeekEnd = new Date(nextWeekStart);
    nextWeekEnd.setDate(nextWeekStart.getDate() + 7);
    const matchesDue = (task: SearchTaskResult) => {
        if (duePreset === 'any') return true;
        if (duePreset === 'none') return !task.dueDate;
        if (!task.dueDate) return false;
        const due = safeParseDueDate(task.dueDate);
        if (!due) return false;
        if (duePreset === 'overdue') return due < startOfToday;
        if (duePreset === 'today') return due >= startOfToday && due < new Date(startOfToday.getTime() + 86400000);
        if (duePreset === 'tomorrow') {
            const tomorrow = new Date(startOfToday.getTime() + 86400000);
            const nextDay = new Date(startOfToday.getTime() + 2 * 86400000);
            return due >= tomorrow && due < nextDay;
        }
        if (duePreset === 'this_week') return due >= startOfWeek && due < endOfWeek;
        if (duePreset === 'next_week') return due >= nextWeekStart && due < nextWeekEnd;
        return true;
    };
    const filteredTasks = taskResults.filter((task) => {
        if (hasStatusFilter) {
            if (!selectedStatuses.includes(task.status)) return false;
        } else {
            if (!includeCompleted && (task.status === 'done' || task.status === 'archived')) return false;
            if (!includeReference && task.status === 'reference') return false;
        }
        if (scope === 'project_tasks' && !task.projectId) return false;
        if (!matchesTaskArea(task)) return false;
        if (!matchesTokens(task)) return false;
        if (!matchesDue(task)) return false;
        return true;
    });
    const filteredProjects = projectResults.filter((project) => {
        if (!includeCompleted && project.status === 'archived') return false;
        if (!matchesArea(project.areaId ?? null)) return false;
        return true;
    });
    const scopedProjects = scope === 'tasks' || scope === 'project_tasks' ? [] : filteredProjects;
    const scopedTasks = scope === 'projects' ? [] : filteredTasks;
    const totalResults = scopedProjects.length + scopedTasks.length;
    const results = trimmedQuery === '' ? [] : [
        ...scopedProjects.map(p => ({ type: 'project' as const, item: p })),
        ...scopedTasks.map(t => ({ type: 'task' as const, item: t })),
    ].slice(0, 50);
    const isTruncated = totalResults > results.length;

    const savedSearches = settings?.savedSearches || [];
    const canSave = trimmedQuery.length > 0;

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

    const handleSelect = (result: { type: 'project'; item: SearchProjectResult } | { type: 'task'; item: SearchTaskResult }) => {
        if (result.type === 'project') {
            router.push({ pathname: '/projects-screen', params: { projectId: result.item.id } });
            return;
        }

        const task = result.item;
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
            router.push({ pathname: '/projects-screen', params: { projectId: task.projectId, taskId: task.id } });
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

    const statusOptions: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'];
    const allTokens = useMemo(() => {
        const tokens = new Set<string>([...PRESET_CONTEXTS, ...PRESET_TAGS]);
        _allTasks.forEach((task) => {
            task.contexts?.forEach((ctx) => tokens.add(ctx));
            task.tags?.forEach((tag) => tokens.add(tag));
        });
        return Array.from(tokens).filter(Boolean).sort();
    }, [_allTasks]);
    const dueLabels: Record<typeof duePreset, string> = {
        any: t('search.due.any'),
        overdue: t('search.due.overdue'),
        today: t('search.due.today'),
        tomorrow: t('search.due.tomorrow'),
        this_week: t('search.due.thisWeek'),
        next_week: t('search.due.nextWeek'),
        none: t('search.due.none'),
    };
    const scopeLabels: Record<typeof scope, string> = {
        all: t('search.scope.all'),
        projects: t('search.scope.projects'),
        tasks: t('search.scope.tasks'),
        project_tasks: t('search.scope.projectTasks'),
    };
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
        setDuePreset('any');
        setScope('all');
        setIncludeCompleted(false);
        setIncludeReference(true);
    };
    const activeChips: Array<{ key: string; label: string; onPress: () => void }> = [];
    selectedStatuses.forEach((status) => {
        activeChips.push({
            key: `status:${status}`,
            label: t(`status.${status}`) || status,
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
    if (duePreset !== 'any') {
        activeChips.push({
            key: `due:${duePreset}`,
            label: `${t('taskEdit.dueDateLabel') || 'Due'}: ${dueLabels[duePreset]}`,
            onPress: () => setDuePreset('any'),
        });
    }
    if (scope !== 'all') {
        activeChips.push({
            key: `scope:${scope}`,
            label: scopeLabels[scope],
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
    if (includeReference) {
        activeChips.push({
            key: 'includeReference',
            label: t('search.includeReference'),
            onPress: () => setIncludeReference(false),
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
    const filtersActive = filtersOpen || activeChips.length > 0;
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
                    onPress={() => setFiltersOpen((prev) => !prev)}
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
            {filtersOpen && (
                <View style={[styles.filtersPanel, { borderColor: tc.border, backgroundColor: tc.cardBg }]}>
                    <View style={styles.filtersHeader}>
                        <Text style={[styles.filtersTitle, { color: tc.text }]}>{t('filters.label')}</Text>
                        {activeChips.length > 0 && (
                            <TouchableOpacity onPress={clearFilters}>
                                <Text style={[styles.clearFiltersText, { color: tc.tint }]}>{t('common.clear')}</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                    <ScrollView
                        style={styles.filtersScroll}
                        contentContainerStyle={styles.filtersContent}
                        showsVerticalScrollIndicator={false}
                    >
                        <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>
                            {t('taskEdit.statusLabel') || 'Status'}
                        </Text>
                        <View style={styles.chipRow}>
                            {statusOptions.map((status) =>
                                renderChip(
                                    t(`status.${status}`) || status,
                                    selectedStatuses.includes(status),
                                    () => toggleStatus(status)
                                )
                            )}
                        </View>

                        <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>
                            {t('search.scope.label') || 'Scope'}
                        </Text>
                        <View style={styles.chipRow}>
                            {(['all', 'projects', 'tasks', 'project_tasks'] as const).map((value) =>
                                renderChip(scopeLabels[value], scope === value, () => setScope(value))
                            )}
                        </View>

                        <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>
                            {t('taskEdit.areaLabel') || 'Area'}
                        </Text>
                        <View style={styles.chipRow}>
                            {renderChip(
                                `${t('common.all')} ${t('taskEdit.areaLabel') || 'Area'}`,
                                selectedArea === 'all',
                                () => setSelectedArea('all')
                            )}
                            {renderChip(
                                t('taskEdit.noAreaOption') || 'No Area',
                                selectedArea === 'none',
                                () => setSelectedArea('none')
                            )}
                            {areas.map((area) =>
                                renderChip(area.name, selectedArea === area.id, () => setSelectedArea(area.id))
                            )}
                        </View>

                        <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>
                            {t('filters.contexts') || 'Contexts & tags'}
                        </Text>
                        <View style={styles.chipRow}>
                            {allTokens.map((token) => renderChip(token, selectedTokens.includes(token), () => toggleToken(token)))}
                        </View>

                        <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>
                            {t('search.due.label') || 'Due date'}
                        </Text>
                        <View style={styles.chipRow}>
                            {(['any', 'overdue', 'today', 'tomorrow', 'this_week', 'next_week', 'none'] as const).map((value) =>
                                renderChip(dueLabels[value], duePreset === value, () => setDuePreset(value))
                            )}
                        </View>

                        <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>
                            {t('search.include.label') || 'Include'}
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
                        </View>
                    </ScrollView>
                </View>
            )}
            {trimmedQuery !== '' && isTruncated && (
                <Text style={[styles.helpText, { color: tc.secondaryText }]}>
                    {t('search.showingFirst')
                        .replace('{shown}', String(results.length))
                        .replace('{total}', String(totalResults))}
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

            <FlatList
                data={results}
                keyExtractor={(item) => `${item.type}-${item.item.id}`}
                contentContainerStyle={styles.listContent}
                keyboardShouldPersistTaps="handled"
                ListEmptyComponent={
                    trimmedQuery !== '' && !ftsLoading ? (
                        <View style={styles.emptyContainer}>
                            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                                {t('search.noResults')} {'"'}{trimmedQuery}{'"'}
                            </Text>
                        </View>
                    ) : null
                }
                renderItem={({ item }) => (
                    <TouchableOpacity
                        style={[styles.resultItem, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                        onPress={() => handleSelect(item)}
                    >
                        {item.type === 'project' ? (
                            <Folder size={24} color={tc.tint} />
                        ) : (
                            <CheckCircle size={24} color={tc.secondaryText} />
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
                        </View>
                        <ChevronRight size={20} color={tc.secondaryText} />
                    </TouchableOpacity>
                )}
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
        gap: 8,
    },
    filtersPanel: {
        marginHorizontal: 16,
        marginTop: 10,
        padding: 12,
        borderRadius: 12,
        borderWidth: 1,
        gap: 12,
    },
    filtersHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    filtersTitle: {
        fontSize: 14,
        fontWeight: '600',
    },
    clearFiltersText: {
        fontSize: 12,
        fontWeight: '600',
    },
    filtersScroll: {
        maxHeight: 280,
    },
    filtersContent: {
        gap: 12,
        paddingBottom: 4,
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

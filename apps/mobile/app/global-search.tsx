import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet, Modal } from 'react-native';
import { useTaskStore, Task, Project, searchAll, generateUUID, SavedSearch, getStorageAdapter } from '@mindwtr/core';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useLanguage } from '../contexts/language-context';
import { useRouter } from 'expo-router';
import { Search, X, Folder, CheckCircle, ChevronRight } from 'lucide-react-native';

export default function SearchScreen() {
    const { _allTasks, projects, settings, updateSettings, setHighlightTask } = useTaskStore();
    const tc = useThemeColors();
    const { t } = useLanguage();
    const router = useRouter();
  const [query, setQuery] = useState('');
  const [ftsResults, setFtsResults] = useState<{ tasks: Task[]; projects: Project[] } | null>(null);
    const [showSaveModal, setShowSaveModal] = useState(false);
    const [saveName, setSaveName] = useState('');
    const inputRef = useRef<TextInput>(null);

    useEffect(() => {
        // Auto-focus after mounting
        setTimeout(() => inputRef.current?.focus(), 100);
    }, []);

    const placeholderColor = tc.secondaryText;

  const trimmedQuery = query.trim();
  const shouldUseFts = trimmedQuery.length > 0 && !/\b\w+:/i.test(trimmedQuery);

  useEffect(() => {
    let cancelled = false;
    if (!shouldUseFts) {
      setFtsResults(null);
      return;
    }
    const adapter = getStorageAdapter();
    if (!adapter.searchAll) {
      setFtsResults(null);
      return;
    }
    adapter.searchAll(trimmedQuery)
      .then((results) => {
        if (!cancelled) setFtsResults(results);
      })
      .catch(() => {
        if (!cancelled) setFtsResults(null);
      });
    return () => {
      cancelled = true;
    };
  }, [trimmedQuery, shouldUseFts]);

  const { tasks: taskResults, projects: projectResults } = trimmedQuery === ''
    ? { tasks: [] as Task[], projects: [] as Project[] }
    : ftsResults ?? searchAll(_allTasks, projects, trimmedQuery);
    const totalResults = projectResults.length + taskResults.length;
    const results = trimmedQuery === '' ? [] : [
        ...projectResults.map(p => ({ type: 'project' as const, item: p })),
        ...taskResults.map(t => ({ type: 'task' as const, item: t })),
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

    const handleSelect = (result: { type: 'project' | 'task', item: Project | Task }) => {
        if (result.type === 'project') {
            // Navigate to Projects screen - communicating selection is tricky without Global State for UI
            // For now, just go to Projects screen
            router.push('/projects');
        } else {
            const task = result.item as Task;
            setHighlightTask(task.id);
            if (task.projectId) {
                router.push('/projects');
            } else {
                // Map status to route
                const status = task.status;
                if (status === 'inbox') router.push('/inbox');
                else if (status === 'next') router.push('/focus');
                else if (status === 'waiting') router.push('/waiting');
                else if (status === 'someday') router.push('/someday');
                else if (status === 'archived') router.push('/archived');
                else router.push('/focus');
            }
        }
    };

    return (
        <View style={[styles.container, { backgroundColor: tc.bg }]}>
            <View style={[styles.header, { borderBottomColor: tc.border }]}>
                <Search size={20} color={tc.secondaryText} style={styles.searchIcon} />
                <TextInput
                    ref={inputRef}
                    style={[styles.input, { color: tc.text }]}
                    placeholder={t('search.placeholder') || "Search..."}
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
            {trimmedQuery !== '' && isTruncated && (
                <Text style={[styles.helpText, { color: tc.secondaryText }]}>
                    {t('search.showingFirst')
                        .replace('{shown}', String(results.length))
                        .replace('{total}', String(totalResults))}
                </Text>
            )}

            <FlatList
                data={results}
                keyExtractor={(item) => `${item.type}-${item.item.id}`}
                contentContainerStyle={styles.listContent}
                keyboardShouldPersistTaps="handled"
                ListEmptyComponent={
                    trimmedQuery !== '' ? (
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
                                    : (item.item as Task).projectId
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
        </View>
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
    helpText: {
        fontSize: 12,
        paddingHorizontal: 16,
        paddingTop: 8,
    },
    searchIcon: {
        marginRight: 4,
    },
    input: {
        flex: 1,
        fontSize: 16,
        height: 40,
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

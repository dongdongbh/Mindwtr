import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
    getActiveMarkdownReferenceQuery,
    insertMarkdownReferenceAtQuery,
    searchMarkdownReferences,
    shallow,
    useTaskStore,
    type MarkdownReferenceSearchResult,
    type MarkdownSelection,
    type MarkdownToolbarResult,
} from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';

type MarkdownReferenceAutocompleteProps = {
    value: string;
    selection: MarkdownSelection;
    inputRef: React.RefObject<TextInput | null>;
    visible: boolean;
    onApplyResult: (result: MarkdownToolbarResult) => void;
    t: (key: string) => string;
    tc: ThemeColors;
};

const restoreInputSelection = (inputRef: React.RefObject<TextInput | null>, selection: MarkdownSelection) => {
    const applySelection = () => {
        inputRef.current?.focus();
        inputRef.current?.setNativeProps?.({ selection });
    };
    requestAnimationFrame(applySelection);
    setTimeout(applySelection, 40);
};

export function MarkdownReferenceAutocomplete({
    value,
    selection,
    inputRef,
    visible,
    onApplyResult,
    t,
    tc,
}: MarkdownReferenceAutocompleteProps) {
    const { tasks, projects } = useTaskStore((state) => ({
        tasks: state._allTasks,
        projects: state.projects,
    }), shallow);
    const activeQuery = React.useMemo(
        () => getActiveMarkdownReferenceQuery(value, selection),
        [selection.end, selection.start, value],
    );
    const suggestions = React.useMemo(
        () => (activeQuery ? searchMarkdownReferences(tasks, projects, activeQuery.query, 6) : []),
        [activeQuery, projects, tasks],
    );

    const taskLabel = (() => {
        const translated = t('taskEdit.tab.task');
        return translated === 'taskEdit.tab.task' ? 'Task' : translated;
    })();
    const projectLabel = (() => {
        const translated = t('taskEdit.projectLabel');
        return translated === 'taskEdit.projectLabel' ? 'Project' : translated;
    })();

    const applySuggestion = React.useCallback((suggestion: MarkdownReferenceSearchResult) => {
        if (!activeQuery) return;
        const next = insertMarkdownReferenceAtQuery(value, activeQuery, {
            entityType: suggestion.entityType,
            id: suggestion.id,
            label: suggestion.title,
        });
        onApplyResult(next);
        restoreInputSelection(inputRef, next.selection);
    }, [activeQuery, inputRef, onApplyResult, value]);

    if (!visible || !activeQuery || suggestions.length === 0) {
        return null;
    }

    return (
        <View style={[styles.container, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled style={styles.scroll}>
                {suggestions.map((suggestion, index) => {
                    const statusKey = `status.${suggestion.status}` as const;
                    const translatedStatus = t(statusKey);
                    const statusLabel = translatedStatus === statusKey ? suggestion.status : translatedStatus;
                    const typeLabel = suggestion.entityType === 'task' ? taskLabel : projectLabel;

                    return (
                        <Pressable
                            key={`${suggestion.entityType}:${suggestion.id}`}
                            style={[
                                styles.item,
                                index === suggestions.length - 1 ? styles.itemLast : null,
                                { borderBottomColor: tc.border },
                            ]}
                            onPress={() => applySuggestion(suggestion)}
                        >
                            <Text style={[styles.title, { color: tc.text }]} numberOfLines={1}>
                                {suggestion.title}
                            </Text>
                            <Text style={[styles.meta, { color: tc.secondaryText }]} numberOfLines={1}>
                                {typeLabel} • {statusLabel}
                            </Text>
                        </Pressable>
                    );
                })}
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        maxHeight: 220,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 12,
        overflow: 'hidden',
    },
    scroll: {
        maxHeight: 220,
    },
    item: {
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    itemLast: {
        borderBottomWidth: 0,
    },
    title: {
        fontSize: 14,
        fontWeight: '600',
    },
    meta: {
        fontSize: 12,
        marginTop: 2,
    },
});

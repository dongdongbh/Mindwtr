import React from 'react';
import { Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
    getActiveMarkdownReferenceQuery,
    insertMarkdownReferenceAtQuery,
    searchMarkdownReferences,
    shallow,
    tFallback,
    useTaskStore,
    type MarkdownReferenceSearchResult,
    type MarkdownSelection,
    type MarkdownToolbarResult,
} from '@mindwtr/core';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ThemeColors } from '@/hooks/use-theme-colors';

type MarkdownReferenceAutocompleteProps = {
    currentTaskId?: string;
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
    currentTaskId,
    value,
    selection,
    inputRef,
    visible,
    onApplyResult,
    t,
    tc,
}: MarkdownReferenceAutocompleteProps) {
    const insets = useSafeAreaInsets();
    const { tasks, projects } = useTaskStore((state) => ({
        tasks: state._allTasks,
        projects: state.projects,
    }), shallow);
    const activeQuery = React.useMemo(
        () => getActiveMarkdownReferenceQuery(value, selection),
        [selection.end, selection.start, value],
    );
    const suggestions = React.useMemo(
        () => (activeQuery
            ? searchMarkdownReferences(tasks, projects, activeQuery.query, 6, {
                excludeTaskIds: currentTaskId ? [currentTaskId] : undefined,
            })
            : []),
        [activeQuery, currentTaskId, projects, tasks],
    );

    const taskLabel = tFallback(t, 'taskEdit.tab.task', 'Task');
    const projectLabel = tFallback(t, 'taskEdit.projectLabel', 'Project');

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
        <Modal
            transparent
            visible
            animationType="fade"
            statusBarTranslucent
            onRequestClose={() => {
                inputRef.current?.blur();
                Keyboard.dismiss();
            }}
        >
            <Pressable
                style={styles.backdrop}
                onPress={() => {
                    inputRef.current?.blur();
                    Keyboard.dismiss();
                }}
            />
            <View pointerEvents="box-none" style={styles.root}>
                <View
                    style={[
                        styles.container,
                        {
                            backgroundColor: tc.cardBg,
                            borderColor: tc.border,
                            marginBottom: insets.bottom + 8,
                        },
                    ]}
                >
                    <View style={[styles.handle, { backgroundColor: tc.border }]} />
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
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'transparent',
    },
    root: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'flex-end',
        paddingHorizontal: 12,
    },
    container: {
        maxHeight: 320,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 18,
        overflow: 'hidden',
        shadowColor: '#000',
        shadowOpacity: 0.14,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 10 },
        elevation: 12,
    },
    handle: {
        alignSelf: 'center',
        width: 36,
        height: 4,
        borderRadius: 999,
        marginTop: 10,
        marginBottom: 6,
    },
    scroll: {
        maxHeight: 320,
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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { shallow, useTaskStore } from '@mindwtr/core';

import { useThemeColors } from '@/hooks/use-theme-colors';
import {
  DEFAULT_APPLE_SEARCH_FILTERS,
  runAppleSearchEvaluation,
  revalidateAppleSearchMatches,
  type AppleSearchFilters,
} from '@/lib/apple-search-evaluation';
import {
  cancelAppleTaskSearch,
  getAppleTaskSearchAvailability,
  type AppleTaskSearchAvailability,
  type AppleTaskSearchNativeMatch,
} from '@/modules/apple-task-search';

export type AppleSearchEvaluationProps = {

  onOpenTask: (taskId: string) => void;

  filters?: AppleSearchFilters;
};


export function AppleSearchEvaluation({
  onOpenTask,
  filters = DEFAULT_APPLE_SEARCH_FILTERS,
}: AppleSearchEvaluationProps) {
  const tc = useThemeColors();
  const { tasks, projects, areas } = useTaskStore((state) => ({
    tasks: state._allTasks,
    projects: state._allProjects,
    areas: state._allAreas,
  }), shallow);
  const [availability, setAvailability] = useState<AppleTaskSearchAvailability | null>(null);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<{
    query: string;
    nativeMatches: AppleTaskSearchNativeMatch[];
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeController = useRef<AbortController | null>(null);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const evaluation = useMemo(() => (
    candidates
      ? revalidateAppleSearchMatches({
          query: candidates.query,
          nativeMatches: candidates.nativeMatches,
          tasks,
          projects,
          areas,
          filters,
        })
      : null
  ), [areas, candidates, filters, projects, tasks]);
  const results = evaluation?.tasks ?? [];
  const droppedCount = evaluation
    ? evaluation.unavailableTaskIds.length + evaluation.filteredTaskIds.length
    : 0;

  useEffect(() => {
    let active = true;
    void getAppleTaskSearchAvailability().then((value) => {
      if (active) setAvailability(value);
    });
    return () => {
      active = false;
      activeController.current?.abort();
      void cancelAppleTaskSearch().catch(() => undefined);
    };
  }, []);

  const runSearch = async () => {
    const trimmed = query.trim();
    if (!trimmed || availability?.supported !== true) return;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    setRunning(true);
    setError(null);
    setCandidates(null);
    try {
      const runResult = await runAppleSearchEvaluation({
        query: trimmed,
        getCurrentState: () => {
          const state = useTaskStore.getState();
          return {
            tasks: state._allTasks,
            projects: state._allProjects,
            areas: state._allAreas,
            filters: filtersRef.current,
          };
        },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setCandidates({ query: trimmed, nativeMatches: runResult.nativeMatches });
    } catch (searchError) {
      if (searchError instanceof Error && searchError.name === 'AbortError') return;
      setError(searchError instanceof Error ? searchError.message : 'Search failed.');
    } finally {
      if (activeController.current === controller) {
        activeController.current = null;
        setRunning(false);
      }
    }
  };

  const cancelSearch = () => {
    activeController.current?.abort();
  };

  const openRevalidatedTask = (taskId: string) => {
    if (!candidates) return;
    const state = useTaskStore.getState();
    const latest = revalidateAppleSearchMatches({
      query: candidates.query,
      nativeMatches: candidates.nativeMatches,
      tasks: state._allTasks,
      projects: state._allProjects,
      areas: state._allAreas,
      filters: filtersRef.current,
    });
    if (latest.tasks.some((task) => task.id === taskId)) onOpenTask(taskId);
  };

  if (!__DEV__) return null;

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <Text style={[styles.title, { color: tc.text }]}>Apple task search evaluation</Text>
      <Text style={[styles.caption, { color: tc.secondaryText }]}>Development only. Results come from on-device Spotlight and are rechecked against current Mindwtr tasks.</Text>
      <TextInput
        accessibilityLabel="Natural language task query"
        autoCapitalize="sentences"
        editable={!running && availability?.supported === true}
        maxLength={500}
        onChangeText={setQuery}
        onSubmitEditing={() => void runSearch()}
        placeholder={availability?.supported === true ? 'Tasks about renewing my passport' : 'Apple task search unavailable'}
        placeholderTextColor={tc.secondaryText}
        returnKeyType="search"
        style={[styles.input, { borderColor: tc.border, color: tc.text }]}
        value={query}
      />
      <Pressable
        accessibilityRole="button"
        disabled={!running && (!query.trim() || availability?.supported !== true)}
        onPress={running ? cancelSearch : () => void runSearch()}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: tc.tint, opacity: !running && (!query.trim() || availability?.supported !== true) ? 0.45 : pressed ? 0.75 : 1 },
        ]}
      >
        <Text style={[styles.buttonText, { color: tc.onTint }]}>
          {running ? 'Cancel search' : 'Search indexed tasks'}
        </Text>
      </Pressable>
      {availability && !availability.supported ? (
        <Text style={[styles.message, { color: tc.secondaryText }]}>Unavailable: {availability.reason}</Text>
      ) : null}
      {error ? <Text style={[styles.message, { color: tc.danger }]}>{error}</Text> : null}
      {droppedCount > 0 ? (
        <Text style={[styles.message, { color: tc.secondaryText }]}>{droppedCount} stale or filtered match(es) omitted.</Text>
      ) : null}
      <ScrollView contentContainerStyle={styles.results} keyboardShouldPersistTaps="handled">
        {results.map((task) => (
          <Pressable
            accessibilityRole="button"
            key={task.id}
            onPress={() => openRevalidatedTask(task.id)}
            style={({ pressed }) => [styles.result, { borderColor: tc.border, opacity: pressed ? 0.7 : 1 }]}
          >
            <Text numberOfLines={2} style={[styles.resultTitle, { color: tc.text }]}>{task.title}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 12 },
  title: { fontSize: 22, fontWeight: '700' },
  caption: { fontSize: 14, lineHeight: 20 },
  input: { borderWidth: 1, borderRadius: 12, minHeight: 48, paddingHorizontal: 14, fontSize: 16 },
  button: { minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  buttonText: { fontSize: 16, fontWeight: '700' },
  message: { fontSize: 14, lineHeight: 20 },
  results: { gap: 8 },
  result: { borderWidth: 1, borderRadius: 12, padding: 14 },
  resultTitle: { fontSize: 16, fontWeight: '600' },
});

export default AppleSearchEvaluation;

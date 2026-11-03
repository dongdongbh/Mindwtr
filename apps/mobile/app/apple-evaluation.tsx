import React, { useCallback, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Redirect, Stack, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { isTaskVisible, useTaskStore } from '@mindwtr/core';

import { AppleSearchEvaluation } from '@/components/AppleSearchEvaluation';
import { AppleImageCaptureEvaluation } from '@/components/AppleImageCaptureEvaluation';
import { ApplePccEvaluation } from '@/components/ApplePccEvaluation';
import { isApplePccEvaluationEnabled } from '@/lib/apple-pcc-evaluation';
import { TaskEditModal } from '@/components/task-edit-modal';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useToast } from '@/contexts/toast-context';


export default function AppleEvaluationRoute() {
  if (!__DEV__ || Platform.OS !== 'ios') return <Redirect href="/inbox" />;
  return <AppleEvaluationScreen />;
}

function AppleEvaluationScreen() {
  const router = useRouter();
  const tc = useThemeColors();
  const { showToast } = useToast();
  const pccEnabled = isApplePccEvaluationEnabled();
  const [mode, setMode] = useState<'search' | 'image' | 'pcc'>('search');
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const editingTask = useTaskStore((state) => (
    editingTaskId ? state._tasksById.get(editingTaskId) ?? null : null
  ));
  const openTask = useCallback((id: string) => {
    const task = useTaskStore.getState()._tasksById.get(id);
    if (!task || !isTaskVisible(task)) {
      showToast({ message: 'This task is no longer available.', tone: 'warning' });
      return;
    }
    setEditingTaskId(id);
  }, [showToast]);
  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/inbox');
  }, [router]);

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: tc.bg }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Text style={[styles.title, { color: tc.text }]}>Apple evaluation</Text>
        <Pressable accessibilityRole="button" onPress={close} style={styles.button}>
          <Text style={{ color: tc.tint }}>Close</Text>
        </Pressable>
      </View>
      <View style={styles.tabs}>
        {(['search', 'image', ...(pccEnabled ? ['pcc' as const] : [])] as const).map((value) => (
          <Pressable
            key={value}
            accessibilityRole="tab"
            accessibilityState={{ selected: mode === value }}
            onPress={() => setMode(value)}
            style={[styles.button, { borderBottomWidth: mode === value ? 2 : 0, borderColor: tc.tint }]}
          >
            <Text style={{ color: mode === value ? tc.tint : tc.secondaryText }}>
              {value === 'search' ? 'Task search' : value === 'image' ? 'Image capture' : 'PCC comparison'}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.body}>
        {mode === 'search' ? (
          <AppleSearchEvaluation onOpenTask={openTask} />
        ) : mode === 'image' ? (
          <AppleImageCaptureEvaluation onClose={close} onSaved={openTask} />
        ) : pccEnabled ? (
          <ApplePccEvaluation />
        ) : null}
      </View>
      {editingTask && isTaskVisible(editingTask) && (
        <TaskEditModal
          visible
          task={editingTask}
          defaultTab="view"
          onClose={() => setEditingTaskId(null)}
          onSave={(id, updates) => useTaskStore.getState().updateTask(id, updates)}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  title: { fontSize: 20, fontWeight: '600' },
  tabs: { flexDirection: 'row', paddingHorizontal: 12 },
  button: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' },
  body: { flex: 1 },
});

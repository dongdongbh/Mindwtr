import { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';

import { useTaskStore, safeParseDate } from '@mindwtr/core';
import { TaskList } from '../../../components/task-list';
import { InboxProcessingModal } from '../../../components/inbox-processing-modal';
import { ErrorBoundary } from '../../../components/ErrorBoundary';

import { useLanguage } from '../../../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';

export default function InboxScreen() {
  const { tasks } = useTaskStore();
  const { t } = useLanguage();
  const tc = useThemeColors();
  const [showProcessing, setShowProcessing] = useState(false);

  const inboxTasks = useMemo(() => {
    const now = new Date();
    return tasks.filter(t => {
      if (t.deletedAt) return false;
      if (t.status !== 'inbox') return false;
      const start = safeParseDate(t.startTime);
      if (start && start > now) return false;
      return true;
    });
  }, [tasks]);

  const processButton = inboxTasks.length > 0 ? (
    <TouchableOpacity
      style={[styles.processHeaderButton, { backgroundColor: tc.tint }]}
      onPress={() => setShowProcessing(true)}
      accessibilityRole="button"
      accessibilityLabel={t('inbox.processButton')}
    >
      <Text style={styles.processHeaderButtonText}>
        ▷ {t('inbox.processButton')} ({inboxTasks.length})
      </Text>
    </TouchableOpacity>
  ) : null;

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <TaskList
        statusFilter="inbox"
        title={t('inbox.title')}
        showHeader={false}
        enableBulkActions={false}
        showSort={false}
        allowAdd={false}
        showQuickAddHelp={false}
        emptyText={t('inbox.emptyAddHint')}
        headerAccessory={processButton}
        defaultEditTab="task"
      />
      <ErrorBoundary>
        <InboxProcessingModal
          visible={showProcessing}
          onClose={() => setShowProcessing(false)}
        />
      </ErrorBoundary>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  processHeaderButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  processHeaderButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
});

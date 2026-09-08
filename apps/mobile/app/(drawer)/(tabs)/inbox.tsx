import { useMemo, useState } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { Brain, ListChecks } from 'lucide-react-native';

import { useTaskStore } from '@mindwtr/core';
import { TaskList, type TaskListGroupBy } from '../../../components/task-list';
import { InboxProcessingModal } from '../../../components/inbox-processing-modal';
import { ErrorBoundary } from '../../../components/ErrorBoundary';

import { useLanguage } from '../../../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useThemeTokens } from '@/hooks/use-theme-tokens';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { CompactText } from '@/components/compact-text';
import { useVisibleTaskContext } from '@/hooks/use-visible-tasks';
import { useQuickCapture } from '../../../contexts/quick-capture-context';
import { dismissMobileHint } from '@/lib/onboarding-hints';

export default function InboxScreen() {
  const settings = useTaskStore((state) => state.settings);
  const { t } = useLanguage();
  const tc = useThemeColors();
  const tokens = useThemeTokens();
  const filledButton = useFilledButtonColors();

  // Mid-emphasis, not filled: the capture FAB owns this screen's single
  // high-emphasis fill, so the process row sits one step below — tint wash +
  // tint border on classic themes, primaryContainer on M3. The label stays
  // `text` because tint-on-wash fails 4.5:1 contrast on the light and sepia
  // presets; the tint border and icon carry the call-to-action identity.
  const processButtonBg = tokens.isMaterial ? filledButton.backgroundColor : `${tc.tint}29`;
  const processButtonBorder = tokens.isMaterial ? 'transparent' : tc.tint;
  const processLabelColor = tokens.isMaterial ? (filledButton.textColor ?? tc.onTint) : tc.text;
  const processIconColor = tokens.isMaterial ? (filledButton.textColor ?? tc.onTint) : tc.tint;
  const { openQuickCapture } = useQuickCapture();
  const router = useRouter();
  const [showProcessing, setShowProcessing] = useState(false);
  const [groupBy, setGroupBy] = useState<TaskListGroupBy>('none');
  const { visibleTasks } = useVisibleTaskContext();

  // The same base set TaskList narrows below, so the Process count and the list
  // can only ever differ by the user's own filter chips.
  const inboxTasks = useMemo(
    () => visibleTasks.filter((task) => task.status === 'inbox'),
    [visibleTasks],
  );

  const defaultCaptureMethod = settings.gtd?.defaultCaptureMethod ?? 'text';
  const emptyHint = defaultCaptureMethod === 'audio'
    ? t('inbox.emptyAddHintVoice')
    : t('inbox.emptyAddHint');
  const emptyActionLabel = defaultCaptureMethod === 'audio'
    ? t('quickAdd.audioCaptureLabel')
    : t('nav.addTask');

  const hasInboxTasks = inboxTasks.length > 0;
  const processCount = inboxTasks.length > 99 ? '99+' : `${inboxTasks.length}`;

  // Mind Sweep (secondary, labeled) rides on the sort/filter row's empty right
  // side when there are tasks to process; deliberately neutral like the
  // sort/filter controls so the Process row below is the only accented action.
  // When the inbox is empty it is promoted to the full-width primary slot.
  const mindSweepPill = (
    <TouchableOpacity
      style={[styles.mindSweepPill, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
      onPress={() => router.push('/mind-sweep-modal')}
      accessibilityRole="button"
      accessibilityLabel={t('mindSweep.launchButton')}
    >
      <Brain size={18} color={tc.secondaryText} strokeWidth={2} />
      <CompactText
        style={[styles.mindSweepLabel, { color: tc.secondaryText }]}
        numberOfLines={2}
      >
        {t('mindSweep.launchButton')}
      </CompactText>
    </TouchableOpacity>
  );

  // Full-width primary action below the controls: Process Inbox when there is
  // something to clarify, otherwise the promoted Mind Sweep entry point.
  const primaryActionRow = (
    <>
    <View style={styles.actionRow}>
      {hasInboxTasks ? (
        <TouchableOpacity
          style={[styles.processButton, { backgroundColor: processButtonBg, borderColor: processButtonBorder }]}
          onPress={() => {
            void dismissMobileHint('inbox-project');
            setShowProcessing(true);
          }}
          accessibilityRole="button"
          accessibilityLabel={`${t('inbox.processButton')} (${inboxTasks.length})`}
        >
          <ListChecks size={18} color={processIconColor} strokeWidth={2.2} />
          <CompactText
            style={[styles.actionLabel, { color: processLabelColor }]}
            numberOfLines={2}
          >
            {t('inbox.processButton')} ({processCount})
          </CompactText>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={[styles.processButton, { backgroundColor: processButtonBg, borderColor: processButtonBorder }]}
          onPress={() => router.push('/mind-sweep-modal')}
          accessibilityRole="button"
          accessibilityLabel={t('mindSweep.launchButton')}
        >
          <Brain size={18} color={processIconColor} strokeWidth={2.2} />
          <CompactText
            style={[styles.actionLabel, { color: processLabelColor }]}
            numberOfLines={2}
          >
            {t('mindSweep.launchButton')}
          </CompactText>
        </TouchableOpacity>
      )}
    </View>
    </>
  );

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <TaskList
        statusFilter="inbox"
        title={t('inbox.title')}
        showHeader={false}
        enableBulkActions
        enableInboxBulkOrganize
        emptyText={t('inbox.empty')}
        emptyHint={emptyHint}
        emptyActionLabel={emptyActionLabel}
        onEmptyAction={() => openQuickCapture({ autoRecord: defaultCaptureMethod === 'audio' })}
        headerAccessory={hasInboxTasks ? mindSweepPill : undefined}
        groupBy={groupBy}
        onChangeGroupBy={setGroupBy}
        primaryActionRow={primaryActionRow}
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
  actionRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 8,
    paddingHorizontal: 16,
    // The toolbar row above ends at 6dp of padding; 6 more here separates the
    // process action from the list controls without orphaning it (#grouping).
    paddingTop: 6,
    paddingBottom: 10,
  },
  processButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  actionLabel: {
    flexShrink: 1,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  mindSweepPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
    borderWidth: 1,
  },
  mindSweepLabel: {
    flexShrink: 1,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
});

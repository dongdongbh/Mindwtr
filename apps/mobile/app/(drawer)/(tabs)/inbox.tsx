import { useMemo, useState } from 'react';
import { useStartupScreenReady } from '@/hooks/use-startup-screen-ready';
import { WidgetLaunchDestination } from '@/hooks/use-widget-launch';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { Brain, ListChecks } from 'lucide-react-native';

import { buildInboxScreenModel, isTaskVisibleInInbox, useTaskStore } from '@mindwtr/core';
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
  const onStartupLayout = useStartupScreenReady('inbox');
  const settings = useTaskStore((state) => state.settings);
  const tasks = useTaskStore((state) => state.tasks);
  const { t } = useLanguage();
  const tc = useThemeColors();
  const tokens = useThemeTokens();
  const filledButton = useFilledButtonColors();


  const processButtonBg = tokens.isMaterial ? filledButton.backgroundColor : `${tc.tint}29`;
  const processButtonBorder = tokens.isMaterial ? 'transparent' : tc.tint;
  const processLabelColor = tokens.isMaterial ? (filledButton.textColor ?? tc.onTint) : tc.text;
  const processIconColor = tokens.isMaterial ? (filledButton.textColor ?? tc.onTint) : tc.tint;
  const { openQuickCapture } = useQuickCapture();
  const router = useRouter();
  const [showProcessing, setShowProcessing] = useState(false);
  const [groupBy, setGroupBy] = useState<TaskListGroupBy>('none');
  const { projectById } = useVisibleTaskContext();


  const inboxTasks = useMemo(
    () => tasks.filter((task) => (
      task.status === 'inbox' && isTaskVisibleInInbox(task, { projectById })
    )),
    [projectById, tasks],
  );


  const screen = buildInboxScreenModel({ count: inboxTasks.length, settings, t });
  const inboxScopeHint = (
    <View style={styles.scopeHint}>
      <CompactText style={[styles.scopeHintText, { color: tc.secondaryText }]}>
        {screen.scopeLabel}
      </CompactText>
    </View>
  );


  const mindSweepPill = (
    <TouchableOpacity
      style={[styles.mindSweepPill, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
      onPress={() => router.push('/mind-sweep-modal')}
      accessibilityRole="button"
      accessibilityLabel={screen.mindSweep.label}
    >
      <Brain size={18} color={tc.secondaryText} strokeWidth={2} />
      <CompactText
        style={[styles.mindSweepLabel, { color: tc.secondaryText }]}
        numberOfLines={2}
      >
        {screen.mindSweep.label}
      </CompactText>
    </TouchableOpacity>
  );


  const primaryActionRow = (
    <>
    <View style={styles.actionRow}>
      {screen.process ? (
        <TouchableOpacity
          style={[styles.processButton, { backgroundColor: processButtonBg, borderColor: processButtonBorder }]}
          onPress={() => {
            void dismissMobileHint('inbox-project');
            setShowProcessing(true);
          }}
          accessibilityRole="button"
          accessibilityLabel={screen.process.accessibilityLabel}
        >
          <ListChecks size={18} color={processIconColor} strokeWidth={2.2} />
          <CompactText
            style={[styles.actionLabel, { color: processLabelColor }]}
            numberOfLines={2}
          >
            {screen.process.label}
          </CompactText>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={[styles.processButton, { backgroundColor: processButtonBg, borderColor: processButtonBorder }]}
          onPress={() => router.push('/mind-sweep-modal')}
          accessibilityRole="button"
          accessibilityLabel={screen.mindSweep.label}
        >
          <Brain size={18} color={processIconColor} strokeWidth={2.2} />
          <CompactText
            style={[styles.actionLabel, { color: processLabelColor }]}
            numberOfLines={2}
          >
            {screen.mindSweep.label}
          </CompactText>
        </TouchableOpacity>
      )}
    </View>
    </>
  );

  return (
    <View onLayout={onStartupLayout} style={[styles.container, { backgroundColor: tc.bg }]}>
      <WidgetLaunchDestination path="/inbox" />
      <TaskList
        statusFilter="inbox"
        title={screen.title}
        showHeader={false}
        enableBulkActions
        enableInboxBulkOrganize
        onEmptyAction={() => openQuickCapture({ autoRecord: screen.autoRecord })}
        headerAccessory={screen.mindSweep.placement === 'accessory' ? mindSweepPill : undefined}
        groupBy={groupBy}
        onChangeGroupBy={setGroupBy}
        primaryActionRow={primaryActionRow}
        listHeaderComponent={inboxScopeHint}
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


    paddingTop: 6,

    paddingBottom: 0,
  },
  scopeHint: {
    alignItems: 'flex-start',
    paddingHorizontal: 16,


    paddingTop: 0,
    paddingBottom: 8,
  },
  scopeHintText: {
    fontSize: 13,
    fontWeight: '600',
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

import React from 'react';
import { Text, View } from 'react-native';

import { styles } from '../inbox-processing-modal.styles';
import { InboxDateSelectorRow } from './InboxDateSelectorRow';
import type { ProcessInboxDateField } from '@mindwtr/core';
import type { ThemeColors } from '@/hooks/use-theme-colors';

type Props = {
  t: (key: string) => string;
  tc: ThemeColors;
  show: boolean;
  showStartDateField: boolean;
  showDueDateField: boolean;
  showReviewDateField: boolean;
  pendingStartDate: Date | null;
  setPendingStartDate: (v: Date | null) => void;
  pendingStartDateOnly: boolean;
  setPendingStartDateOnly: (v: boolean) => void;
  useDefaultStartTime: () => void;
  setShowStartDatePicker: (v: boolean) => void;
  pendingDueDate: Date | null;
  setPendingDueDate: (v: Date | null) => void;
  pendingDueDateOnly: boolean;
  setPendingDueDateOnly: (v: boolean) => void;
  setShowDueDatePicker: (v: boolean) => void;
  pendingReviewDate: Date | null;
  setPendingReviewDate: (v: Date | null) => void;
  pendingReviewDateOnly: boolean;
  setPendingReviewDateOnly: (v: boolean) => void;
  setShowReviewDatePicker: (v: boolean) => void;
  pendingTimes: Partial<Record<ProcessInboxDateField, string>>;
  openTimePicker: (field: ProcessInboxDateField) => void;
  defaultScheduleTime?: string | null;
  dateOnlyLabel: string;
};

export function InboxSchedulingSection({
  t,
  tc,
  show,
  showStartDateField,
  showDueDateField,
  showReviewDateField,
  pendingStartDate,
  setPendingStartDate,
  pendingStartDateOnly,
  setPendingStartDateOnly,
  useDefaultStartTime,
  setShowStartDatePicker,
  pendingDueDate,
  setPendingDueDate,
  pendingDueDateOnly,
  setPendingDueDateOnly,
  setShowDueDatePicker,
  pendingReviewDate,
  setPendingReviewDate,
  pendingReviewDateOnly,
  setPendingReviewDateOnly,
  setShowReviewDatePicker,
  pendingTimes,
  openTimePicker,
  defaultScheduleTime,
  dateOnlyLabel,
}: Props) {
  if (!show) return null;

  const sharedRowProps = {
    t,
    tc,
    defaultScheduleTime,
    dateOnlyLabel,
    notSetLabel: t('common.notSet'),
    clearLabel: t('common.clear'),
  };

  return (
    <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
      <Text style={[styles.stepQuestion, { color: tc.text }]}>
        {t('taskEdit.scheduling')}
      </Text>
      {showStartDateField && (
        <InboxDateSelectorRow
          {...sharedRowProps}
          label={t('taskEdit.startDateLabel')}
          value={pendingStartDate}
          onOpen={() => setShowStartDatePicker(true)}
          onClear={() => { setPendingStartDate(null); setPendingStartDateOnly(false); }}
          onQuickDateSelect={(date) => { setPendingStartDate(date); setPendingStartDateOnly(false); }}
          dateOnly={pendingStartDateOnly}
          onDateOnly={() => setPendingStartDateOnly(true)}
          onUseDefaultTime={useDefaultStartTime}
          time={pendingTimes.startTime}
          onOpenTime={() => openTimePicker('startTime')}
        />
      )}
      {showDueDateField && (
        <InboxDateSelectorRow
          {...sharedRowProps}
          label={t('taskEdit.dueDateLabel')}
          value={pendingDueDate}
          onOpen={() => setShowDueDatePicker(true)}
          onClear={() => { setPendingDueDate(null); setPendingDueDateOnly(false); }}
          onQuickDateSelect={(date) => { setPendingDueDate(date); setPendingDueDateOnly(false); }}
          dateOnly={pendingDueDateOnly}
          onDateOnly={() => setPendingDueDateOnly(true)}
          onUseDefaultTime={() => setPendingDueDateOnly(false)}
          time={pendingTimes.dueDate}
          onOpenTime={() => openTimePicker('dueDate')}
        />
      )}
      {showReviewDateField && (
        <InboxDateSelectorRow
          {...sharedRowProps}
          label={t('taskEdit.reviewDateLabel')}
          value={pendingReviewDate}
          onOpen={() => setShowReviewDatePicker(true)}
          onClear={() => { setPendingReviewDate(null); setPendingReviewDateOnly(false); }}
          onQuickDateSelect={(date) => { setPendingReviewDate(date); setPendingReviewDateOnly(false); }}
          dateOnly={pendingReviewDateOnly}
          onDateOnly={() => setPendingReviewDateOnly(true)}
          onUseDefaultTime={() => setPendingReviewDateOnly(false)}
          time={pendingTimes.reviewAt}
          onOpenTime={() => openTimePicker('reviewAt')}
        />
      )}
    </View>
  );
}

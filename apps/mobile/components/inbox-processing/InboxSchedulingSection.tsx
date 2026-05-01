import React from 'react';
import { Text, View } from 'react-native';

import { styles } from '../inbox-processing-modal.styles';
import { InboxDateSelectorRow } from './InboxDateSelectorRow';
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
  defaultScheduleTime,
  dateOnlyLabel,
}: Props) {
  if (!show) return null;

  const sharedRowProps = {
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
          dateOnly={pendingStartDateOnly}
          onDateOnly={() => setPendingStartDateOnly(true)}
          onUseDefaultTime={() => setPendingStartDateOnly(false)}
        />
      )}
      {showDueDateField && (
        <InboxDateSelectorRow
          {...sharedRowProps}
          label={t('taskEdit.dueDateLabel')}
          value={pendingDueDate}
          onOpen={() => setShowDueDatePicker(true)}
          onClear={() => { setPendingDueDate(null); setPendingDueDateOnly(false); }}
          dateOnly={pendingDueDateOnly}
          onDateOnly={() => setPendingDueDateOnly(true)}
          onUseDefaultTime={() => setPendingDueDateOnly(false)}
        />
      )}
      {showReviewDateField && (
        <InboxDateSelectorRow
          {...sharedRowProps}
          label={t('taskEdit.reviewDateLabel')}
          value={pendingReviewDate}
          onOpen={() => setShowReviewDatePicker(true)}
          onClear={() => { setPendingReviewDate(null); setPendingReviewDateOnly(false); }}
          dateOnly={pendingReviewDateOnly}
          onDateOnly={() => setPendingReviewDateOnly(true)}
          onUseDefaultTime={() => setPendingReviewDateOnly(false)}
        />
      )}
    </View>
  );
}

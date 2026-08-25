import React from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import { UserRound } from 'lucide-react-native';

import { styles } from '../inbox-processing-modal.styles';
import { InboxDateSelectorRow } from './InboxDateSelectorRow';
import { InboxSuggestionList } from './InboxSuggestionList';
import type { ThemeColors } from '@/hooks/use-theme-colors';

/** The delegate detail step: who, follow-up date, and the hand-off message. */
type Props = {
  t: (key: string) => string;
  tc: ThemeColors;
  delegateWho: string;
  setDelegateWho: (v: string) => void;
  delegateWhoSuggestions: string[];
  showReviewDateField: boolean;
  delegateFollowUpDate: Date | null;
  setDelegateFollowUpDate: (v: Date | null) => void;
  delegateFollowUpDateOnly: boolean;
  setDelegateFollowUpDateOnly: (v: boolean) => void;
  setShowDelegateDatePicker: (v: boolean) => void;
  handleSendDelegateRequest: () => void;
  defaultScheduleTime?: string | null;
  dateOnlyLabel: string;
};

export function InboxExecutionSection({
  t,
  tc,
  delegateWho,
  setDelegateWho,
  delegateWhoSuggestions,
  showReviewDateField,
  delegateFollowUpDate,
  setDelegateFollowUpDate,
  delegateFollowUpDateOnly,
  setDelegateFollowUpDateOnly,
  setShowDelegateDatePicker,
  handleSendDelegateRequest,
  defaultScheduleTime,
  dateOnlyLabel,
}: Props) {
  return (
    <View>
      <View style={styles.stepQuestionRow}>
        <UserRound size={20} color={tc.text} />
        <Text style={[styles.stepQuestion, styles.stepQuestionInline, { color: tc.text }]}>
          {t('process.delegateTitle')}
        </Text>
      </View>
      <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
        {t('process.delegateDesc')}
      </Text>
      <Text style={[styles.refineLabel, { color: tc.secondaryText }]}>{t('process.delegateWhoLabel')}</Text>
      <TextInput
        style={[styles.waitingInput, { borderColor: tc.border, color: tc.text }]}
        placeholder={t('process.delegateWhoPlaceholder')}
        placeholderTextColor={tc.secondaryText}
        value={delegateWho}
        onChangeText={setDelegateWho}
      />
      <InboxSuggestionList suggestions={delegateWhoSuggestions} onSelect={setDelegateWho} tc={tc} />
      {!showReviewDateField && (
        <InboxDateSelectorRow
          t={t}
          label={t('process.delegateFollowUpLabel')}
          value={delegateFollowUpDate}
          onOpen={() => setShowDelegateDatePicker(true)}
          onClear={() => { setDelegateFollowUpDate(null); setDelegateFollowUpDateOnly(false); }}
          onQuickDateSelect={(date) => { setDelegateFollowUpDate(date); setDelegateFollowUpDateOnly(false); }}
          dateOnly={delegateFollowUpDateOnly}
          onDateOnly={() => setDelegateFollowUpDateOnly(true)}
          onUseDefaultTime={() => setDelegateFollowUpDateOnly(false)}
          defaultScheduleTime={defaultScheduleTime}
          dateOnlyLabel={dateOnlyLabel}
          notSetLabel={t('common.notSet')}
          clearLabel={t('common.clear')}
          tc={tc}
        />
      )}
      <TouchableOpacity
        style={[styles.buttonSecondary, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
        onPress={handleSendDelegateRequest}
      >
        <Text style={[styles.buttonText, { color: tc.text }]}>{t('process.delegateSendRequest')}</Text>
      </TouchableOpacity>
    </View>
  );
}

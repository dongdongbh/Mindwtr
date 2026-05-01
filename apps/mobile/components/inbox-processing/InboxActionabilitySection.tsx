import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import { styles } from '../inbox-processing-modal.styles';
import { InboxDateSelectorRow } from './InboxDateSelectorRow';
import type { ThemeColors } from '@/hooks/use-theme-colors';

type ActionabilityChoice = 'actionable' | 'later' | 'trash' | 'someday' | 'reference';

type Props = {
  t: (key: string) => string;
  tc: ThemeColors;
  actionabilityChoice: ActionabilityChoice;
  setActionabilityChoice: (v: ActionabilityChoice) => void;
  referenceEnabled: boolean;
  laterLabel: string;
  laterHint: string;
  dateOnlyLabel: string;
  pendingStartDate: Date | null;
  setPendingStartDate: (v: Date | null) => void;
  pendingStartDateOnly: boolean;
  setPendingStartDateOnly: (v: boolean) => void;
  setShowStartDatePicker: (v: boolean) => void;
  defaultScheduleTime?: string | null;
};

export function InboxActionabilitySection({
  t,
  tc,
  actionabilityChoice,
  setActionabilityChoice,
  referenceEnabled,
  laterLabel,
  laterHint,
  dateOnlyLabel,
  pendingStartDate,
  setPendingStartDate,
  pendingStartDateOnly,
  setPendingStartDateOnly,
  setShowStartDatePicker,
  defaultScheduleTime,
}: Props) {
  return (
    <>
      <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
        <Text style={[styles.stepQuestion, { color: tc.text }]}>
          {t('inbox.isActionable')}
        </Text>
        <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
          {t('inbox.actionableHint')}
        </Text>
        <View style={styles.buttonColumn}>
          <TouchableOpacity
            style={[
              styles.bigButton,
              actionabilityChoice === 'actionable' ? styles.buttonPrimary : { backgroundColor: tc.border },
            ]}
            onPress={() => setActionabilityChoice('actionable')}
          >
            <Text style={[styles.bigButtonText, actionabilityChoice !== 'actionable' && { color: tc.text }]}>
              ✅ {t('inbox.yesActionable')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.bigButton,
              actionabilityChoice === 'later' ? styles.buttonPrimary : { backgroundColor: tc.border },
            ]}
            onPress={() => setActionabilityChoice('later')}
          >
            <Text style={[styles.bigButtonText, actionabilityChoice !== 'later' && { color: tc.text }]}>
              🕒 {laterLabel}
            </Text>
          </TouchableOpacity>
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.button, { backgroundColor: actionabilityChoice === 'trash' ? '#EF4444' : tc.border }]}
              onPress={() => setActionabilityChoice('trash')}
            >
              <Text style={[styles.buttonPrimaryText, actionabilityChoice !== 'trash' && { color: tc.text }]}>🗑️ {t('inbox.trash')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, { backgroundColor: actionabilityChoice === 'someday' ? '#8B5CF6' : tc.border }]}
              onPress={() => setActionabilityChoice('someday')}
            >
              <Text style={[styles.buttonPrimaryText, actionabilityChoice !== 'someday' && { color: tc.text }]}>💭 {t('inbox.someday')}</Text>
            </TouchableOpacity>
            {referenceEnabled && (
              <TouchableOpacity
                style={[styles.button, { backgroundColor: actionabilityChoice === 'reference' ? '#3B82F6' : tc.border }]}
                onPress={() => setActionabilityChoice('reference')}
              >
                <Text style={[styles.buttonPrimaryText, actionabilityChoice !== 'reference' && { color: tc.text }]}>📚 {t('nav.reference')}</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>

      {actionabilityChoice === 'later' && (
        <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
          <Text style={[styles.stepQuestion, { color: tc.text }]}>{laterLabel}</Text>
          <Text style={[styles.stepHint, { color: tc.secondaryText }]}>{laterHint}</Text>
          <InboxDateSelectorRow
            label={t('taskEdit.startDateLabel')}
            value={pendingStartDate}
            onOpen={() => setShowStartDatePicker(true)}
            onClear={() => { setPendingStartDate(null); setPendingStartDateOnly(false); }}
            dateOnly={pendingStartDateOnly}
            onDateOnly={() => setPendingStartDateOnly(true)}
            onUseDefaultTime={() => setPendingStartDateOnly(false)}
            defaultScheduleTime={defaultScheduleTime}
            dateOnlyLabel={dateOnlyLabel}
            notSetLabel={t('common.notSet')}
            clearLabel={t('common.clear')}
            tc={tc}
          />
        </View>
      )}
    </>
  );
}

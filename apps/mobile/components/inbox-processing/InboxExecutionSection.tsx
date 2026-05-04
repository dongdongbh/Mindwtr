import React from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';

import { styles } from '../inbox-processing-modal.styles';
import { InboxDateSelectorRow } from './InboxDateSelectorRow';
import type { ThemeColors } from '@/hooks/use-theme-colors';

type Props = {
  t: (key: string) => string;
  tc: ThemeColors;
  executionChoice: 'defer' | 'delegate';
  setExecutionChoice: (v: 'defer' | 'delegate') => void;
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
  executionChoice,
  setExecutionChoice,
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
    <>
      <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
        <Text style={[styles.stepQuestion, { color: tc.text }]}>
          {t('inbox.whoShouldDoIt')}
        </Text>
        <View style={styles.buttonColumn}>
          <TouchableOpacity
            style={[styles.bigButton, executionChoice === 'defer' ? styles.buttonPrimary : { backgroundColor: tc.border }]}
            onPress={() => setExecutionChoice('defer')}
          >
            <Text style={[styles.bigButtonText, executionChoice !== 'defer' && { color: tc.text }]}>
              📋 {t('inbox.illDoIt')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.bigButton, executionChoice === 'delegate' ? { backgroundColor: '#F59E0B' } : { backgroundColor: tc.border }]}
            onPress={() => setExecutionChoice('delegate')}
          >
            <Text style={[styles.bigButtonText, executionChoice !== 'delegate' && { color: tc.text }]}>
              👤 {t('inbox.delegate')}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {executionChoice === 'delegate' && (
        <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
          <Text style={[styles.stepQuestion, { color: tc.text }]}>
            👤 {t('process.delegateTitle')}
          </Text>
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
          {delegateWhoSuggestions.length > 0 && (
            <View style={[styles.tokenSuggestionsContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
              {delegateWhoSuggestions.map((name) => (
                <TouchableOpacity
                  key={name}
                  style={styles.tokenSuggestionChip}
                  onPress={() => setDelegateWho(name)}
                >
                  <Text style={[styles.tokenSuggestionText, { color: tc.text }]}>{name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {!showReviewDateField && (
            <InboxDateSelectorRow
              label={t('process.delegateFollowUpLabel')}
              value={delegateFollowUpDate}
              onOpen={() => setShowDelegateDatePicker(true)}
              onClear={() => { setDelegateFollowUpDate(null); setDelegateFollowUpDateOnly(false); }}
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
      )}
    </>
  );
}

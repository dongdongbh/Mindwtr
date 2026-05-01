import React from 'react';
import type { RefObject } from 'react';
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { styles } from '../inbox-processing-modal.styles';
import type { ThemeColors } from '@/hooks/use-theme-colors';

type Props = {
  t: (key: string) => string;
  tc: ThemeColors;
  titleInputRef: RefObject<TextInput>;
  processingTitle: string;
  setProcessingTitle: (v: string) => void;
  processingDescription: string;
  setProcessingDescription: (v: string) => void;
  processingTitleFocused: boolean;
  setProcessingTitleFocused: (v: boolean) => void;
  titleDirectionStyle: object;
  aiEnabled: boolean;
  isAIWorking: boolean;
  handleAIClarifyInbox: () => void;
  aiWorkingText: string;
};

export function InboxTitleSection({
  t,
  tc,
  titleInputRef,
  processingTitle,
  setProcessingTitle,
  processingDescription,
  setProcessingDescription,
  processingTitleFocused,
  setProcessingTitleFocused,
  titleDirectionStyle,
  aiEnabled,
  isAIWorking,
  handleAIClarifyInbox,
  aiWorkingText,
}: Props) {
  return (
    <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
      <Text style={[styles.stepQuestion, { color: tc.text }]}>
        {t('inbox.refineTitle')}
      </Text>
      <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
        {t('inbox.refineHint')}
      </Text>
      {aiEnabled && (
        <View style={styles.aiActionRow}>
          <TouchableOpacity
            style={[styles.aiActionButton, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
            onPress={handleAIClarifyInbox}
            disabled={isAIWorking}
            accessibilityState={{ disabled: isAIWorking, busy: isAIWorking }}
          >
            {isAIWorking && <ActivityIndicator size="small" color={tc.tint} />}
            <Text style={[styles.aiActionText, { color: tc.tint }]}>
              {isAIWorking ? aiWorkingText : t('taskEdit.aiClarify')}
            </Text>
          </TouchableOpacity>
        </View>
      )}
      <Text style={[styles.refineLabel, { color: tc.secondaryText }]}>{t('taskEdit.titleLabel')}</Text>
      <TextInput
        ref={titleInputRef}
        style={[styles.refineTitleInput, titleDirectionStyle, { borderColor: tc.border, color: tc.text, backgroundColor: tc.cardBg }]}
        value={processingTitle}
        onChangeText={setProcessingTitle}
        placeholder={t('taskEdit.titleLabel')}
        placeholderTextColor={tc.secondaryText}
        onFocus={() => setProcessingTitleFocused(true)}
        onBlur={() => setProcessingTitleFocused(false)}
        selection={processingTitleFocused ? undefined : { start: 0, end: 0 }}
      />
      <Text style={[styles.refineLabel, { color: tc.secondaryText }]}>{t('taskEdit.descriptionLabel')}</Text>
      <TextInput
        style={[styles.refineDescriptionInput, { borderColor: tc.border, color: tc.text, backgroundColor: tc.cardBg }]}
        value={processingDescription}
        onChangeText={setProcessingDescription}
        placeholder={t('taskEdit.descriptionPlaceholder')}
        placeholderTextColor={tc.secondaryText}
        multiline
        numberOfLines={4}
      />
    </View>
  );
}

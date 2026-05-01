import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import { styles } from '../inbox-processing-modal.styles';
import type { ThemeColors } from '@/hooks/use-theme-colors';

type Props = {
  t: (key: string) => string;
  tc: ThemeColors;
  twoMinuteChoice: 'yes' | 'no';
  setTwoMinuteChoice: (v: 'yes' | 'no') => void;
};

export function InboxTwoMinuteSection({ t, tc, twoMinuteChoice, setTwoMinuteChoice }: Props) {
  return (
    <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
      <Text style={[styles.stepQuestion, { color: tc.text }]}>
        ⏱️ {t('inbox.twoMinRule')}
      </Text>
      <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
        {t('inbox.twoMinHint')}
      </Text>
      <View style={styles.buttonColumn}>
        <TouchableOpacity
          style={[styles.bigButton, twoMinuteChoice === 'yes' ? styles.buttonSuccess : { backgroundColor: tc.border }]}
          onPress={() => setTwoMinuteChoice('yes')}
        >
          <Text style={[styles.bigButtonText, twoMinuteChoice !== 'yes' && { color: tc.text }]}>✅ {t('inbox.doneIt')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.bigButton, twoMinuteChoice === 'no' ? styles.buttonPrimary : { backgroundColor: tc.border }]}
          onPress={() => setTwoMinuteChoice('no')}
        >
          <Text style={[styles.bigButtonText, twoMinuteChoice !== 'no' && { color: tc.text }]}>
            {t('inbox.takesLonger')}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

import { View, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TaskList } from '../../components/task-list';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useLanguage } from '../../contexts/language-context';

export default function ReferenceScreen() {
  const tc = useThemeColors();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const title = t('nav.reference');
  const emptyLabel = t('reference.empty');
  const emptyText = emptyLabel === 'reference.empty' ? 'Nothing filed yet' : emptyLabel;
  const hintLabel = t('reference.emptyHint');
  const emptyHint = hintLabel === 'reference.emptyHint'
    ? 'Reference holds info you might want later — no action required.'
    : hintLabel;
  const navBarInset = Platform.OS === 'android' && insets.bottom >= 24 ? insets.bottom : 0;

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <TaskList
        statusFilter="reference"
        title={title === 'nav.reference' ? 'Reference' : title}
        emptyText={emptyText}
        emptyHint={emptyHint}
        allowAdd={false}
        showQuickAddHelp={false}
        contentPaddingBottom={navBarInset}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

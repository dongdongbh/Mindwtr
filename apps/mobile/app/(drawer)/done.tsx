import { View, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TaskList } from '../../components/task-list';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useLanguage } from '../../contexts/language-context';

export default function DoneScreen() {
  const tc = useThemeColors();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const title = t('nav.done') || t('list.done') || 'Done';
  const emptyLabel = t('list.done');
  const emptyText = emptyLabel === 'list.done' ? 'Done' : emptyLabel;
  const hintLabel = t('done.emptyHint');
  const emptyHint = hintLabel === 'done.emptyHint'
    ? 'Completed tasks land here — a running log of what you finished.'
    : hintLabel;
  const navBarInset = Platform.OS === 'android' && insets.bottom >= 24 ? insets.bottom : 0;

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <TaskList
        statusFilter="done"
        title={title}
        emptyText={emptyText}
        emptyHint={emptyHint}
        allowAdd={false}
        showQuickAddHelp={false}
        defaultEditTab="view"
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

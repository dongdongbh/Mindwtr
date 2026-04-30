import { View, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { translateWithFallback } from '@mindwtr/core';

import { TaskList } from '../../components/task-list';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useLanguage } from '../../contexts/language-context';

export default function ReferenceScreen() {
  const tc = useThemeColors();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const resolveText = (key: string, fallback: string) => {
    return translateWithFallback(t, key, fallback);
  };
  const title = resolveText('nav.reference', 'Reference');
  const emptyText = resolveText('reference.empty', 'Nothing filed yet');
  const emptyHint = resolveText('reference.emptyHint', 'Reference holds info you might want later — no action required.');
  const navBarInset = Platform.OS === 'android' && insets.bottom >= 24 ? insets.bottom : 0;

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <TaskList
        statusFilter="reference"
        title={title}
        emptyText={emptyText}
        emptyHint={emptyHint}
        allowAdd={false}
        showQuickAddHelp={false}
        showTimeEstimateFilters={false}
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

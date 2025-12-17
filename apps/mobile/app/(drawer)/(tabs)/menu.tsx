import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useTaskStore } from '@mindwtr/core';

import { useLanguage } from '../../../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { defaultListContentStyle, ListSectionHeader } from '@/components/list-layout';
import { IconSymbol } from '@/components/ui/icon-symbol';

function MenuRow({
  label,
  icon,
  onPress,
  tc,
  isLast,
}: {
  label: string;
  icon: Parameters<typeof IconSymbol>[0]['name'];
  onPress: () => void;
  tc: ReturnType<typeof useThemeColors>;
  isLast?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? tc.filterBg : 'transparent' },
        !isLast && { borderBottomWidth: 1, borderBottomColor: tc.border },
      ]}
    >
      <View style={styles.rowLeft}>
        <IconSymbol name={icon} size={18} color={tc.text} />
        <Text style={[styles.rowLabel, { color: tc.text }]} numberOfLines={1}>
          {label}
        </Text>
      </View>
      <IconSymbol name="chevron.right" size={18} color={tc.secondaryText} />
    </Pressable>
  );
}

export default function MenuScreen() {
  const router = useRouter();
  const { t } = useLanguage();
  const tc = useThemeColors();
  const { settings } = useTaskStore();

  const savedSearches = settings?.savedSearches ?? [];

  return (
    <ScrollView style={[styles.container, { backgroundColor: tc.bg }]} contentContainerStyle={defaultListContentStyle}>
      <ListSectionHeader title={t('nav.main')} tc={tc} />
      <View style={[styles.card, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
        <MenuRow label={t('nav.board')} icon="square.grid.2x2.fill" tc={tc} onPress={() => router.push('/board')} />
        <MenuRow label={t('nav.calendar')} icon="calendar" tc={tc} onPress={() => router.push('/calendar')} />
        <MenuRow label={t('nav.review')} icon="paperplane.fill" tc={tc} onPress={() => router.push('/review')} />
        <MenuRow label={t('nav.contexts')} icon="circle" tc={tc} onPress={() => router.push('/contexts')} />
        <MenuRow label={t('nav.waiting')} icon="pause.circle.fill" tc={tc} onPress={() => router.push('/waiting')} />
        <MenuRow label={t('nav.someday')} icon="arrow.up.circle.fill" tc={tc} onPress={() => router.push('/someday')} />
        <MenuRow label={t('nav.archived')} icon="checkmark.circle.fill" tc={tc} onPress={() => router.push('/archived')} />
        <MenuRow label={t('nav.settings')} icon="chevron.left.forwardslash.chevron.right" tc={tc} onPress={() => router.push('/settings')} isLast />
      </View>

      {savedSearches.length > 0 && (
        <>
          <ListSectionHeader title={t('search.savedSearches')} tc={tc} />
          <View style={[styles.card, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            {savedSearches.map((search, idx) => (
              <MenuRow
                key={search.id}
                label={search.name}
                icon="tray.fill"
                tc={tc}
                onPress={() => router.push(`/saved-search/${search.id}`)}
                isLast={idx === savedSearches.length - 1}
              />
            ))}
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  row: {
    paddingHorizontal: 14,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  rowLabel: {
    fontSize: 15,
    fontWeight: '600',
    flexShrink: 1,
  },
});

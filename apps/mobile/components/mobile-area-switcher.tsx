import { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Check, ChevronDown } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useLanguage } from '../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { AREA_FILTER_ALL, AREA_FILTER_NONE } from '@/lib/area-filter';

export function MobileAreaSwitcher() {
  const { t } = useLanguage();
  const tc = useThemeColors();
  const insets = useSafeAreaInsets();
  const { areaById, resolvedAreaFilter, setAreaFilter, sortedAreas } = useMobileAreaFilter();
  const [visible, setVisible] = useState(false);

  const currentLabel = useMemo(() => {
    if (resolvedAreaFilter === AREA_FILTER_ALL) return t('projects.allAreas');
    if (resolvedAreaFilter === AREA_FILTER_NONE) return t('projects.noArea');
    return areaById.get(resolvedAreaFilter)?.name ?? t('projects.allAreas');
  }, [areaById, resolvedAreaFilter, t]);
  const isDefaultScope = resolvedAreaFilter === AREA_FILTER_ALL;

  const options = useMemo(() => ([
    { id: AREA_FILTER_ALL, label: t('projects.allAreas') },
    { id: AREA_FILTER_NONE, label: t('projects.noArea') },
    ...sortedAreas.map((area) => ({ id: area.id, label: area.name })),
  ]), [sortedAreas, t]);

  const handleSelect = (value: string) => {
    setAreaFilter(value);
    setVisible(false);
  };

  return (
    <>
      <Pressable
        accessibilityLabel={`${t('projects.areaFilter')}: ${currentLabel}`}
        accessibilityRole="button"
        onPress={() => setVisible(true)}
        style={({ pressed }) => [
          styles.trigger,
          pressed ? styles.triggerPressed : null,
        ]}
      >
        <Text
          numberOfLines={1}
          style={[
            styles.triggerText,
            { color: isDefaultScope ? tc.secondaryText : tc.tint },
          ]}
        >
          {currentLabel}
        </Text>
        <ChevronDown color={isDefaultScope ? tc.secondaryText : tc.tint} size={13} strokeWidth={2.1} />
      </Pressable>

      <Modal
        animationType="fade"
        onRequestClose={() => setVisible(false)}
        transparent
        visible={visible}
      >
        <View style={styles.modalRoot}>
          <Pressable
            accessibilityLabel={t('common.close')}
            accessibilityRole="button"
            onPress={() => setVisible(false)}
            style={styles.backdrop}
          />
          <View
            style={[
              styles.sheet,
              {
                backgroundColor: tc.cardBg,
                borderColor: tc.border,
                paddingBottom: Math.max(20, insets.bottom + 12),
              },
            ]}
          >
            <Text style={[styles.sheetTitle, { color: tc.text }]}>
              {t('projects.areaFilter')}
            </Text>
            <ScrollView
              contentContainerStyle={styles.sheetContent}
              showsVerticalScrollIndicator={false}
            >
              {options.map((option) => {
                const isSelected = option.id === resolvedAreaFilter;
                return (
                  <TouchableOpacity
                    key={option.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => handleSelect(option.id)}
                    style={[
                      styles.optionRow,
                      {
                        backgroundColor: isSelected ? `${tc.tint}18` : tc.cardBg,
                        borderColor: isSelected ? tc.tint : tc.border,
                      },
                    ]}
                  >
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.optionText,
                        { color: isSelected ? tc.tint : tc.text },
                      ]}
                    >
                      {option.label}
                    </Text>
                    {isSelected ? <Check color={tc.tint} size={16} /> : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    maxWidth: 136,
    minHeight: 28,
    paddingHorizontal: 2,
    paddingVertical: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  triggerPressed: {
    opacity: 0.72,
  },
  triggerText: {
    flexShrink: 1,
    fontSize: 12,
    fontWeight: '500',
  },
  modalRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 16,
    paddingTop: 16,
    maxHeight: '70%',
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  sheetContent: {
    gap: 10,
    paddingBottom: 8,
  },
  optionRow: {
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    gap: 12,
  },
  optionText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
  },
});

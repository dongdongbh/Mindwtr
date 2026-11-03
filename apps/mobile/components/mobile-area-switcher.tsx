import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Check, ChevronDown, X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useLanguage } from '../contexts/language-context';
import { useToast } from '../contexts/toast-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { CompactText } from '@/components/compact-text';
import {
  AREA_FILTER_ALL,
  AREA_FILTER_NONE,
  areaFilterSelectionToValue,
  cycleAreaFilterSelection,
  isAreaFilterSelectionActive,
  tFallback,
} from '@mindwtr/core';

export function MobileAreaSwitcher() {
  const { t } = useLanguage();
  const { showToast } = useToast();
  const tc = useThemeColors();
  const insets = useSafeAreaInsets();
  const {
    areaById,
    didResetDeletedAreaFilter,
    resolvedAreaFilter,
    setAreaFilter,
    sortedAreas,
  } = useMobileAreaFilter();
  const [visible, setVisible] = useState(false);
  const staleFilterAlertShown = useRef(false);

  const isDefaultScope = !isAreaFilterSelectionActive(resolvedAreaFilter);

  const activeValue = areaFilterSelectionToValue(resolvedAreaFilter);
  const excludedLabel = tFallback(t, 'filters.excluded', 'Excluded');

  const areaName = useCallback((id: string) => (
    id === AREA_FILTER_NONE ? t('projects.noArea') : areaById.get(id)?.name ?? t('projects.noArea')
  ), [areaById, t]);


  const summaryLabel = useMemo(() => {
    if (isDefaultScope) return t('projects.allAreas');
    return [
      resolvedAreaFilter.included.map(areaName).join(', '),
      resolvedAreaFilter.excluded.length > 0
        ? `${excludedLabel}: ${resolvedAreaFilter.excluded.map(areaName).join(', ')}`
        : '',
    ].filter(Boolean).join(' · ');
  }, [areaName, excludedLabel, isDefaultScope, resolvedAreaFilter, t]);

  const currentLabel = useMemo(() => {
    if (isDefaultScope) return t('projects.allAreas');
    if (activeValue !== AREA_FILTER_ALL) return areaName(activeValue);


    const included = resolvedAreaFilter.included.length;
    const excluded = resolvedAreaFilter.excluded.length;
    return [included > 0 ? String(included) : '', excluded > 0 ? `−${excluded}` : '']
      .filter(Boolean)
      .join(' ');
  }, [activeValue, areaName, isDefaultScope, resolvedAreaFilter, t]);
  const triggerLabel = useMemo(() => {
    if (isDefaultScope) return t('common.all');
    if (activeValue === AREA_FILTER_NONE) return t('common.none');
    return currentLabel;
  }, [activeValue, currentLabel, isDefaultScope, t]);

  const options = useMemo(() => ([
    ...sortedAreas.map((area) => ({ id: area.id, label: area.name })),
    { id: AREA_FILTER_NONE, label: t('projects.noArea') },
  ]), [sortedAreas, t]);

  const handleToggle = (id: string) => {
    setAreaFilter(cycleAreaFilterSelection(resolvedAreaFilter, id));
  };

  useEffect(() => {
    if (!didResetDeletedAreaFilter) {
      staleFilterAlertShown.current = false;
      return;
    }
    if (staleFilterAlertShown.current) return;
    staleFilterAlertShown.current = true;
    showToast({
      title: t('projects.areaFilter'),
      message: t('projects.deletedAreaFilterResetAlert'),
      tone: 'info',
      durationMs: 4200,
    });
  }, [didResetDeletedAreaFilter, showToast, t]);

  return (
    <>
      <Pressable
        accessibilityLabel={`${t('projects.areaFilter')}: ${summaryLabel}`}
        accessibilityRole="button"
        onPress={() => setVisible(true)}
        style={({ pressed }) => [
          styles.trigger,
          pressed ? styles.triggerPressed : null,
        ]}
      >
        <CompactText
          numberOfLines={1}
          style={[
            styles.triggerText,
            { color: isDefaultScope ? tc.secondaryText : tc.tint },
          ]}
        >
          {triggerLabel}
        </CompactText>
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
            <Text style={[
              styles.sheetTitle,
              { color: tc.text },
              isDefaultScope ? null : styles.sheetTitleWithSummary,
            ]}>
              {t('projects.areaFilter')}
            </Text>
            {isDefaultScope ? null : (
              <Text numberOfLines={2} style={[styles.sheetSummary, { color: tc.secondaryText }]}>
                {summaryLabel}
              </Text>
            )}
            <ScrollView
              contentContainerStyle={styles.sheetContent}
              showsVerticalScrollIndicator={false}
            >
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityState={{ selected: isDefaultScope }}
                onPress={() => setAreaFilter({ included: [], excluded: [] })}
                style={[
                  styles.optionRow,
                  {
                    backgroundColor: isDefaultScope ? `${tc.tint}18` : tc.cardBg,
                    borderColor: isDefaultScope ? tc.tint : tc.border,
                  },
                ]}
              >
                <Text
                  numberOfLines={1}
                  ellipsizeMode="tail"
                  style={[styles.optionText, { color: isDefaultScope ? tc.tint : tc.text }]}
                >
                  {t('projects.allAreas')}
                </Text>
                {isDefaultScope ? <Check color={tc.tint} size={16} /> : null}
              </TouchableOpacity>
              {options.map((option) => {
                const isIncluded = resolvedAreaFilter.included.includes(option.id);
                const isExcluded = resolvedAreaFilter.excluded.includes(option.id);
                const tone = isExcluded ? tc.danger : isIncluded ? tc.tint : null;
                return (
                  <TouchableOpacity
                    key={option.id}
                    accessibilityLabel={isExcluded ? `${option.label} (${excludedLabel})` : option.label}


                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: isExcluded ? 'mixed' : isIncluded }}
                    onPress={() => handleToggle(option.id)}
                    style={[
                      styles.optionRow,
                      {
                        backgroundColor: tone ? `${tone}18` : tc.cardBg,
                        borderColor: tone ?? tc.border,
                      },
                    ]}
                  >
                    <Text
                      numberOfLines={1}
                      ellipsizeMode="tail"
                      style={[
                        styles.optionText,
                        { color: tone ?? tc.text },
                        isExcluded ? styles.optionTextExcluded : null,
                      ]}
                    >
                      {option.label}
                    </Text>
                    {isExcluded
                      ? <X color={tc.danger} size={16} />
                      : isIncluded ? <Check color={tc.tint} size={16} /> : null}
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
    maxWidth: 160,
    minHeight: 48,
    paddingHorizontal: 6,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  triggerPressed: {
    opacity: 0.72,
  },
  triggerText: {
    flexShrink: 1,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
    minWidth: 0,
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
  sheetTitleWithSummary: {
    marginBottom: 4,
  },
  sheetSummary: {
    fontSize: 13,
    lineHeight: 18,
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
  optionTextExcluded: {
    textDecorationLine: 'line-through',
  },
});

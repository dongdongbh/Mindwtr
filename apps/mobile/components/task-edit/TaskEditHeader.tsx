import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Modal, Pressable, StyleSheet } from 'react-native';
import { MoreHorizontal } from 'lucide-react-native';

import { AppPressable } from '../app-pressable';

import { useLanguage } from '../../contexts/language-context';
import { useReducedMotion } from '../../hooks/use-reduced-motion';
import { useThemeColors } from '../../hooks/use-theme-colors';

type TaskEditHeaderProps = {
  onDone: () => void;
  onShare: () => void;
  onDuplicate: () => void;
  onPromoteToProject?: () => void;
  onDelete: () => void;
  onConvertToReference?: () => void;
  showConvertToReference?: boolean;
  onConvertToSection?: () => void;
  showConvertToSection?: boolean;
  readOnly?: boolean;
};

export function TaskEditHeader({
  onDone,
  onShare,
  onDuplicate,
  onPromoteToProject,
  onDelete,
  onConvertToReference,
  showConvertToReference = false,
  onConvertToSection,
  showConvertToSection = false,
  readOnly = false,
}: TaskEditHeaderProps) {
  const { t } = useLanguage();
  const tc = useThemeColors();
  const reducedMotion = useReducedMotion();
  const [menuVisible, setMenuVisible] = useState(false);
  const createProjectFromTaskLabel = t('task.createProjectFromTask');
  const moreLabel = t('common.more');
  // "Save", not "Done": the button commits the draft, and "Done" reads as the
  // task status one line below it.
  const doneLabel = readOnly ? t('common.close') : t('common.save');

  return (
    <>
      <View style={[styles.header, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
        <View style={[styles.headerSide, styles.headerLeft]}>
          {!readOnly ? <TouchableOpacity
            style={[styles.headerActionTouchable, styles.headerActionLeft]}
            onPress={() => setMenuVisible(true)}
            accessibilityRole="button"
            accessibilityLabel={moreLabel}
            accessibilityState={{ expanded: menuVisible }}
          >
            <MoreHorizontal size={24} strokeWidth={2.25} color={tc.tint} accessible={false} />
          </TouchableOpacity> : null}
        </View>
        <View style={[styles.headerSide, styles.headerRight]}>
          <TouchableOpacity
            style={[styles.headerActionTouchable, styles.headerActionRight]}
            onPress={onDone}
            accessibilityRole="button"
            accessibilityLabel={doneLabel}
          >
            <Text style={[styles.headerBtn, { color: tc.tint }]}>{doneLabel}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {!readOnly && menuVisible ? (
        <Modal
          visible
          transparent
          animationType={reducedMotion ? 'none' : 'fade'}
          onRequestClose={() => setMenuVisible(false)}
        >
          <View style={styles.menuOverlay}>
            <Pressable
              style={styles.menuBackdrop}
              onPress={() => setMenuVisible(false)}
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
            />
            <View
              style={[styles.menuCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
              accessibilityViewIsModal
            >
              <AppPressable
                style={styles.menuItem}
                accessibilityRole="button"
                accessibilityLabel={t('common.share')}
                onPress={() => {
                  setMenuVisible(false);
                  onShare();
                }}
              >
                <Text style={[styles.menuItemText, { color: tc.text }]}>{t('common.share')}</Text>
              </AppPressable>
              <AppPressable
                style={styles.menuItem}
                accessibilityRole="button"
                accessibilityLabel={t('taskEdit.duplicateTask')}
                onPress={() => {
                  setMenuVisible(false);
                  onDuplicate();
                }}
              >
                <Text style={[styles.menuItemText, { color: tc.text }]}>{t('taskEdit.duplicateTask')}</Text>
              </AppPressable>
              {onPromoteToProject && (
                <AppPressable
                  style={styles.menuItem}
                  accessibilityRole="button"
                  accessibilityLabel={createProjectFromTaskLabel}
                  onPress={() => {
                    setMenuVisible(false);
                    onPromoteToProject();
                  }}
                >
                  <Text style={[styles.menuItemText, { color: tc.text }]}>{createProjectFromTaskLabel}</Text>
                </AppPressable>
              )}
              {showConvertToReference && onConvertToReference && (
                <AppPressable
                  style={styles.menuItem}
                  accessibilityRole="button"
                  accessibilityLabel={t('task.convertToReference')}
                  onPress={() => {
                    setMenuVisible(false);
                    onConvertToReference();
                  }}
                >
                  <Text style={[styles.menuItemText, { color: tc.text }]}>{t('task.convertToReference')}</Text>
                </AppPressable>
              )}
              {showConvertToSection && onConvertToSection && (
                <AppPressable
                  style={styles.menuItem}
                  accessibilityRole="button"
                  accessibilityLabel={t('task.convertToSection')}
                  onPress={() => {
                    setMenuVisible(false);
                    onConvertToSection();
                  }}
                >
                  <Text style={[styles.menuItemText, { color: tc.text }]}>{t('task.convertToSection')}</Text>
                </AppPressable>
              )}
              <AppPressable
                style={styles.menuItem}
                accessibilityRole="button"
                accessibilityLabel={t('common.delete')}
                onPress={() => {
                  setMenuVisible(false);
                  onDelete();
                }}
              >
                <Text style={[styles.menuItemText, { color: tc.danger }]}>{t('common.delete')}</Text>
              </AppPressable>
            </View>
          </View>
        </Modal>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    minHeight: 60,
  },
  headerBtn: {
    fontSize: 18,
    fontWeight: '700',
  },
  headerSide: {
    minWidth: 72,
  },
  headerLeft: {
    alignItems: 'flex-start',
  },
  headerRight: {
    alignItems: 'flex-end',
  },
  headerActionTouchable: {
    minWidth: 72,
    minHeight: 44,
    justifyContent: 'center',
  },
  headerActionLeft: {
    alignItems: 'flex-start',
  },
  headerActionRight: {
    alignItems: 'flex-end',
  },
  menuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  menuBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  menuCard: {
    width: 220,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 8,
    overflow: 'hidden',
  },
  menuItem: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  menuItemText: {
    fontSize: 14,
    fontWeight: '600',
  },
});

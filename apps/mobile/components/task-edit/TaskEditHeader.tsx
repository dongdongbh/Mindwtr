import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Modal, Pressable, ScrollView, StyleSheet } from 'react-native';
import { MoreHorizontal, X } from 'lucide-react-native';
import { tFallback } from '@mindwtr/core';

import { AppPressable } from '../app-pressable';

import { useToast } from '../../contexts/toast-context';
import { copyTaskReference } from '../../lib/task-reference-clipboard';

import { useLanguage } from '../../contexts/language-context';
import { useReducedMotion } from '../../hooks/use-reduced-motion';
import { useThemeColors } from '../../hooks/use-theme-colors';

type TaskEditHeaderProps = {
  onDone: () => void;
  onClose: () => void;
  onShare: () => void;
  onDuplicate: () => void;
  onPromoteToProject?: () => void;
  onCancelTask?: () => void;
  onSkipOccurrence?: () => void;
  cancelTaskLabel?: string;
  onDelete: () => void;
  onConvertToAction?: () => void;
  showConvertToAction?: boolean;
  onConvertToSection?: () => void;
  showConvertToSection?: boolean;
  readOnly?: boolean;
  taskId?: string;
};

export function TaskEditHeader({
  onDone,
  onClose,
  onShare,
  onDuplicate,
  onPromoteToProject,
  onCancelTask,
  onSkipOccurrence,
  cancelTaskLabel,
  onDelete,
  onConvertToAction,
  showConvertToAction = false,
  onConvertToSection,
  showConvertToSection = false,
  readOnly = false,
  taskId,
}: TaskEditHeaderProps) {
  const { t } = useLanguage();
  const { showToast } = useToast();
  const tc = useThemeColors();
  const reducedMotion = useReducedMotion();
  const [menuVisible, setMenuVisible] = useState(false);
  const createProjectFromTaskLabel = t('task.createProjectFromTask');
  const skipOccurrenceLabel = tFallback(t, 'task.skipOccurrence', 'Skip this occurrence');
  const moreLabel = t('common.more');
  const closeLabel = t('common.close');
  // "Save", not "Done": the button commits the draft, and "Done" reads as the
  // task status one line below it.
  const doneLabel = readOnly ? closeLabel : t('common.save');

  return (
    <>
      <View style={[styles.header, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
        <View style={[styles.headerSide, styles.headerLeft]}>
          {!readOnly || taskId ? (
            <View style={styles.headerLeftActions}>
              {!readOnly && <TouchableOpacity
                style={styles.closeAction}
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel={closeLabel}
              >
                <X size={22} strokeWidth={2.25} color={tc.tint} accessible={false} />
              </TouchableOpacity>}
              <TouchableOpacity
                style={styles.headerActionTouchable}
                onPress={() => setMenuVisible(true)}
                accessibilityRole="button"
                accessibilityLabel={moreLabel}
                accessibilityState={{ expanded: menuVisible }}
              >
                <MoreHorizontal size={24} strokeWidth={2.25} color={tc.tint} accessible={false} />
              </TouchableOpacity>
            </View>
          ) : null}
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

      {(!readOnly || taskId) && menuVisible ? (
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
              accessibilityLabel={closeLabel}
            />
            <View
              style={[styles.menuCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
              accessibilityViewIsModal
            >
              <ScrollView style={styles.menuScroll} keyboardShouldPersistTaps="handled">
                {taskId ? (['link', 'id'] as const).map((kind) => {
                  const label = kind === 'link'
                    ? tFallback(t, 'task.copyTaskLink', 'Copy task link')
                    : tFallback(t, 'task.copyTaskId', 'Copy task ID');
                  return (
                    <AppPressable
                      key={kind}
                      style={styles.menuItem}
                      accessibilityRole="button"
                      accessibilityLabel={label}
                      onPress={() => {
                        setMenuVisible(false);
                        void copyTaskReference(taskId, kind, t, showToast);
                      }}
                    >
                      <Text style={[styles.menuItemText, { color: tc.text }]}>{label}</Text>
                    </AppPressable>
                  );
                }) : null}
                {!readOnly && <>
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
                  {showConvertToAction && onConvertToAction && (
                    <AppPressable
                      style={styles.menuItem}
                      accessibilityRole="button"
                      accessibilityLabel={t('reference.convertToAction')}
                      onPress={() => {
                        setMenuVisible(false);
                        onConvertToAction();
                      }}
                    >
                      <Text style={[styles.menuItemText, { color: tc.text }]}>{t('reference.convertToAction')}</Text>
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
                  {onSkipOccurrence ? (
                    <AppPressable
                      style={styles.menuItem}
                      accessibilityRole="button"
                      accessibilityLabel={skipOccurrenceLabel}
                      onPress={() => {
                        setMenuVisible(false);
                        onSkipOccurrence();
                      }}
                    >
                      <Text style={[styles.menuItemText, { color: tc.text }]}>{skipOccurrenceLabel}</Text>
                    </AppPressable>
                  ) : null}
                  {onCancelTask && cancelTaskLabel ? (
                    <AppPressable
                      style={styles.menuItem}
                      accessibilityRole="button"
                      accessibilityLabel={cancelTaskLabel}
                      onPress={() => {
                        setMenuVisible(false);
                        onCancelTask();
                      }}
                    >
                      <Text style={[styles.menuItemText, { color: tc.danger }]}>{cancelTaskLabel}</Text>
                    </AppPressable>
                  ) : null}
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
                </>}
              </ScrollView>
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
  headerLeftActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 1,
  },
  closeAction: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  headerRight: {
    alignItems: 'flex-end',
  },
  headerActionTouchable: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
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
    maxHeight: '82%',
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 8,
    overflow: 'hidden',
  },
  menuScroll: {
    flexGrow: 0,
  },
  menuItem: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  menuItemText: {
    fontSize: 14,
    fontWeight: '600',
  },
});

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, Switch, Text, TouchableOpacity, View } from 'react-native';
import type { StoreActionResult, Task } from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';
import { logSettingsError } from '@/lib/settings-utils';
import {
  type AppleReminderList,
  getAppleReminderLists,
  importAppleRemindersIntoInbox,
  loadAppleRemindersImportSettings,
  requestAppleRemindersPermission,
  saveAppleRemindersImportSettings,
} from '@/lib/apple-reminders-import';
import { createMobileRecoverySnapshot } from '@/lib/data-transfer';

import { styles } from './settings.styles';

type SettingsTranslator = (key: string, values?: Record<string, string | number | boolean | null | undefined>) => string;

type ToastOptions = {
  title: string;
  message: string;
  tone: 'warning' | 'error' | 'success' | 'info';
  durationMs?: number;
};

type Props = {
  addTask: (title: string, initialProps?: Partial<Task>) => Promise<StoreActionResult>;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  showToast: (options: ToastOptions) => void;
  tr: SettingsTranslator;
  tc: ThemeColors;
};

export function AppleRemindersImportSection({
  addTask,
  disabled,
  onBusyChange,
  showToast,
  tr,
  tc,
}: Props) {
  const [selectedListId, setSelectedListId] = useState<string | undefined>();
  const [selectedListTitle, setSelectedListTitle] = useState<string | undefined>();
  const [deleteImportedReminders, setDeleteImportedReminders] = useState(false);
  const [lists, setLists] = useState<AppleReminderList[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loadingLists, setLoadingLists] = useState(false);
  const [loadingSettings, setLoadingSettings] = useState(Platform.OS === 'ios');
  const [savingSettings, setSavingSettings] = useState(false);
  const [importing, setImporting] = useState(false);
  const internalBusy = loadingLists || loadingSettings || savingSettings || importing;

  useEffect(() => {
    onBusyChange(internalBusy);
  }, [internalBusy, onBusyChange]);

  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    loadAppleRemindersImportSettings()
      .then((settings) => {
        setSelectedListId(settings.selectedListId);
        setSelectedListTitle(settings.selectedListTitle);
        setDeleteImportedReminders(settings.deleteImportedReminders);
      })
      .catch(logSettingsError)
      .finally(() => setLoadingSettings(false));
  }, []);

  const showWarning = useCallback((message: string) => {
    showToast({
      title: tr('settings.appleRemindersImport.appleReminders'),
      message,
      tone: 'warning',
      durationMs: 4200,
    });
  }, [showToast, tr]);

  const openListPicker = useCallback(async () => {
    if (disabled || internalBusy) return;
    setLoadingLists(true);
    try {
      const permission = await requestAppleRemindersPermission();
      if (permission !== 'granted') {
        showWarning(tr('settings.appleRemindersImport.permissionRequired'));
        return;
      }

      const nextLists = await getAppleReminderLists();
      setLists(nextLists);
      if (nextLists.length === 0) {
        showWarning(tr('settings.appleRemindersImport.noListsFound'));
        return;
      }
      setPickerOpen(true);
    } catch (error) {
      logSettingsError(error);
      showToast({
        title: tr('settings.backupMobile.importFailed'),
        message: String(error),
        tone: 'error',
        durationMs: 5200,
      });
    } finally {
      setLoadingLists(false);
    }
  }, [disabled, internalBusy, showToast, showWarning, tr]);

  const selectList = useCallback(async (list: AppleReminderList) => {
    if (disabled || internalBusy) return;
    setSavingSettings(true);
    try {
      const current = await loadAppleRemindersImportSettings();
      await saveAppleRemindersImportSettings({
        ...current,
        selectedListId: list.id,
        selectedListTitle: list.title,
      });
      setSelectedListId(list.id);
      setSelectedListTitle(list.title);
      setPickerOpen(false);
    } catch (error) {
      logSettingsError(error);
      showToast({
        title: tr('settings.syncMobile.error'),
        message: String(error),
        tone: 'error',
        durationMs: 5200,
      });
    } finally {
      setSavingSettings(false);
    }
  }, [disabled, internalBusy, showToast, tr]);

  const handleDeleteImportedRemindersChange = useCallback(async (value: boolean) => {
    if (disabled || internalBusy) return;
    setSavingSettings(true);
    try {
      const current = await loadAppleRemindersImportSettings();
      await saveAppleRemindersImportSettings({
        ...current,
        deleteImportedReminders: value,
      });
      setDeleteImportedReminders(value);
    } catch (error) {
      logSettingsError(error);
      showToast({
        title: tr('settings.syncMobile.error'),
        message: String(error),
        tone: 'error',
        durationMs: 5200,
      });
    } finally {
      setSavingSettings(false);
    }
  }, [disabled, internalBusy, showToast, tr]);

  const importReminders = useCallback(async () => {
    if (disabled || internalBusy) return;
    if (!selectedListId) {
      await openListPicker();
      return;
    }

    setImporting(true);
    try {
      const result = await importAppleRemindersIntoInbox({
        addTask,
        createRecoverySnapshot: createMobileRecoverySnapshot,
        listId: selectedListId,
        listTitle: selectedListTitle,
        deleteImportedReminders,
      });
      const skippedCount = result.skippedDuplicateCount + result.skippedCompletedCount + result.skippedEmptyTitleCount;
      const details = [
        tr('settings.appleRemindersImport.importedCount', { taskCount: result.importedCount }),
        skippedCount > 0
          ? tr('settings.appleRemindersImport.skippedCount', { taskCount: skippedCount })
          : null,
        result.deletedCount > 0
          ? tr('settings.appleRemindersImport.deletedCount', { taskCount: result.deletedCount })
          : null,
        result.deleteFailedCount > 0
          ? tr('settings.appleRemindersImport.deleteFailedCount', { taskCount: result.deleteFailedCount })
          : null,
        result.failedCount > 0
          ? tr('settings.appleRemindersImport.failedCount', { taskCount: result.failedCount })
          : null,
      ].filter(Boolean).join('\n');

      showToast({
        title: result.importedCount > 0
          ? tr('settings.backupMobile.importComplete')
          : tr('settings.appleRemindersImport.nothingNew'),
        message: details,
        tone: result.failedCount > 0 || result.deleteFailedCount > 0 ? 'warning' : 'success',
        durationMs: 5200,
      });
    } catch (error) {
      logSettingsError(error);
      showToast({
        title: tr('settings.backupMobile.importFailed'),
        message: String(error),
        tone: 'error',
        durationMs: 5200,
      });
    } finally {
      setImporting(false);
    }
  }, [addTask, deleteImportedReminders, disabled, internalBusy, openListPicker, selectedListId, selectedListTitle, showToast, tr]);

  if (Platform.OS !== 'ios') return null;

  const busy = disabled || internalBusy;

  return (
    <>
      <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 24 }]}>
        {tr('settings.appleRemindersImport.appleReminders')}
      </Text>
      <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
        <TouchableOpacity
          accessibilityRole="button"
          disabled={busy}
          onPress={openListPicker}
          style={styles.settingRow}
          testID="apple-reminders-list-row"
        >
          <View style={styles.settingInfo}>
            <Text style={[styles.settingLabel, { color: tc.text }]}>
              {tr('settings.appleRemindersImport.captureList')}
            </Text>
            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
              {selectedListTitle ?? tr('settings.appleRemindersImport.chooseCaptureList')}
            </Text>
          </View>
          {loadingLists ? (
            <ActivityIndicator size="small" color={tc.tint} />
          ) : (
            <Text style={[styles.chevron, { color: tc.secondaryText }]}>›</Text>
          )}
        </TouchableOpacity>
        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
          <View style={styles.settingInfo}>
            <Text style={[styles.settingLabel, { color: tc.text }]}>
              {tr('settings.appleRemindersImport.deleteAfterImport')}
            </Text>
            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
              {tr('settings.appleRemindersImport.deleteAfterImportDescription')}
            </Text>
          </View>
          <Switch
            disabled={busy}
            onValueChange={(value) => void handleDeleteImportedRemindersChange(value)}
            trackColor={{ false: '#767577', true: '#3B82F6' }}
            value={deleteImportedReminders}
          />
        </View>
        <TouchableOpacity
          accessibilityRole="button"
          disabled={busy}
          onPress={() => void importReminders()}
          style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
          testID="apple-reminders-import-row"
        >
          <View style={styles.settingInfo}>
            <Text style={[styles.settingLabel, { color: tc.tint }]}>
              {tr('settings.appleRemindersImport.importIncomplete')}
            </Text>
            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
              {deleteImportedReminders
                ? tr('settings.appleRemindersImport.importIncompleteDeleteDescription')
                : tr('settings.appleRemindersImport.importIncompleteDescription')}
            </Text>
          </View>
          {importing && <ActivityIndicator size="small" color={tc.tint} />}
        </TouchableOpacity>
      </View>
      <Modal
        animationType="fade"
        onRequestClose={() => setPickerOpen(false)}
        transparent
        visible={pickerOpen}
      >
        <Pressable style={styles.pickerOverlay} onPress={() => setPickerOpen(false)}>
          <Pressable style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[styles.pickerTitle, { color: tc.text }]}>
              {tr('settings.appleRemindersImport.chooseCaptureList')}
            </Text>
            <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
              {lists.map((list) => (
                <TouchableOpacity
                  key={list.id}
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void selectList(list)}
                  style={[
                    styles.pickerOption,
                    {
                      backgroundColor: list.id === selectedListId ? tc.filterBg : 'transparent',
                      borderColor: list.id === selectedListId ? tc.tint : tc.border,
                    },
                  ]}
                  testID={`apple-reminders-list-option-${list.id}`}
                >
                  <Text style={[styles.pickerOptionText, { color: tc.text }]}>{list.title}</Text>
                  {list.id === selectedListId && (
                    <Text style={[styles.pickerOptionText, { color: tc.tint }]}>
                      {tr('settings.appleRemindersImport.selected')}
                    </Text>
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

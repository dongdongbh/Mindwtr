import React, { useCallback, useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Modal, Pressable, ScrollView, Switch, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
    buildGeneralSettingsModel,
    buildGeneralSettingsUpdate,
    createDateFormatter,
    isGeneralSettingStored,
    normalizeWeekStartSetting,
    shallow,
    useTaskStore,
    type GeneralSettingsEdit,
} from '@mindwtr/core';

import { useTheme } from '@/contexts/theme-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { isAppSearchSupported, readAppSearchIndexingEnabled, writeAppSearchIndexingEnabled } from '@/lib/app-search-preference';
import { enableAppSearchIndexing, wipeAppSearchIndex } from '@/lib/app-search-service';
import { authenticateWithDeviceLock, getMobileAppLockErrorKey } from '@/lib/mobile-app-lock';
import { getSystemDateFormat } from '@/modules/system-date-format';

import { SettingRow, SettingToggleRow } from './setting-row';
import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsTopBar } from './settings.shell';
import { styles } from './settings.styles';

export function GeneralSettingsScreen() {
    const { themeMode, setThemeMode } = useTheme();
    const { language, tr, setLanguage, t } = useSettingsLocalization();
    const { settings, updateSettings } = useTaskStore((state) => ({
        settings: state.settings,
        updateSettings: state.updateSettings,
    }), shallow);
    const tc = useThemeColors();
    const scrollContentStyle = useSettingsScrollContent();
    const [themePickerOpen, setThemePickerOpen] = useState(false);
    const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
    const [weekStartPickerOpen, setWeekStartPickerOpen] = useState(false);
    const [dateFormatPickerOpen, setDateFormatPickerOpen] = useState(false);
    const [calendarSystemPickerOpen, setCalendarSystemPickerOpen] = useState(false);
    const [timeFormatPickerOpen, setTimeFormatPickerOpen] = useState(false);
    const [regionalFormatsOpen, setRegionalFormatsOpen] = useState(false);
    const [quickAccessPickerOpen, setQuickAccessPickerOpen] = useState(false);
    const [relockDelayPickerOpen, setRelockDelayPickerOpen] = useState(false);
    const [appLockBusy, setAppLockBusy] = useState(false);
    const [appLockErrorKey, setAppLockErrorKey] = useState<string | null>(null);

    const systemLocale = typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function'
        ? Intl.DateTimeFormat().resolvedOptions().locale
        : '';
    // Device-local Android integration (#1017): whether this device's active
    // tasks/projects/areas are mirrored into Android's system-search index.
    const [appSearchEnabled, setAppSearchEnabled] = useState(false);
    // Every control's options, labels and writes come from core's General model,
    // shared with the native host. The device's locale fills the "System default" labels.
    const model = buildGeneralSettingsModel({
        settings,
        themeMode,
        language,
        systemLocale,
        systemWeekStart: normalizeWeekStartSetting('system'),
        systemDateSample: createDateFormatter({
            language, systemLocale, calendarSystem: settings.calendarSystem,
            dateFormat: 'system', systemDateFormat: getSystemDateFormat(),
        })(new Date(), 'P'),
        appSearch: { supported: isAppSearchSupported(), enabled: appSearchEnabled },
        t,
    });
    const { appearance, privacy, regional } = model;
    // Re-picking the stored value writes nothing, as the native host's contract:
    // a repeat write would stamp the synced settings as newer than they are.
    const writeSetting = (edit: GeneralSettingsEdit) => {
        const update = buildGeneralSettingsUpdate(settings, edit);
        if (update && !isGeneralSettingStored(settings, edit)) updateSettings(update).catch(console.error);
    };
    const { enablePrompt } = privacy.appLock;
    const handleAppLockToggle = useCallback((value: boolean) => {
        setAppLockErrorKey(null);
        if (!value) {
            updateSettings(buildGeneralSettingsUpdate(settings, { type: 'appLock', value: false })!).catch(console.error);
            return;
        }

        if (appLockBusy) return;
        setAppLockBusy(true);
        authenticateWithDeviceLock(enablePrompt)
            .then((result) => {
                if (!result.success) {
                    setAppLockErrorKey(getMobileAppLockErrorKey(result.reason));
                    return;
                }
                updateSettings(buildGeneralSettingsUpdate(settings, { type: 'appLock', value: true })!).catch(console.error);
            })
            .catch(() => setAppLockErrorKey('appLock.failed'))
            .finally(() => setAppLockBusy(false));
    }, [appLockBusy, enablePrompt, settings, updateSettings]);
    const appLockError = appLockErrorKey ? tr(appLockErrorKey) : null;

    useEffect(() => {
        if (!isAppSearchSupported()) return;
        readAppSearchIndexingEnabled().then(setAppSearchEnabled).catch(console.error);
    }, []);
    const handleAppSearchToggle = useCallback((value: boolean) => {
        setAppSearchEnabled(value);
        writeAppSearchIndexingEnabled(value).catch(console.error);
        if (value) {
            // enableAppSearchIndexing re-reads the preference after its
            // reindex finishes, so a quick toggle-off mid-flight wins
            // instead of resurrecting documents and re-arming after OFF.
            enableAppSearchIndexing().catch(console.error);
        } else {
            wipeAppSearchIndex().catch(console.error);
        }
    }, []);

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar title={model.title} />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                <Text style={[styles.sectionTitle, { color: tc.secondaryText }]}>{appearance.title}</Text>
                <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                    <SettingRow
                        onPress={() => setThemePickerOpen(true)}
                        label={appearance.theme.label}
                        description={appearance.theme.value}
                    >
                        <Ionicons color={tc.secondaryText} name="chevron-down" size={18} />
                    </SettingRow>
                    <SettingToggleRow
                        divider
                        label={appearance.showTaskAge.label}
                        description={appearance.showTaskAge.description}
                        value={appearance.showTaskAge.value}
                        onChange={(value) => writeSetting({ type: 'showTaskAge', value })}
                        trackColor={{ false: tc.secondaryText, true: tc.tint }}
                    />
                    <SettingRow
                        divider
                        onPress={() => setQuickAccessPickerOpen(true)}
                        label={appearance.quickAccess.label}
                        description={appearance.quickAccess.value}
                    >
                        <Ionicons color={tc.secondaryText} name="chevron-down" size={18} />
                    </SettingRow>
                </View>

                <Text style={[styles.sectionTitle, { color: tc.secondaryText, marginTop: 16 }]}>{privacy.title}</Text>
                <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                    <View style={styles.settingRow}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{privacy.appLock.label}</Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                {privacy.appLock.description}
                            </Text>
                            {appLockError && (
                                <Text style={[styles.settingDescription, { color: tc.danger, marginTop: 6 }]}>
                                    {appLockError}
                                </Text>
                            )}
                        </View>
                        <Switch
                            disabled={appLockBusy}
                            value={privacy.appLock.value}
                            onValueChange={handleAppLockToggle}
                            trackColor={{ false: tc.secondaryText, true: tc.tint }}
                        />
                    </View>

                    {privacy.appLockRelockDelay && (
                        <SettingRow
                            divider
                            onPress={() => setRelockDelayPickerOpen(true)}
                            label={privacy.appLockRelockDelay.label}
                            description={privacy.appLockRelockDelay.value}
                        >
                            <Ionicons color={tc.secondaryText} name="chevron-down" size={18} />
                        </SettingRow>
                    )}

                    {privacy.appSearch && (
                        <SettingToggleRow
                            divider
                            label={privacy.appSearch.label}
                            description={privacy.appSearch.description}
                            value={privacy.appSearch.value}
                            onChange={handleAppSearchToggle}
                            trackColor={{ false: tc.secondaryText, true: tc.tint }}
                        />
                    )}
                </View>

                {privacy.appLockRelockDelay && (
                    <Modal
                        transparent
                        visible={relockDelayPickerOpen}
                        animationType="fade"
                        onRequestClose={() => setRelockDelayPickerOpen(false)}
                    >
                        <Pressable style={styles.pickerOverlay} onPress={() => setRelockDelayPickerOpen(false)}>
                            <View
                                style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                onStartShouldSetResponder={() => true}
                            >
                                <Text style={[styles.pickerTitle, { color: tc.text }]}>{privacy.appLockRelockDelay.pickerTitle}</Text>
                                <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                    {privacy.appLockRelockDelay.options.map((option) => {
                                        const { selected } = option;
                                        return (
                                            <TouchableOpacity
                                                key={option.value}
                                                accessibilityRole="radio"
                                                accessibilityState={{ selected }}
                                                style={[
                                                    styles.pickerOption,
                                                    { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                                ]}
                                                onPress={() => {
                                                    writeSetting(option.edit);
                                                    setRelockDelayPickerOpen(false);
                                                }}
                                            >
                                                <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                    {option.label}
                                                </Text>
                                                {selected && <Ionicons color={tc.tint} name="checkmark" size={18} />}
                                            </TouchableOpacity>
                                        );
                                    })}
                                </ScrollView>
                            </View>
                        </Pressable>
                    </Modal>
                )}

                <Modal
                    transparent
                    visible={themePickerOpen}
                    animationType="fade"
                    onRequestClose={() => setThemePickerOpen(false)}
                >
                    <Pressable style={styles.pickerOverlay} onPress={() => setThemePickerOpen(false)}>
                        <View
                            style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                            onStartShouldSetResponder={() => true}
                        >
                            <Text style={[styles.pickerTitle, { color: tc.text }]}>{appearance.theme.pickerTitle}</Text>
                            <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                {appearance.theme.groups.flat().map((option, index) => {
                                    const { selected } = option;
                                    const startsStyledThemes = index === appearance.theme.groups[0].length;
                                    return (
                                        <React.Fragment key={option.value}>
                                            {startsStyledThemes && (
                                                <View style={{ borderTopWidth: 1, borderTopColor: tc.border, marginVertical: 8 }} />
                                            )}
                                            <TouchableOpacity
                                                accessibilityRole="radio"
                                                accessibilityState={{ selected }}
                                                style={[
                                                    styles.pickerOption,
                                                    { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                                ]}
                                                onPress={() => {
                                                    setThemeMode(option.value);
                                                    writeSetting(option.edit);
                                                    setThemePickerOpen(false);
                                                }}
                                            >
                                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}>
                                                    <View
                                                        style={{
                                                            width: 32,
                                                            height: 32,
                                                            borderRadius: 16,
                                                            alignItems: 'center',
                                                            justifyContent: 'center',
                                                            backgroundColor: tc.filterBg,
                                                            borderWidth: 1,
                                                            borderColor: selected ? tc.tint : tc.border,
                                                        }}
                                                    >
                                                        <Ionicons
                                                            color={selected ? tc.tint : tc.secondaryText}
                                                            name={option.icon}
                                                            size={17}
                                                        />
                                                    </View>
                                                    <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                        {option.label}
                                                    </Text>
                                                </View>
                                                {selected && <Ionicons color={tc.tint} name="checkmark" size={18} />}
                                            </TouchableOpacity>
                                        </React.Fragment>
                                    );
                                })}
                            </ScrollView>
                        </View>
                    </Pressable>
                </Modal>
                <Modal
                    transparent
                    visible={quickAccessPickerOpen}
                    animationType="fade"
                    onRequestClose={() => setQuickAccessPickerOpen(false)}
                >
                    <Pressable style={styles.pickerOverlay} onPress={() => setQuickAccessPickerOpen(false)}>
                        <View
                            style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                            onStartShouldSetResponder={() => true}
                        >
                            <Text style={[styles.pickerTitle, { color: tc.text }]}>{appearance.quickAccess.pickerTitle}</Text>
                            <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                {appearance.quickAccess.options.map((option) => {
                                    const { selected } = option;
                                    return (
                                        <TouchableOpacity
                                            key={option.value}
                                            accessibilityRole="radio"
                                            accessibilityState={{ selected }}
                                            style={[
                                                styles.pickerOption,
                                                { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => {
                                                writeSetting(option.edit);
                                                setQuickAccessPickerOpen(false);
                                            }}
                                        >
                                            <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                {option.label}
                                            </Text>
                                            {selected && <Ionicons color={tc.tint} name="checkmark" size={18} />}
                                        </TouchableOpacity>
                                    );
                                })}
                            </ScrollView>
                        </View>
                    </Pressable>
                </Modal>

                <Text style={[styles.sectionTitle, { color: tc.secondaryText, marginTop: 16 }]}>{model.language.title}</Text>
                <Text style={[styles.description, { color: tc.secondaryText }]}>{model.language.description}</Text>
                <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                    <SettingRow
                        onPress={() => setLanguagePickerOpen(true)}
                        label={model.language.label}
                        description={model.language.value}
                    >
                        <Ionicons color={tc.secondaryText} name="chevron-down" size={18} />
                    </SettingRow>
                </View>
                <Modal
                    transparent
                    visible={languagePickerOpen}
                    animationType="fade"
                    onRequestClose={() => setLanguagePickerOpen(false)}
                >
                    <Pressable style={styles.pickerOverlay} onPress={() => setLanguagePickerOpen(false)}>
                        <View
                            style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                            onStartShouldSetResponder={() => true}
                        >
                            <Text style={[styles.pickerTitle, { color: tc.text }]}>{model.language.pickerTitle}</Text>
                            <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                {model.language.options.map((option) => {
                                    const { selected } = option;
                                    return (
                                        <TouchableOpacity
                                            key={option.value}
                                            accessibilityRole="radio"
                                            accessibilityState={{ selected }}
                                            style={[
                                                styles.pickerOption,
                                                { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => {
                                                setLanguage(option.value);
                                                writeSetting(option.edit);
                                                setLanguagePickerOpen(false);
                                            }}
                                        >
                                            <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                {option.label}
                                            </Text>
                                            {selected && <Ionicons color={tc.tint} name="checkmark" size={18} />}
                                        </TouchableOpacity>
                                    );
                                })}
                            </ScrollView>
                        </View>
                    </Pressable>
                </Modal>

                <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                    <SettingRow
                        onPress={() => setRegionalFormatsOpen((open) => !open)}
                        label={regional.label}
                        description={regional.summary}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: regionalFormatsOpen }}
                        testID="regional-formats-toggle"
                    >
                        <Ionicons
                            color={tc.secondaryText}
                            name={regionalFormatsOpen ? 'chevron-up' : 'chevron-down'}
                            size={18}
                        />
                    </SettingRow>
                    {regionalFormatsOpen ? (
                        <>
                            <SettingRow
                                divider
                                onPress={() => setWeekStartPickerOpen(true)}
                                label={regional.weekStart.label}
                                description={regional.weekStart.value}
                            >
                                <Ionicons color={tc.secondaryText} name="chevron-down" size={18} />
                            </SettingRow>
                            <SettingRow
                                divider
                                onPress={() => setDateFormatPickerOpen(true)}
                                label={regional.dateFormat.label}
                                description={regional.dateFormat.value}
                            >
                                <Ionicons color={tc.secondaryText} name="chevron-down" size={18} />
                            </SettingRow>
                            {regional.calendarSystem ? (
                                <SettingRow
                                    divider
                                    onPress={() => setCalendarSystemPickerOpen(true)}
                                    label={regional.calendarSystem.label}
                                    description={regional.calendarSystem.value}
                                >
                                    <Ionicons color={tc.secondaryText} name="chevron-down" size={18} />
                                </SettingRow>
                            ) : null}
                            <SettingRow
                                divider
                                onPress={() => setTimeFormatPickerOpen(true)}
                                label={regional.timeFormat.label}
                                description={regional.timeFormat.value}
                            >
                                <Ionicons color={tc.secondaryText} name="chevron-down" size={18} />
                            </SettingRow>
                        </>
                    ) : null}
                </View>
                <Modal
                    transparent
                    visible={weekStartPickerOpen}
                    animationType="fade"
                    onRequestClose={() => setWeekStartPickerOpen(false)}
                >
                    <Pressable style={styles.pickerOverlay} onPress={() => setWeekStartPickerOpen(false)}>
                        <View
                            style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                            onStartShouldSetResponder={() => true}
                        >
                            <Text style={[styles.pickerTitle, { color: tc.text }]}>{regional.weekStart.pickerTitle}</Text>
                            <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                {regional.weekStart.options.map((option) => {
                                    const { selected } = option;
                                    return (
                                        <TouchableOpacity
                                            key={option.value}
                                            accessibilityRole="radio"
                                            accessibilityState={{ selected }}
                                            style={[
                                                styles.pickerOption,
                                                { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => {
                                                writeSetting(option.edit);
                                                setWeekStartPickerOpen(false);
                                            }}
                                        >
                                            <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                {option.label}
                                            </Text>
                                            {selected && <Ionicons color={tc.tint} name="checkmark" size={18} />}
                                        </TouchableOpacity>
                                    );
                                })}
                            </ScrollView>
                        </View>
                    </Pressable>
                </Modal>

                <Modal
                    transparent
                    visible={dateFormatPickerOpen}
                    animationType="fade"
                    onRequestClose={() => setDateFormatPickerOpen(false)}
                >
                    <Pressable style={styles.pickerOverlay} onPress={() => setDateFormatPickerOpen(false)}>
                        <View
                            style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                            onStartShouldSetResponder={() => true}
                        >
                            <Text style={[styles.pickerTitle, { color: tc.text }]}>{regional.dateFormat.pickerTitle}</Text>
                            <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                {regional.dateFormat.options.map((option) => {
                                    const { selected } = option;
                                    return (
                                        <TouchableOpacity
                                            key={option.value}
                                            accessibilityRole="radio"
                                            accessibilityState={{ selected }}
                                            style={[
                                                styles.pickerOption,
                                                { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => {
                                                writeSetting(option.edit);
                                                setDateFormatPickerOpen(false);
                                            }}
                                        >
                                            <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                {option.label}
                                            </Text>
                                            {selected && <Ionicons color={tc.tint} name="checkmark" size={18} />}
                                        </TouchableOpacity>
                                    );
                                })}
                            </ScrollView>
                        </View>
                    </Pressable>
                </Modal>

                {regional.calendarSystem && (
                    <Modal
                        transparent
                        visible={calendarSystemPickerOpen}
                        animationType="fade"
                        onRequestClose={() => setCalendarSystemPickerOpen(false)}
                    >
                        <Pressable style={styles.pickerOverlay} onPress={() => setCalendarSystemPickerOpen(false)}>
                            <View
                                style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                onStartShouldSetResponder={() => true}
                            >
                                <Text style={[styles.pickerTitle, { color: tc.text }]}>{regional.calendarSystem.pickerTitle}</Text>
                                <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                    {regional.calendarSystem.options.map((option) => {
                                        const { selected } = option;
                                        return (
                                            <TouchableOpacity
                                                key={option.value}
                                                accessibilityRole="radio"
                                                accessibilityState={{ selected }}
                                                style={[
                                                    styles.pickerOption,
                                                    { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                                ]}
                                                onPress={() => {
                                                    writeSetting(option.edit);
                                                    setCalendarSystemPickerOpen(false);
                                                }}
                                            >
                                                <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                    {option.label}
                                                </Text>
                                                {selected && <Ionicons color={tc.tint} name="checkmark" size={18} />}
                                            </TouchableOpacity>
                                        );
                                    })}
                                </ScrollView>
                            </View>
                        </Pressable>
                    </Modal>
                )}

                <Modal
                    transparent
                    visible={timeFormatPickerOpen}
                    animationType="fade"
                    onRequestClose={() => setTimeFormatPickerOpen(false)}
                >
                    <Pressable style={styles.pickerOverlay} onPress={() => setTimeFormatPickerOpen(false)}>
                        <View
                            style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                            onStartShouldSetResponder={() => true}
                        >
                            <Text style={[styles.pickerTitle, { color: tc.text }]}>{regional.timeFormat.pickerTitle}</Text>
                            <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                {regional.timeFormat.options.map((option) => {
                                    const { selected } = option;
                                    return (
                                        <TouchableOpacity
                                            key={option.value}
                                            accessibilityRole="radio"
                                            accessibilityState={{ selected }}
                                            style={[
                                                styles.pickerOption,
                                                { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => {
                                                writeSetting(option.edit);
                                                setTimeFormatPickerOpen(false);
                                            }}
                                        >
                                            <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                {option.label}
                                            </Text>
                                            {selected && <Ionicons color={tc.tint} name="checkmark" size={18} />}
                                        </TouchableOpacity>
                                    );
                                })}
                            </ScrollView>
                        </View>
                    </Pressable>
                </Modal>
            </ScrollView>
        </SafeAreaView>
    );
}

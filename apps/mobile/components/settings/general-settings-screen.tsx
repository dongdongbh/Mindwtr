import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { normalizeDateFormatSetting, normalizeTimeFormatSetting, useTaskStore } from '@mindwtr/core';

import { useTheme } from '@/contexts/theme-context';
import { useThemeColors } from '@/hooks/use-theme-colors';

import { LANGUAGES } from './settings.constants';
import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsTopBar, SubHeader } from './settings.shell';
import { styles } from './settings.styles';

export function GeneralSettingsScreen() {
    const { themeMode, setThemeMode } = useTheme();
    const { language, setLanguage, t } = useSettingsLocalization();
    const { settings, updateSettings } = useTaskStore();
    const tc = useThemeColors();
    const scrollContentStyle = useSettingsScrollContent();
    const [themePickerOpen, setThemePickerOpen] = useState(false);
    const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
    const [weekStartPickerOpen, setWeekStartPickerOpen] = useState(false);
    const [dateFormatPickerOpen, setDateFormatPickerOpen] = useState(false);
    const [timeFormatPickerOpen, setTimeFormatPickerOpen] = useState(false);

    const weekStart = settings.weekStart === 'monday' ? 'monday' : 'sunday';
    const dateFormat = normalizeDateFormatSetting(settings.dateFormat);
    const timeFormat = normalizeTimeFormatSetting(settings.timeFormat);
    const themeOptions: { value: typeof themeMode; label: string }[] = [
        { value: 'system', label: t('settings.system') },
        { value: 'light', label: t('settings.light') },
        { value: 'dark', label: t('settings.dark') },
        { value: 'material3-light', label: t('settings.material3Light') },
        { value: 'material3-dark', label: t('settings.material3Dark') },
        { value: 'eink', label: t('settings.eink') },
        { value: 'nord', label: t('settings.nord') },
        { value: 'sepia', label: t('settings.sepia') },
        { value: 'oled', label: t('settings.oled') },
    ];
    const currentThemeLabel = themeOptions.find((opt) => opt.value === themeMode)?.label ?? t('settings.system');
    const weekStartOptions: { value: 'sunday' | 'monday'; label: string }[] = [
        { value: 'sunday', label: t('settings.weekStartSunday') },
        { value: 'monday', label: t('settings.weekStartMonday') },
    ];
    const currentWeekStartLabel = weekStartOptions.find((opt) => opt.value === weekStart)?.label ?? t('settings.weekStartSunday');
    const dateFormatOptions: { value: 'system' | 'dmy' | 'mdy' | 'ymd'; label: string }[] = [
        { value: 'system', label: t('settings.dateFormatSystem') },
        { value: 'dmy', label: t('settings.dateFormatDmy') },
        { value: 'mdy', label: t('settings.dateFormatMdy') },
        { value: 'ymd', label: t('settings.dateFormatYmd') },
    ];
    const currentDateFormatLabel = dateFormatOptions.find((opt) => opt.value === dateFormat)?.label ?? t('settings.dateFormatSystem');
    const timeFormatOptions: { value: 'system' | '12h' | '24h'; label: string }[] = [
        { value: 'system', label: t('settings.timeFormatSystem') },
        { value: '12h', label: t('settings.timeFormat12h') },
        { value: '24h', label: t('settings.timeFormat24h') },
    ];
    const currentTimeFormatLabel = timeFormatOptions.find((opt) => opt.value === timeFormat)?.label ?? t('settings.timeFormatSystem');

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar />
            <SubHeader title={t('settings.general')} />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                <Text style={[styles.sectionTitle, { color: tc.secondaryText }]}>{t('settings.appearance')}</Text>
                <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                    <TouchableOpacity style={styles.settingRow} onPress={() => setThemePickerOpen(true)}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.theme')}</Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{currentThemeLabel}</Text>
                        </View>
                        <Text style={{ color: tc.secondaryText, fontSize: 18 }}>▾</Text>
                    </TouchableOpacity>
                </View>
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
                            <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('settings.theme')}</Text>
                            <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                {themeOptions.map((option) => {
                                    const selected = option.value === themeMode;
                                    return (
                                        <TouchableOpacity
                                            key={option.value}
                                            style={[
                                                styles.pickerOption,
                                                { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => {
                                                setThemeMode(option.value);
                                                updateSettings({ theme: option.value }).catch(console.error);
                                                setThemePickerOpen(false);
                                            }}
                                        >
                                            <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                {option.label}
                                            </Text>
                                            {selected && <Text style={{ color: tc.tint, fontSize: 18 }}>✓</Text>}
                                        </TouchableOpacity>
                                    );
                                })}
                            </ScrollView>
                        </View>
                    </Pressable>
                </Modal>

                <Text style={[styles.sectionTitle, { color: tc.secondaryText, marginTop: 16 }]}>{t('settings.language')}</Text>
                <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.selectLang')}</Text>
                <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                    <TouchableOpacity style={styles.settingRow} onPress={() => setLanguagePickerOpen(true)}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.language')}</Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                {LANGUAGES.find((lang) => lang.id === language)?.native ?? language}
                            </Text>
                        </View>
                        <Text style={{ color: tc.secondaryText, fontSize: 18 }}>▾</Text>
                    </TouchableOpacity>
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
                            <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('settings.language')}</Text>
                            <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                {LANGUAGES.map((lang) => {
                                    const selected = language === lang.id;
                                    return (
                                        <TouchableOpacity
                                            key={lang.id}
                                            style={[
                                                styles.pickerOption,
                                                { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => {
                                                setLanguage(lang.id);
                                                updateSettings({ language: lang.id }).catch(console.error);
                                                setLanguagePickerOpen(false);
                                            }}
                                        >
                                            <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                {lang.native}
                                            </Text>
                                            {selected && <Text style={{ color: tc.tint, fontSize: 18 }}>✓</Text>}
                                        </TouchableOpacity>
                                    );
                                })}
                            </ScrollView>
                        </View>
                    </Pressable>
                </Modal>

                <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                    <TouchableOpacity style={styles.settingRow} onPress={() => setWeekStartPickerOpen(true)}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.weekStart')}</Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{currentWeekStartLabel}</Text>
                        </View>
                        <Text style={{ color: tc.secondaryText, fontSize: 18 }}>▾</Text>
                    </TouchableOpacity>
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
                            <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('settings.weekStart')}</Text>
                            <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                {weekStartOptions.map((option) => {
                                    const selected = weekStart === option.value;
                                    return (
                                        <TouchableOpacity
                                            key={option.value}
                                            style={[
                                                styles.pickerOption,
                                                { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => {
                                                updateSettings({ weekStart: option.value }).catch(console.error);
                                                setWeekStartPickerOpen(false);
                                            }}
                                        >
                                            <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                {option.label}
                                            </Text>
                                            {selected && <Text style={{ color: tc.tint, fontSize: 18 }}>✓</Text>}
                                        </TouchableOpacity>
                                    );
                                })}
                            </ScrollView>
                        </View>
                    </Pressable>
                </Modal>

                <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                    <TouchableOpacity style={styles.settingRow} onPress={() => setDateFormatPickerOpen(true)}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.dateFormat')}</Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{currentDateFormatLabel}</Text>
                        </View>
                        <Text style={{ color: tc.secondaryText, fontSize: 18 }}>▾</Text>
                    </TouchableOpacity>
                </View>
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
                            <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('settings.dateFormat')}</Text>
                            <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                {dateFormatOptions.map((option) => {
                                    const selected = dateFormat === option.value;
                                    return (
                                        <TouchableOpacity
                                            key={option.value}
                                            style={[
                                                styles.pickerOption,
                                                { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => {
                                                updateSettings({ dateFormat: option.value }).catch(console.error);
                                                setDateFormatPickerOpen(false);
                                            }}
                                        >
                                            <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                {option.label}
                                            </Text>
                                            {selected && <Text style={{ color: tc.tint, fontSize: 18 }}>✓</Text>}
                                        </TouchableOpacity>
                                    );
                                })}
                            </ScrollView>
                        </View>
                    </Pressable>
                </Modal>

                <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                    <TouchableOpacity style={styles.settingRow} onPress={() => setTimeFormatPickerOpen(true)}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.timeFormat')}</Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{currentTimeFormatLabel}</Text>
                        </View>
                        <Text style={{ color: tc.secondaryText, fontSize: 18 }}>▾</Text>
                    </TouchableOpacity>
                </View>
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
                            <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('settings.timeFormat')}</Text>
                            <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                {timeFormatOptions.map((option) => {
                                    const selected = timeFormat === option.value;
                                    return (
                                        <TouchableOpacity
                                            key={option.value}
                                            style={[
                                                styles.pickerOption,
                                                { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => {
                                                updateSettings({ timeFormat: option.value }).catch(console.error);
                                                setTimeFormatPickerOpen(false);
                                            }}
                                        >
                                            <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                {option.label}
                                            </Text>
                                            {selected && <Text style={{ color: tc.tint, fontSize: 18 }}>✓</Text>}
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

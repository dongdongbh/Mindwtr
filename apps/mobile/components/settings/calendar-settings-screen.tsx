import React, { useCallback, useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Alert, Platform, ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
    addCalendarFeed,
    addCalendarFile,
    buildCalendarAreaChoice,
    buildCalendarPushTargetChoices,
    calendarSettingsToasts,
    getCalendarFeedColorOptions,
    getCalendarPushColorDescription,
    getCalendarPushColorLabel,
    getCalendarPushColorOptions,
    getCalendarTestRange,
    getDocsGuideUrl,
    generateUUID,
    keptPushTargetEvents,
    nextDeviceCalendarSelection,
    planCalendarPushColor,
    pruneDeviceCalendarSelection,
    removeCalendarFeed,
    resolveCalendarFeedsOnLoad,
    setCalendarFeedColor,
    setCalendarFeedEnabled,
    shallow,
    toggleCalendarAreaId,
    toggleCalendarFeedArea,
    runStoreCommand,
    type ExternalCalendarSubscription,
    useTaskStore,
} from '@mindwtr/core';

import {
    fetchExternalCalendarEvents,
    getExternalCalendars,
    getSystemCalendarPermissionStatus,
    getSystemCalendars,
    getSystemCalendarSettings,
    requestSystemCalendarPermission,
    saveExternalCalendars,
    saveSystemCalendarSettings,
    type SystemCalendarInfo,
    type SystemCalendarPermissionStatus,
} from '@/lib/external-calendar';
import {
    deleteMindwtrCalendar,
    getCalendarPushColor,
    getCalendarPushEnabled,
    getCalendarPushTargetCalendarId,
    getCalendarPushTargetCalendars,
    getCalendarWritePermissionStatus,
    requestCalendarWritePermission,
    runFullCalendarSync,
    setCalendarPushEnabled,
    setCalendarPushTargetCalendarId,
    startCalendarPushSync,
    stopCalendarPushSync,
    updateMindwtrCalendarColor,
    type CalendarPushTargetCalendar,
} from '@/lib/calendar-push-sync';
import { useTheme } from '@/contexts/theme-context';
import { useToast } from '@/contexts/toast-context';
import { maskCalendarUrl } from '@/lib/settings-utils';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { CompactText } from '@/components/compact-text';

import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsGuideLink, SettingsTopBar } from './settings.shell';
import { styles } from './settings.styles';

type CollapsibleSettingHeaderProps = {
    title: string;
    description: string;
    open: boolean;
    onToggle: () => void;
    textColor: string;
    secondaryTextColor: string;
    rightControl: React.ReactNode;
};

function CollapsibleSettingHeader({
    title,
    description,
    open,
    onToggle,
    textColor,
    secondaryTextColor,
    rightControl,
}: CollapsibleSettingHeaderProps) {
    return (
        <View style={styles.settingRow}>
            <TouchableOpacity
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', marginRight: 12 }}
                onPress={onToggle}
                activeOpacity={0.7}
            >
                <View style={{ flex: 1, marginRight: 12 }}>
                    <Text style={[styles.settingLabel, { color: textColor }]}>{title}</Text>
                    <Text style={[styles.settingDescription, { color: secondaryTextColor }]}>{description}</Text>
                </View>
                <Text style={[styles.chevron, { color: secondaryTextColor }]}>{open ? '▾' : '▸'}</Text>
            </TouchableOpacity>
            {rightControl}
        </View>
    );
}

export function CalendarSettingsScreen() {
    const tc = useThemeColors();
    const { themePreset } = useTheme();
    const filledButton = useFilledButtonColors();
    const { showToast } = useToast();
    const { language, tr, t } = useSettingsLocalization();
    const { settings, areas, updateSettings } = useTaskStore((state) => ({
        settings: state.settings,
        areas: state.areas,
        updateSettings: state.updateSettings,
    }), shallow);
    const scrollContentStyle = useSettingsScrollContent();
    const [externalCalendars, setExternalCalendars] = useState<ExternalCalendarSubscription[]>([]);
    const [newCalendarName, setNewCalendarName] = useState('');
    const [newCalendarUrl, setNewCalendarUrl] = useState('');
    const [systemCalendarEnabled, setSystemCalendarEnabled] = useState(false);
    const [systemCalendarSelectAll, setSystemCalendarSelectAll] = useState(true);
    const [systemCalendarSelectedIds, setSystemCalendarSelectedIds] = useState<string[]>([]);
    const [systemCalendarAreaIds, setSystemCalendarAreaIds] = useState<Record<string, string[]>>({});
    const [expandedAreaSourceId, setExpandedAreaSourceId] = useState<string | null>(null);
    const [systemCalendarPermission, setSystemCalendarPermission] = useState<SystemCalendarPermissionStatus>('undetermined');
    const [systemCalendars, setSystemCalendars] = useState<SystemCalendarInfo[]>([]);
    const [isSystemCalendarLoading, setIsSystemCalendarLoading] = useState(false);
    const [systemCalendarOpen, setSystemCalendarOpen] = useState(false);

    // Push-to-calendar state
    const [calendarPushEnabled, setCalendarPushEnabledState] = useState(false);
    const [calendarPushPermission, setCalendarPushPermission] = useState<'granted' | 'denied' | 'undetermined'>('undetermined');
    const [calendarPushTargetCalendarId, setCalendarPushTargetCalendarIdState] = useState<string | null>(null);
    const [calendarPushTargets, setCalendarPushTargets] = useState<CalendarPushTargetCalendar[]>([]);
    const [calendarPushColor, setCalendarPushColorState] = useState('#3B82F6');
    const [isCalendarPushTargetLoading, setIsCalendarPushTargetLoading] = useState(false);
    const [isDeletingMindwtrCalendar, setIsDeletingMindwtrCalendar] = useState(false);
    const [calendarPushOpen, setCalendarPushOpen] = useState(false);

    const loadCalendarPushTargetState = useCallback(async () => {
        setIsCalendarPushTargetLoading(true);
        try {
            const [targetId, targets, color] = await Promise.all([
                getCalendarPushTargetCalendarId(),
                getCalendarPushTargetCalendars(),
                getCalendarPushColor(),
            ]);
            setCalendarPushTargetCalendarIdState(targetId);
            setCalendarPushTargets(targets);
            setCalendarPushColorState(color);
        } catch (error) {
            console.error(error);
            showToast(calendarSettingsToasts(tr, t).loadWritableCalendarsFailed());
        } finally {
            setIsCalendarPushTargetLoading(false);
        }
    }, [t, tr, showToast]);

    useEffect(() => {
        void (async () => {
            const [enabled, permission] = await Promise.all([
                getCalendarPushEnabled(),
                getCalendarWritePermissionStatus(),
            ]);
            setCalendarPushEnabledState(enabled);
            setCalendarPushPermission(permission);
            if (permission === 'granted') {
                await loadCalendarPushTargetState();
            } else {
                setCalendarPushTargetCalendarIdState(await getCalendarPushTargetCalendarId());
            }
        })();
    }, [loadCalendarPushTargetState]);

    const handleToggleCalendarPush = async (enabled: boolean) => {
        if (enabled) {
            const granted = calendarPushPermission === 'granted'
                ? true
                : await requestCalendarWritePermission();
            if (!granted) {
                setCalendarPushPermission('denied');
                showToast(calendarSettingsToasts(tr, t).pushPermissionRequired());
                return;
            }
            setCalendarPushPermission('granted');
            await loadCalendarPushTargetState();
            await setCalendarPushEnabled(true);
            setCalendarPushEnabledState(true);
            setCalendarPushOpen(true);
            startCalendarPushSync();
            void runFullCalendarSync();
        } else {
            await setCalendarPushEnabled(false);
            setCalendarPushEnabledState(false);
            stopCalendarPushSync();
            showToast(calendarSettingsToasts(tr, t).pushDisabled());
        }
    };

    const handleSelectCalendarPushTarget = async (calendarId: string | null) => {
        if (calendarId === calendarPushTargetCalendarId) return;
        await setCalendarPushTargetCalendarId(calendarId);
        setCalendarPushTargetCalendarIdState(calendarId);
        if (calendarPushEnabled) {
            void runFullCalendarSync();
        }
        showToast(calendarSettingsToasts(tr, t).pushTargetUpdated());
    };

    const handleSelectCalendarPushColor = async (color: string) => {
        if (!planCalendarPushColor(calendarPushColor, color)) return;
        try {
            const updated = await updateMindwtrCalendarColor(color);
            setCalendarPushColorState(color);
            await loadCalendarPushTargetState();
            showToast(calendarSettingsToasts(tr, t).pushColorUpdated(updated));
        } catch (error) {
            // The device refused: nothing was stored, so picking the color again retries it.
            console.error(error);
            await loadCalendarPushTargetState();
            showToast(calendarSettingsToasts(tr, t).pushColorFailed());
        }
    };

    const performDeleteMindwtrCalendar = useCallback(async () => {
        if (isDeletingMindwtrCalendar) return;
        setIsDeletingMindwtrCalendar(true);
        try {
            // Disable push sync first so the calendar is not recreated on the next
            // startup or task change.
            await setCalendarPushEnabled(false);
            setCalendarPushEnabledState(false);
            stopCalendarPushSync();
            const target = await getCalendarPushTargetCalendarId();
            await deleteMindwtrCalendar();
            const keptTargetEvents = keptPushTargetEvents(target, await getCalendarPushTargetCalendarId());
            setCalendarPushTargetCalendarIdState(null);
            await loadCalendarPushTargetState();
            showToast(calendarSettingsToasts(tr, t).mindwtrCalendarDeleted(keptTargetEvents));
        } catch (error) {
            console.error(error);
            showToast(calendarSettingsToasts(tr, t).loadWritableCalendarsFailed());
        } finally {
            setIsDeletingMindwtrCalendar(false);
        }
    }, [isDeletingMindwtrCalendar, loadCalendarPushTargetState, t, tr, showToast]);

    const handleDeleteMindwtrCalendar = useCallback(() => {
        if (isDeletingMindwtrCalendar) return;
        Alert.alert(
            tr('settings.calendarMobile.deleteMindwtrCalendar'),
            tr('settings.calendarMobile.removeTheDedicatedCalendarAndItsPushedEventsFromThis'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.delete'),
                    style: 'destructive',
                    onPress: () => {
                        void performDeleteMindwtrCalendar();
                    },
                },
            ],
        );
    }, [isDeletingMindwtrCalendar, performDeleteMindwtrCalendar, t, tr]);

    const loadSystemCalendarState = useCallback(async (requestAccess = false) => {
        setIsSystemCalendarLoading(true);
        try {
            const stored = await getSystemCalendarSettings();
            setSystemCalendarEnabled(stored.enabled);
            setSystemCalendarSelectAll(stored.selectAll);
            setSystemCalendarSelectedIds(stored.selectedCalendarIds);
            setSystemCalendarAreaIds(stored.areaIdsByCalendar ?? {});

            const permission = requestAccess
                ? await requestSystemCalendarPermission()
                : await getSystemCalendarPermissionStatus();
            setSystemCalendarPermission(permission);

            if (permission !== 'granted') {
                setSystemCalendars([]);
                return;
            }

            const calendars = await getSystemCalendars();
            setSystemCalendars(calendars);
            const filteredSelection = pruneDeviceCalendarSelection(stored, calendars.map((calendar) => calendar.id));
            if (!filteredSelection) return;

            setSystemCalendarSelectedIds(filteredSelection);
            await saveSystemCalendarSettings({
                enabled: stored.enabled,
                selectAll: false,
                selectedCalendarIds: filteredSelection,
                areaIdsByCalendar: stored.areaIdsByCalendar,
            });
        } catch (error) {
            console.error(error);
            showToast(calendarSettingsToasts(tr, t).loadDeviceCalendarsFailed());
        } finally {
            setIsSystemCalendarLoading(false);
        }
    }, [t, tr, showToast]);

    useEffect(() => {
        void loadSystemCalendarState();
    }, [loadSystemCalendarState]);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const stored = await getExternalCalendars();
                if (cancelled) return;
                const shown = resolveCalendarFeedsOnLoad(settings.externalCalendars, stored);
                setExternalCalendars(shown.feeds);
                if (shown.saveDeviceCopy) {
                    await saveExternalCalendars(shown.feeds);
                }
            } catch (error) {
                console.error(error);
                showToast(calendarSettingsToasts(tr, t).loadSavedCalendarsFailed());
            }
        };
        void load();
        return () => {
            cancelled = true;
        };
    }, [t, tr, settings.externalCalendars, showToast]);

    const persistSystemCalendarState = async (next: {
        enabled?: boolean;
        selectAll?: boolean;
        selectedCalendarIds?: string[];
        areaIdsByCalendar?: Record<string, string[]>;
    }) => {
        const payload = {
            enabled: next.enabled ?? systemCalendarEnabled,
            selectAll: next.selectAll ?? systemCalendarSelectAll,
            selectedCalendarIds: next.selectedCalendarIds ?? systemCalendarSelectedIds,
            areaIdsByCalendar: next.areaIdsByCalendar ?? systemCalendarAreaIds,
        };
        setSystemCalendarEnabled(payload.enabled);
        setSystemCalendarSelectAll(payload.selectAll);
        setSystemCalendarSelectedIds(payload.selectedCalendarIds);
        setSystemCalendarAreaIds(payload.areaIdsByCalendar);
        await saveSystemCalendarSettings(payload);
    };

    const handleToggleSystemCalendarEnabled = async (enabled: boolean) => {
        await persistSystemCalendarState({ enabled });
        if (enabled) setSystemCalendarOpen(true);
        if (enabled && systemCalendarPermission !== 'granted') {
            await loadSystemCalendarState(true);
        }
    };

    const handleToggleSystemCalendarSelection = async (calendarId: string, enabled: boolean) => {
        const selection = nextDeviceCalendarSelection({
            calendarIds: systemCalendars.map((calendar) => calendar.id),
            selectAll: systemCalendarSelectAll,
            selectedCalendarIds: systemCalendarSelectedIds,
            calendarId,
            enabled,
        });
        if (!selection) return;

        await persistSystemCalendarState(selection);
    };

    const toggleSystemCalendarArea = async (calendarId: string, areaId: string) => {
        const next = toggleCalendarAreaId(systemCalendarAreaIds[calendarId] ?? [], areaId);
        await persistSystemCalendarState({ areaIdsByCalendar: { ...systemCalendarAreaIds, [calendarId]: next } });
    };

    // Each feed edit applies to the latest stored list when its write is admitted, so a feed another device
    // added, changed or removed since this page loaded stays as synced. Before any sync, the shown list is the base.
    const writeCalendarFeeds = (edit: (feeds: ExternalCalendarSubscription[]) => ExternalCalendarSubscription[] | null) => (
        runStoreCommand(async () => {
            const next = edit(useTaskStore.getState().settings.externalCalendars ?? externalCalendars);
            if (!next) return;
            setExternalCalendars(next);
            await saveExternalCalendars(next);
            await updateSettings({ externalCalendars: next });
        })
    );

    const toggleCalendarArea = async (calendarId: string, areaId: string) => {
        await writeCalendarFeeds((feeds) => toggleCalendarFeedArea(feeds, calendarId, areaId));
    };

    const renderAreaSelector = (sourceId: string, selectedIds: string[], onToggle: (areaId: string) => void) => {
        const choice = buildCalendarAreaChoice(selectedIds, areas, t);
        const expanded = expandedAreaSourceId === sourceId;
        return choice && <View style={{ marginTop: 8 }}>
            <TouchableOpacity accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpandedAreaSourceId(expanded ? null : sourceId)}>
                <Text style={[styles.settingDescription, { color: tc.tint }]}>{choice.label}</Text>
            </TouchableOpacity>
            {expanded && choice.options.map((option) => (
                <TouchableOpacity key={option.areaId} accessibilityRole="checkbox" accessibilityState={{ checked: option.checked }} accessibilityLabel={option.accessibilityLabel} onPress={() => onToggle(option.areaId)} style={{ paddingVertical: 7 }}>
                    <Text style={[styles.settingDescription, { color: tc.text }]}>{option.label}</Text>
                </TouchableOpacity>
            ))}
        </View>;
    };

    const handleAddCalendar = async () => {
        if (!newCalendarUrl.trim()) return;
        await writeCalendarFeeds((feeds) => {
            const next = addCalendarFeed(feeds, {
                id: generateUUID(),
                name: newCalendarName,
                url: newCalendarUrl,
                defaultName: tr('nav.calendar'),
            });
            if (!next) return null;
            setNewCalendarName('');
            setNewCalendarUrl('');
            return next;
        });
    };

    const handleChooseLocalCalendar = async () => {
        try {
            const result = await DocumentPicker.getDocumentAsync({
                type: ['text/calendar', 'application/ics', 'application/octet-stream', '*/*'],
                copyToCacheDirectory: false,
            });
            if (result.canceled) return;
            const asset = result.assets[0];
            if (!asset?.uri) return;

            await writeCalendarFeeds((feeds) => {
                const next = addCalendarFile(feeds, {
                    id: generateUUID(),
                    name: newCalendarName,
                    fileName: asset.name,
                    uri: asset.uri,
                    defaultName: tr('nav.calendar'),
                });
                setNewCalendarName('');
                setNewCalendarUrl('');
                return next;
            });
            showToast(calendarSettingsToasts(tr, t).localFileAdded());
        } catch (error) {
            console.error(error);
            showToast(calendarSettingsToasts(tr, t).loadSavedCalendarsFailed());
        }
    };

    const handleToggleCalendar = async (id: string, enabled: boolean) => {
        await writeCalendarFeeds((feeds) => setCalendarFeedEnabled(feeds, id, enabled));
    };

    const handleCalendarColorChange = async (id: string, color: string | undefined) => {
        // `undefined` is the Auto swatch: drop the pick so the feed hint or
        // the assigned default applies again (#974).
        await writeCalendarFeeds((feeds) => setCalendarFeedColor(feeds, id, color));
    };

    const handleRemoveCalendar = async (id: string) => {
        await writeCalendarFeeds((feeds) => removeCalendarFeed(feeds, id));
    };

    const handleTestFetch = async () => {
        try {
            const range = getCalendarTestRange(new Date());
            let failedFeeds = 0;
            const { events } = await fetchExternalCalendarEvents(range.start, range.end, {
                onFeedError: () => { failedFeeds += 1; },
            });
            showToast(calendarSettingsToasts(tr, t).testResult(events.length, failedFeeds, language));
        } catch (error) {
            console.error(error);
            showToast(calendarSettingsToasts(tr, t).testFailed());
        }
    };

    const selectedSystemCalendarSet = new Set(systemCalendarSelectedIds);
    const {
        options: calendarPushTargetOptions,
        localHint: selectedLocalCalendarForPush,
        sharedAccountHint: selectedSharedAccountCalendarForPush,
        showColors: selectedManagedMindwtrCalendarForPush,
    } = buildCalendarPushTargetChoices({
        targets: calendarPushTargets,
        targetId: calendarPushTargetCalendarId,
        color: calendarPushColor,
        tr,
        platform: Platform.OS,
    });

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar title={t('settings.calendar')} />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                {/* Push tasks to calendar */}
                <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginBottom: 16 }]}>
                    <CollapsibleSettingHeader
                        title={tr('settings.calendarMobile.pushTasksToCalendar')}
                        description={tr('settings.calendarMobile.scheduledTasksAndTasksWithDueDatesAreAddedTo')}
                        open={calendarPushOpen}
                        onToggle={() => setCalendarPushOpen((open) => !open)}
                        textColor={tc.text}
                        secondaryTextColor={tc.secondaryText}
                        rightControl={(
                            <Switch
                                value={calendarPushEnabled}
                                onValueChange={(v) => void handleToggleCalendarPush(v)}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        )}
                    />

                    {calendarPushOpen && calendarPushEnabled && calendarPushPermission === 'denied' && (
                        <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: tc.border }}>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                {tr('settings.calendarMobile.calendarAccessWasDeniedPleaseGrantAccessInSettings')}
                            </Text>
                        </View>
                    )}

                    {calendarPushOpen && calendarPushEnabled && calendarPushPermission === 'granted' && (
                        <View style={{ borderTopWidth: 1, borderTopColor: tc.border }}>
                            <View style={styles.settingRowColumn}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>
                                    {tr('settings.calendarMobile.syncTarget')}
                                </Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {tr('settings.calendarMobile.chooseAnAccountCalendarIfYourCalendarAppHidesLocal')}
                                </Text>
                                {selectedLocalCalendarForPush && (
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 8 }]}>
                                        {tr('settings.calendarMobile.localCalendarTargetsStayOnThisDeviceUseAGoogle')}
                                    </Text>
                                )}
                                {selectedSharedAccountCalendarForPush && (
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 8 }]}>
                                        {tr('settings.calendarMobile.forASeparateColorInGoogleCalendarSelectADedicated')}
                                    </Text>
                                )}
                            </View>

                            {isCalendarPushTargetLoading ? (
                                <View style={{ paddingBottom: 16 }}>
                                    <ActivityIndicator color={tc.tint} />
                                </View>
                            ) : (
                                calendarPushTargetOptions.map((target, idx) => {
                                    const selected = target.id === calendarPushTargetCalendarId;
                                    return (
                                        <TouchableOpacity
                                            key={target.id ?? 'mindwtr-managed'}
                                            accessibilityRole="button"
                                            accessibilityLabel={`${target.name}. ${target.description}`}
                                            accessibilityState={{ selected }}
                                            style={[
                                                styles.settingRow,
                                                { borderTopWidth: idx > 0 ? 1 : 0, borderTopColor: tc.border },
                                            ]}
                                            onPress={() => void handleSelectCalendarPushTarget(target.id)}
                                        >
                                            <View style={styles.settingInfo}>
                                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                                    {target.color && (
                                                        <View
                                                            style={{
                                                                width: 10,
                                                                height: 10,
                                                                borderRadius: 5,
                                                                backgroundColor: target.color,
                                                            }}
                                                        />
                                                    )}
                                                    <Text style={[styles.settingLabel, { color: tc.text, flex: 1 }]} numberOfLines={1}>
                                                        {target.name}
                                                    </Text>
                                                </View>
                                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={1}>
                                                    {target.description}
                                                </Text>
                                            </View>
                                            {selected && <Ionicons color={tc.tint} name="checkmark" size={20} />}
                                        </TouchableOpacity>
                                    );
                                })
                            )}

                            {selectedManagedMindwtrCalendarForPush && (
                                <View style={[styles.settingRowColumn, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>
                                        {getCalendarPushColorLabel(t)}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {getCalendarPushColorDescription(t)}
                                    </Text>
                                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
                                        {getCalendarPushColorOptions(calendarPushColor, t).map(({ color, selected, accessibilityLabel }) => {
                                            return (
                                                <TouchableOpacity
                                                    key={color}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={accessibilityLabel}
                                                    accessibilityState={{ selected }}
                                                    onPress={() => void handleSelectCalendarPushColor(color)}
                                                    style={{
                                                        width: 34,
                                                        height: 34,
                                                        borderRadius: 17,
                                                        borderWidth: selected ? 3 : 1,
                                                        borderColor: selected ? tc.text : tc.border,
                                                        backgroundColor: color,
                                                    }}
                                                />
                                            );
                                        })}
                                    </View>
                                </View>
                            )}

                            <TouchableOpacity
                                accessibilityRole="button"
                                accessibilityLabel={tr('settings.calendarMobile.refreshCalendars')}
                                onPress={() => void loadCalendarPushTargetState()}
                                style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            >
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>
                                        {tr('settings.calendarMobile.refreshCalendars')}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {tr('settings.calendarMobile.reloadTheListAfterAddingACalendarInGoogleCalendar')}
                                    </Text>
                                </View>
                                <Ionicons color={tc.tint} name="refresh-outline" size={20} />
                            </TouchableOpacity>

                            <TouchableOpacity
                                accessibilityRole="button"
                                accessibilityLabel={tr('settings.calendarMobile.deleteMindwtrCalendar')}
                                onPress={handleDeleteMindwtrCalendar}
                                disabled={isDeletingMindwtrCalendar}
                                style={[
                                    styles.settingRow,
                                    {
                                        borderTopWidth: 1,
                                        borderTopColor: tc.border,
                                        opacity: isDeletingMindwtrCalendar ? 0.6 : 1,
                                    },
                                ]}
                            >
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: '#EF4444' }]}>
                                        {tr('settings.calendarMobile.deleteMindwtrCalendar')}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {tr('settings.calendarMobile.removeTheDedicatedCalendarAndItsPushedEventsFromThis')}
                                    </Text>
                                </View>
                                {isDeletingMindwtrCalendar ? (
                                    <ActivityIndicator color="#EF4444" />
                                ) : (
                                    <Ionicons color="#EF4444" name="trash-outline" size={20} />
                                )}
                            </TouchableOpacity>
                        </View>
                    )}
                </View>

                <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                    <CollapsibleSettingHeader
                        title={t('settings.deviceCalendars')}
                        description={t('settings.deviceCalendarsDesc')}
                        open={systemCalendarOpen}
                        onToggle={() => setSystemCalendarOpen((open) => !open)}
                        textColor={tc.text}
                        secondaryTextColor={tc.secondaryText}
                        rightControl={(
                            <Switch
                                value={systemCalendarEnabled}
                                onValueChange={handleToggleSystemCalendarEnabled}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        )}
                    />

                    {systemCalendarOpen && systemCalendarEnabled && (
                        <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: tc.border }}>
                            {systemCalendarPermission !== 'granted' ? (
                                <View>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {systemCalendarPermission === 'denied'
                                            ? t('settings.calendarAccessDenied')
                                            : t('settings.calendarAccessRequired')}
                                    </Text>
                                    <TouchableOpacity
                                        style={[
                                            styles.backendOption,
                                            { borderColor: tc.border, backgroundColor: tc.filterBg, marginTop: 12, alignSelf: 'flex-start' },
                                        ]}
                                        onPress={() => void loadSystemCalendarState(true)}
                                    >
                                        <CompactText
                                            style={[styles.backendOptionText, { color: tc.text }]}
                                            numberOfLines={2}
                                        >
                                            {t('settings.grantCalendarAccess')}
                                        </CompactText>
                                    </TouchableOpacity>
                                </View>
                            ) : isSystemCalendarLoading ? (
                                <View style={{ paddingVertical: 8 }}>
                                    <ActivityIndicator color={tc.tint} />
                                </View>
                            ) : systemCalendars.length === 0 ? (
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.noDeviceCalendars')}</Text>
                            ) : (
                                <View>
                                    {systemCalendars.map((calendar, idx) => {
                                        const selected = systemCalendarSelectAll || selectedSystemCalendarSet.has(calendar.id);
                                        return (
                                            <View
                                                key={calendar.id}
                                                style={[styles.settingRow, idx > 0 && { borderTopWidth: 1, borderTopColor: tc.border }]}
                                            >
                                                <View style={styles.settingInfo}>
                                                    <Text style={[styles.settingLabel, { color: tc.text }]} numberOfLines={2}>
                                                        {calendar.name}
                                                    </Text>
                                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={2}>
                                                        {t('settings.deviceCalendar')}
                                                    </Text>
                                                    {renderAreaSelector(`system:${calendar.id}`, systemCalendarAreaIds[calendar.id] ?? [], (areaId) => void toggleSystemCalendarArea(calendar.id, areaId))}
                                                </View>
                                                <Switch
                                                    value={selected}
                                                    onValueChange={(value) => void handleToggleSystemCalendarSelection(calendar.id, value)}
                                                    trackColor={{ false: '#767577', true: '#3B82F6' }}
                                                />
                                            </View>
                                        );
                                    })}
                                </View>
                            )}
                        </View>
                    )}
                </View>

                <Text style={[styles.sectionTitle, { color: tc.secondaryText, marginTop: 16 }]}>
                    {tr('settings.calendarMobile.icsSubscriptions')}
                </Text>
                <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.calendarDesc')}</Text>

                <SettingsGuideLink
                    title={t('settings.calendarIntegrationGuideTitle')}
                    description={t('settings.calendarIntegrationGuideDesc')}
                    url={getDocsGuideUrl('use/calendar-integration', language)}
                    testID="calendar-guide-link"
                />

                <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                    <View style={styles.inputGroup}>
                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.externalCalendarName')}</Text>
                        <TextInput
                            style={[styles.textInput, { borderColor: tc.border, color: tc.text }]}
                            placeholder={tr('settings.calendarMobile.optional')}
                            placeholderTextColor={tc.secondaryText}
                            value={newCalendarName}
                            onChangeText={setNewCalendarName}
                        />

                        <Text style={[styles.settingLabel, { color: tc.text, marginTop: 12 }]}>{t('settings.externalCalendarUrl')}</Text>
                        <TextInput
                            style={[styles.textInput, { borderColor: tc.border, color: tc.text }]}
                            placeholder={t('settings.externalCalendarUrlPlaceholder')}
                            placeholderTextColor={tc.secondaryText}
                            autoCapitalize="none"
                            autoCorrect={false}
                            value={newCalendarUrl}
                            onChangeText={setNewCalendarUrl}
                        />

                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 12 }}>
                            <TouchableOpacity
                                style={[
                                    styles.backendOption,
                                    { borderColor: tc.border, backgroundColor: newCalendarUrl.trim() ? filledButton.backgroundColor : tc.filterBg },
                                ]}
                                onPress={() => void handleAddCalendar()}
                                disabled={!newCalendarUrl.trim()}
                            >
                                <CompactText
                                    style={[styles.backendOptionText, { color: newCalendarUrl.trim() ? (filledButton.textColor ?? tc.onTint) : tc.secondaryText }]}
                                    numberOfLines={2}
                                >
                                    {t('settings.externalCalendarAdd')}
                                </CompactText>
                            </TouchableOpacity>

                            <TouchableOpacity
                                style={[styles.backendOption, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                onPress={() => void handleTestFetch()}
                            >
                                <CompactText
                                    style={[styles.backendOptionText, { color: tc.text }]}
                                    numberOfLines={2}
                                >
                                    {tr('settings.calendarMobile.test')}
                                </CompactText>
                            </TouchableOpacity>
                        </View>

                        <TouchableOpacity
                            style={[
                                styles.backendOption,
                                { borderColor: tc.border, backgroundColor: tc.filterBg, marginTop: 12, alignSelf: 'flex-start' },
                            ]}
                            onPress={() => void handleChooseLocalCalendar()}
                        >
                            <CompactText
                                style={[styles.backendOptionText, { color: tc.text }]}
                                numberOfLines={2}
                            >
                                {tr('settings.calendarMobile.chooseLocalIcsFile')}
                            </CompactText>
                        </TouchableOpacity>
                    </View>
                </View>

                {externalCalendars.length > 0 && (
                    <View style={{ marginTop: 16 }}>
                        <Text style={[styles.sectionTitle, { color: tc.secondaryText }]}>{t('settings.externalCalendars')}</Text>
                        <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                            {externalCalendars.map((calendar, idx) => (
                                <View
                                    key={calendar.id}
                                    style={[styles.settingRow, idx > 0 && { borderTopWidth: 1, borderTopColor: tc.border }]}
                                >
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]} numberOfLines={2}>
                                            {calendar.name}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={2}>
                                            {maskCalendarUrl(calendar.url)}
                                        </Text>
                                        {renderAreaSelector(calendar.id, calendar.areaIds ?? [], (areaId) => void toggleCalendarArea(calendar.id, areaId))}
                                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                                            {getCalendarFeedColorOptions(calendar, t, themePreset).map(({ color, fill, selected, accessibilityLabel }) => (
                                                color === null ? (
                                                    <TouchableOpacity
                                                        key="auto"
                                                        accessibilityRole="button"
                                                        accessibilityState={{ selected }}
                                                        accessibilityLabel={accessibilityLabel}
                                                        onPress={() => void handleCalendarColorChange(calendar.id, undefined)}
                                                        style={{
                                                            width: 22,
                                                            height: 22,
                                                            borderRadius: 11,
                                                            backgroundColor: tc.cardBg,
                                                            alignItems: 'center',
                                                            justifyContent: 'center',
                                                            borderWidth: selected ? 3 : 1,
                                                            borderColor: selected ? tc.tint : tc.border,
                                                        }}
                                                    >
                                                        <Ionicons name="ban-outline" size={12} color={tc.secondaryText} />
                                                    </TouchableOpacity>
                                                ) : (
                                                    <TouchableOpacity
                                                        key={color}
                                                        accessibilityRole="button"
                                                        accessibilityState={{ selected }}
                                                        accessibilityLabel={accessibilityLabel}
                                                        onPress={() => void handleCalendarColorChange(calendar.id, color)}
                                                        style={{
                                                            width: 22,
                                                            height: 22,
                                                            borderRadius: 11,
                                                            backgroundColor: fill ?? color,
                                                            borderWidth: selected ? 3 : 1,
                                                            borderColor: selected ? tc.tint : tc.border,
                                                        }}
                                                    />
                                                )
                                            ))}
                                        </View>
                                    </View>
                                    <View style={{ alignItems: 'flex-end', gap: 10 }}>
                                        <Switch
                                            value={calendar.enabled}
                                            onValueChange={(value) => void handleToggleCalendar(calendar.id, value)}
                                            trackColor={{ false: '#767577', true: '#3B82F6' }}
                                        />
                                        <TouchableOpacity onPress={() => void handleRemoveCalendar(calendar.id)}>
                                            <Text style={{ color: '#EF4444', fontSize: 13, fontWeight: '600' }}>
                                                {t('settings.externalCalendarRemove')}
                                            </Text>
                                        </TouchableOpacity>
                                    </View>
                                </View>
                            ))}
                        </View>
                    </View>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

import React, { useCallback, useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { generateUUID, type ExternalCalendarSubscription, useTaskStore } from '@mindwtr/core';

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
    type CalendarPushTargetCalendar,
} from '@/lib/calendar-push-sync';
import { useToast } from '@/contexts/toast-context';
import { maskCalendarUrl } from '@/lib/settings-utils';
import { useThemeColors } from '@/hooks/use-theme-colors';

import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsTopBar, SubHeader } from './settings.shell';
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
    const { showToast } = useToast();
    const { isChineseLanguage, localize, t } = useSettingsLocalization();
    const { settings, updateSettings } = useTaskStore();
    const scrollContentStyle = useSettingsScrollContent();
    const [externalCalendars, setExternalCalendars] = useState<ExternalCalendarSubscription[]>([]);
    const [newCalendarName, setNewCalendarName] = useState('');
    const [newCalendarUrl, setNewCalendarUrl] = useState('');
    const [systemCalendarEnabled, setSystemCalendarEnabled] = useState(false);
    const [systemCalendarSelectAll, setSystemCalendarSelectAll] = useState(true);
    const [systemCalendarSelectedIds, setSystemCalendarSelectedIds] = useState<string[]>([]);
    const [systemCalendarPermission, setSystemCalendarPermission] = useState<SystemCalendarPermissionStatus>('undetermined');
    const [systemCalendars, setSystemCalendars] = useState<SystemCalendarInfo[]>([]);
    const [isSystemCalendarLoading, setIsSystemCalendarLoading] = useState(false);
    const [systemCalendarOpen, setSystemCalendarOpen] = useState(false);

    // Push-to-calendar state
    const [calendarPushEnabled, setCalendarPushEnabledState] = useState(false);
    const [calendarPushPermission, setCalendarPushPermission] = useState<'granted' | 'denied' | 'undetermined'>('undetermined');
    const [calendarPushTargetCalendarId, setCalendarPushTargetCalendarIdState] = useState<string | null>(null);
    const [calendarPushTargets, setCalendarPushTargets] = useState<CalendarPushTargetCalendar[]>([]);
    const [isCalendarPushTargetLoading, setIsCalendarPushTargetLoading] = useState(false);
    const [calendarPushOpen, setCalendarPushOpen] = useState(false);

    const loadCalendarPushTargetState = useCallback(async () => {
        setIsCalendarPushTargetLoading(true);
        try {
            const [targetId, targets] = await Promise.all([
                getCalendarPushTargetCalendarId(),
                getCalendarPushTargetCalendars(),
            ]);
            setCalendarPushTargetCalendarIdState(targetId);
            setCalendarPushTargets(targets);
        } catch (error) {
            console.error(error);
            showToast({
                title: localize('Error', '错误'),
                message: localize('Failed to load writable calendars', '加载可写日历失败'),
                tone: 'warning',
                durationMs: 4200,
            });
        } finally {
            setIsCalendarPushTargetLoading(false);
        }
    }, [localize, showToast]);

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
                showToast({
                    title: localize('Permission Required', '需要权限'),
                    message: localize('Calendar access is required to push tasks to your calendar.', '需要日历访问权限才能将任务推送到您的日历。'),
                    tone: 'warning',
                    durationMs: 4200,
                });
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
            showToast({
                title: localize('Calendar sync disabled', '日历同步已禁用'),
                message: localize('Tasks will no longer be pushed to your calendar. Existing events were kept.', '任务将不再推送到您的日历。已创建的日程已保留。'),
                tone: 'info',
                durationMs: 4200,
            });
        }
    };

    const handleSelectCalendarPushTarget = async (calendarId: string | null) => {
        if (calendarId === calendarPushTargetCalendarId) return;
        await setCalendarPushTargetCalendarId(calendarId);
        setCalendarPushTargetCalendarIdState(calendarId);
        if (calendarPushEnabled) {
            void runFullCalendarSync();
        }
        showToast({
            title: localize('Calendar target updated', '日历目标已更新'),
            message: localize('Due-date tasks will be written to the selected calendar.', '带截止日期的任务将写入所选日历。'),
            tone: 'success',
            durationMs: 3200,
        });
    };

    const handleDeleteMindwtrCalendar = async () => {
        // Disable push sync first so the calendar is not recreated on the next
        // startup or task change.
        await setCalendarPushEnabled(false);
        setCalendarPushEnabledState(false);
        stopCalendarPushSync();
        await deleteMindwtrCalendar();
        showToast({
            title: localize('Calendar deleted', '日历已删除'),
            message: localize('The Mindwtr calendar and all its events have been removed.', 'Mindwtr 日历及其所有日程已删除。'),
            tone: 'success',
            durationMs: 3500,
        });
    };

    const loadSystemCalendarState = useCallback(async (requestAccess = false) => {
        setIsSystemCalendarLoading(true);
        try {
            const stored = await getSystemCalendarSettings();
            setSystemCalendarEnabled(stored.enabled);
            setSystemCalendarSelectAll(stored.selectAll);
            setSystemCalendarSelectedIds(stored.selectedCalendarIds);

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
            if (stored.selectAll) return;

            const validIds = new Set(calendars.map((calendar) => calendar.id));
            const filteredSelection = stored.selectedCalendarIds.filter((id) => validIds.has(id));
            if (
                filteredSelection.length === stored.selectedCalendarIds.length &&
                filteredSelection.every((id, index) => id === stored.selectedCalendarIds[index])
            ) {
                return;
            }

            setSystemCalendarSelectedIds(filteredSelection);
            await saveSystemCalendarSettings({
                enabled: stored.enabled,
                selectAll: false,
                selectedCalendarIds: filteredSelection,
            });
        } catch (error) {
            console.error(error);
            showToast({
                title: localize('Error', '错误'),
                message: localize('Failed to load device calendar settings', '加载系统日历设置失败'),
                tone: 'warning',
                durationMs: 4200,
            });
        } finally {
            setIsSystemCalendarLoading(false);
        }
    }, [localize, showToast]);

    useEffect(() => {
        void loadSystemCalendarState();
    }, [loadSystemCalendarState]);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const stored = await getExternalCalendars();
                if (cancelled) return;
                if (Array.isArray(settings.externalCalendars)) {
                    setExternalCalendars(settings.externalCalendars);
                    if (settings.externalCalendars.length || stored.length) {
                        await saveExternalCalendars(settings.externalCalendars);
                    }
                    return;
                }
                setExternalCalendars(stored);
            } catch (error) {
                console.error(error);
                showToast({
                    title: localize('Error', '错误'),
                    message: localize('Failed to load saved calendars', '加载已保存的日历失败'),
                    tone: 'warning',
                    durationMs: 4200,
                });
            }
        };
        void load();
        return () => {
            cancelled = true;
        };
    }, [localize, settings.externalCalendars, showToast]);

    const persistSystemCalendarState = async (next: {
        enabled?: boolean;
        selectAll?: boolean;
        selectedCalendarIds?: string[];
    }) => {
        const payload = {
            enabled: next.enabled ?? systemCalendarEnabled,
            selectAll: next.selectAll ?? systemCalendarSelectAll,
            selectedCalendarIds: next.selectedCalendarIds ?? systemCalendarSelectedIds,
        };
        setSystemCalendarEnabled(payload.enabled);
        setSystemCalendarSelectAll(payload.selectAll);
        setSystemCalendarSelectedIds(payload.selectedCalendarIds);
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
        const allIds = systemCalendars.map((calendar) => calendar.id);
        if (allIds.length === 0) return;

        const currentSelection = systemCalendarSelectAll
            ? allIds
            : Array.from(new Set(systemCalendarSelectedIds.filter((id) => allIds.includes(id))));
        const nextSelection = enabled
            ? Array.from(new Set([...currentSelection, calendarId]))
            : currentSelection.filter((id) => id !== calendarId);
        const selectAll = nextSelection.length === allIds.length;

        await persistSystemCalendarState({
            selectAll,
            selectedCalendarIds: selectAll ? [] : nextSelection,
        });
    };

    const handleAddCalendar = async () => {
        const url = newCalendarUrl.trim();
        if (!url) return;

        const name = (newCalendarName.trim() || localize('Calendar', '日历')).trim();
        const next: ExternalCalendarSubscription[] = [...externalCalendars, { id: generateUUID(), name, url, enabled: true }];

        setExternalCalendars(next);
        setNewCalendarName('');
        setNewCalendarUrl('');
        await saveExternalCalendars(next);
        await updateSettings({ externalCalendars: next });
    };

    const handleToggleCalendar = async (id: string, enabled: boolean) => {
        const next = externalCalendars.map((c) => (c.id === id ? { ...c, enabled } : c));
        setExternalCalendars(next);
        await saveExternalCalendars(next);
        await updateSettings({ externalCalendars: next });
    };

    const handleRemoveCalendar = async (id: string) => {
        const next = externalCalendars.filter((c) => c.id !== id);
        setExternalCalendars(next);
        await saveExternalCalendars(next);
        await updateSettings({ externalCalendars: next });
    };

    const handleTestFetch = async () => {
        try {
            const now = new Date();
            const rangeStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
            const rangeEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
            const { events } = await fetchExternalCalendarEvents(rangeStart, rangeEnd);
            showToast({
                title: localize('Success', '成功'),
                message: isChineseLanguage ? `已加载 ${events.length} 个日程` : `Loaded ${events.length} events`,
                tone: 'success',
            });
        } catch (error) {
            console.error(error);
            showToast({
                title: localize('Error', '错误'),
                message: localize('Failed to load events', '加载失败'),
                tone: 'warning',
            });
        }
    };

    const selectedSystemCalendarSet = new Set(systemCalendarSelectedIds);
    const selectedCalendarPushTarget = calendarPushTargetCalendarId
        ? calendarPushTargets.find((calendar) => calendar.id === calendarPushTargetCalendarId)
        : null;
    const selectedSharedAccountCalendarForPush = Boolean(
        selectedCalendarPushTarget
        && !selectedCalendarPushTarget.isMindwtrDedicated
        && !selectedCalendarPushTarget.isLocalOnly
    );
    const selectedLocalCalendarForPush = calendarPushTargetCalendarId === null || Boolean(selectedCalendarPushTarget?.isLocalOnly);
    const hasDedicatedAccountCalendarForPush = calendarPushTargets.some((calendar) =>
        calendar.isMindwtrDedicated && !calendar.isLocalOnly
    );
    const getCalendarPushTargetDescription = (calendar: CalendarPushTargetCalendar): string => {
        const kind = calendar.isMindwtrDedicated
            ? calendar.isLocalOnly
                ? localize('Dedicated local calendar', '专用本地日历')
                : localize('Dedicated account calendar', '专用账户日历')
            : calendar.isLocalOnly
                ? localize('Shared local calendar', '共享本地日历')
                : localize('Shared account calendar', '共享账户日历');
        return calendar.sourceName ? `${kind} · ${calendar.sourceName}` : kind;
    };
    const defaultLocalTargetOption = {
        id: null as string | null,
        name: localize('Mindwtr calendar', 'Mindwtr 日历'),
        description: localize('Dedicated local calendar', '专用本地日历'),
        color: '#3B82F6',
    };
    const calendarPushTargetOptions: Array<{
        id: string | null;
        name: string;
        description: string;
        color?: string;
    }> = [
        ...(!hasDedicatedAccountCalendarForPush || calendarPushTargetCalendarId === null
            ? [defaultLocalTargetOption]
            : []),
        ...calendarPushTargets
            .filter((calendar) => {
                if (calendar.isMindwtrManaged && calendar.id !== calendarPushTargetCalendarId) return false;
                if (
                    hasDedicatedAccountCalendarForPush
                    && calendar.isMindwtrDedicated
                    && calendar.isLocalOnly
                    && calendar.id !== calendarPushTargetCalendarId
                ) {
                    return false;
                }
                return true;
            })
            .map((calendar) => ({
                id: calendar.id as string | null,
                name: calendar.name,
                description: getCalendarPushTargetDescription(calendar),
                color: calendar.color,
            })),
    ];

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar />
            <SubHeader title={t('settings.calendar')} />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                {/* Push tasks to calendar */}
                <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginBottom: 16 }]}>
                    <CollapsibleSettingHeader
                        title={localize('Push tasks to calendar', '将任务推送到日历')}
                        description={localize(
                            'Scheduled tasks and tasks with due dates are added to your selected device calendar.',
                            '已安排的任务和带截止日期的任务会添加到所选设备日历中。'
                        )}
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
                                {localize(
                                    'Calendar access was denied. Please grant access in Settings.',
                                    '日历访问被拒绝。请在设置中授予访问权限。'
                                )}
                            </Text>
                        </View>
                    )}

                    {calendarPushOpen && calendarPushEnabled && calendarPushPermission === 'granted' && (
                        <View style={{ borderTopWidth: 1, borderTopColor: tc.border }}>
                            <View style={styles.settingRowColumn}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>
                                    {localize('Sync target', '同步目标')}
                                </Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                {localize(
                                    'Choose an account calendar if your calendar app hides local calendars.',
                                    '如果日历应用隐藏本地日历，请选择账户日历。'
                                )}
                            </Text>
                            {selectedLocalCalendarForPush && (
                                <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 8 }]}>
                                    {localize(
                                        'Local calendar targets stay on this device. Use a Google account calendar target if you need Google Calendar web sync.',
                                        '本地日历目标只保存在此设备。如需同步到 Google 日历网页端，请选择 Google 账户日历。'
                                    )}
                                </Text>
                            )}
                            {selectedSharedAccountCalendarForPush && (
                                <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 8 }]}>
                                    {localize(
                                        'For a separate color in Google Calendar, select a dedicated account calendar named Mindwtr. Shared calendars still use a Mindwtr title prefix.',
                                        '如需在 Google 日历中使用单独颜色，请选择名为 Mindwtr 的专用账户日历。共享日历仍会使用 Mindwtr 标题前缀。'
                                    )}
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

                            <TouchableOpacity
                                onPress={() => void loadCalendarPushTargetState()}
                                style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            >
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>
                                        {localize('Refresh calendars', '刷新日历')}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {localize(
                                            'Reload the list after adding a calendar in Google Calendar.',
                                            '在 Google 日历中添加日历后重新加载列表。'
                                        )}
                                    </Text>
                                </View>
                                <Ionicons color={tc.tint} name="refresh-outline" size={20} />
                            </TouchableOpacity>

                            <TouchableOpacity
                                onPress={() => void handleDeleteMindwtrCalendar()}
                                style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            >
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: '#EF4444' }]}>
                                        {localize('Delete Mindwtr calendar', '删除 Mindwtr 日历')}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {localize(
                                            'Remove the dedicated calendar and its pushed events from this device.',
                                            '从此设备移除专用日历及已推送的日程。'
                                        )}
                                    </Text>
                                </View>
                                <Ionicons color="#EF4444" name="trash-outline" size={20} />
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
                                        <Text style={[styles.backendOptionText, { color: tc.text }]}>{t('settings.grantCalendarAccess')}</Text>
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
                                                    <Text style={[styles.settingLabel, { color: tc.text }]} numberOfLines={1}>
                                                        {calendar.name}
                                                    </Text>
                                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={1}>
                                                        {t('settings.deviceCalendar')}
                                                    </Text>
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
                    {localize('ICS subscriptions', 'ICS 订阅')}
                </Text>
                <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.calendarDesc')}</Text>

                <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                    <View style={styles.inputGroup}>
                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.externalCalendarName')}</Text>
                        <TextInput
                            style={[styles.textInput, { borderColor: tc.border, color: tc.text }]}
                            placeholder={localize('Optional', '可选')}
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

                        <View style={{ flexDirection: 'row', gap: 12, marginTop: 12 }}>
                            <TouchableOpacity
                                style={[
                                    styles.backendOption,
                                    { borderColor: tc.border, backgroundColor: newCalendarUrl.trim() ? tc.tint : tc.filterBg },
                                ]}
                                onPress={() => void handleAddCalendar()}
                                disabled={!newCalendarUrl.trim()}
                            >
                                <Text style={[styles.backendOptionText, { color: newCalendarUrl.trim() ? '#FFFFFF' : tc.secondaryText }]}>
                                    {t('settings.externalCalendarAdd')}
                                </Text>
                            </TouchableOpacity>

                            <TouchableOpacity
                                style={[styles.backendOption, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                onPress={() => void handleTestFetch()}
                            >
                                <Text style={[styles.backendOptionText, { color: tc.text }]}>{localize('Test', '测试')}</Text>
                            </TouchableOpacity>
                        </View>
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
                                        <Text style={[styles.settingLabel, { color: tc.text }]} numberOfLines={1}>
                                            {calendar.name}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={1}>
                                            {maskCalendarUrl(calendar.url)}
                                        </Text>
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

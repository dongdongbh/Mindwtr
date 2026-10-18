import type { AppData } from '@mindwtr/core';

import { reportError } from '../../../lib/report-error';
import { requestDesktopNotificationPermission } from '../../../lib/notification-service';
import { Switch } from '../../ui/Switch';
import { TimeInput } from '../../ui/TimeInput';
import { SettingRow } from './SettingRow';

type Labels = {
    notificationsDesc: string;
    notificationsEnable: string;
    taskReminderDefault: string;
    taskReminderDefaultDesc: string;
    taskReminderDefaultSend: string;
    taskReminderDefaultSkip: string;
    startDateNotifications: string;
    startDateNotificationsDesc: string;
    dueDateNotifications: string;
    dueDateNotificationsDesc: string;
    reviewAtNotifications: string;
    reviewAtNotificationsDesc: string;
    weeklyReview: string;
    weeklyReviewDesc: string;
    weeklyReviewDay: string;
    weeklyReviewTime: string;
    dailyDigest: string;
    dailyDigestDesc: string;
    dailyDigestMorning: string;
    dailyDigestEvening: string;
};

type WeekdayOption = { value: number; label: string };

export type SettingsNotificationsPageProps = {
    t: Labels;
    notificationsEnabled: boolean;
    taskReminderDefault?: 'send' | 'skip';
    startDateNotificationsEnabled: boolean;
    dueDateNotificationsEnabled: boolean;
    reviewAtNotificationsEnabled: boolean;
    weeklyReviewEnabled: boolean;
    weeklyReviewDay: number;
    weeklyReviewTime: string;
    weekdayOptions: WeekdayOption[];
    dailyDigestMorningEnabled: boolean;
    dailyDigestEveningEnabled: boolean;
    dailyDigestMorningTime: string;
    dailyDigestEveningTime: string;
    updateSettings: (updates: Partial<AppData['settings']>) => Promise<void>;
    showSaved: () => void;
};

export function SettingsNotificationsPage({
    t,
    notificationsEnabled,
    taskReminderDefault = 'send',
    startDateNotificationsEnabled,
    dueDateNotificationsEnabled,
    reviewAtNotificationsEnabled,
    weeklyReviewEnabled,
    weeklyReviewDay,
    weeklyReviewTime,
    weekdayOptions,
    dailyDigestMorningEnabled,
    dailyDigestEveningEnabled,
    dailyDigestMorningTime,
    dailyDigestEveningTime,
    updateSettings,
    showSaved,
}: SettingsNotificationsPageProps) {
    const handleUpdate = async (updates: Partial<AppData['settings']>) => {
        if (updates.notificationsEnabled === true) {
            try {
                await requestDesktopNotificationPermission();
            } catch (error) {
                reportError('Failed to request notification permission', error);
            }
        }
        updateSettings(updates)
            .then(showSaved)
            .catch((error) => reportError('Failed to update notification settings', error));
    };

    return (
        <div className="bg-card border border-border rounded-lg p-6 space-y-4">
            <p className="text-sm text-muted-foreground">{t.notificationsDesc}</p>

            <SettingRow settingsKey="notificationsEnable" title={t.notificationsEnable}>
                <Switch
                    checked={notificationsEnabled}
                    onCheckedChange={(checked) => handleUpdate({ notificationsEnabled: checked })}
                    aria-label={t.notificationsEnable}
                />
            </SettingRow>

            <SettingRow settingsKey="taskReminderDefault" title={t.taskReminderDefault} description={t.taskReminderDefaultDesc}>
                <select
                    aria-label={t.taskReminderDefault}
                    value={taskReminderDefault}
                    onChange={(event) => handleUpdate({ taskReminderDefault: event.target.value as 'send' | 'skip' })}
                    className="bg-muted px-2 py-1 rounded text-sm border border-border"
                >
                    <option value="send">{t.taskReminderDefaultSend}</option>
                    <option value="skip">{t.taskReminderDefaultSkip}</option>
                </select>
            </SettingRow>

            <SettingRow
                settingsKey="startDateNotifications"
                title={t.startDateNotifications}
                description={t.startDateNotificationsDesc}
            >
                <Switch
                    checked={startDateNotificationsEnabled}
                    onCheckedChange={(checked) => handleUpdate({ startDateNotificationsEnabled: checked })}
                    aria-label={t.startDateNotifications}
                    disabled={!notificationsEnabled}
                />
            </SettingRow>

            <SettingRow
                settingsKey="dueDateNotifications"
                title={t.dueDateNotifications}
                description={t.dueDateNotificationsDesc}
            >
                <Switch
                    checked={dueDateNotificationsEnabled}
                    onCheckedChange={(checked) => handleUpdate({ dueDateNotificationsEnabled: checked })}
                    aria-label={t.dueDateNotifications}
                    disabled={!notificationsEnabled}
                />
            </SettingRow>

            <SettingRow
                settingsKey="reviewAtNotifications"
                title={t.reviewAtNotifications}
                description={t.reviewAtNotificationsDesc}
            >
                <Switch
                    checked={reviewAtNotificationsEnabled}
                    onCheckedChange={(checked) => handleUpdate({ reviewAtNotificationsEnabled: checked })}
                    aria-label={t.reviewAtNotifications}
                    disabled={!notificationsEnabled}
                />
            </SettingRow>

            <div className="border-t border-border/50"></div>

            <div data-settings-key="weeklyReview" className="space-y-3">
                <div>
                    <p className="text-sm font-medium">{t.weeklyReview}</p>
                    <p className="text-xs text-muted-foreground mt-1">{t.weeklyReviewDesc}</p>
                </div>

                {/* The group above carries the `weeklyReview` search key. */}
                {/* Not gated on notificationsEnabled: the weekly review nudge fires
                    independent of the task-reminder master switch, so its own toggle must
                    stay operable even when that switch is off (matches mobile). */}
                <SettingRow settingsKey={null} title={t.weeklyReview}>
                    <Switch
                        checked={weeklyReviewEnabled}
                        onCheckedChange={(checked) => handleUpdate({ weeklyReviewEnabled: checked })}
                        aria-label={t.weeklyReview}
                    />
                </SettingRow>

                <SettingRow settingsKey="weeklyReviewDay" title={t.weeklyReviewDay}>
                    <select
                        aria-label={t.weeklyReviewDay}
                        value={weeklyReviewDay}
                        disabled={!weeklyReviewEnabled}
                        onChange={(e) => handleUpdate({ weeklyReviewDay: Number(e.target.value) })}
                        className="bg-muted px-2 py-1 rounded text-sm border border-border disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {weekdayOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                </SettingRow>

                <SettingRow settingsKey="weeklyReviewTime" title={t.weeklyReviewTime}>
                    <TimeInput
                        aria-label={t.weeklyReviewTime}
                        value={weeklyReviewTime}
                        disabled={!weeklyReviewEnabled}
                        onChange={(weeklyReviewTime) => handleUpdate({ weeklyReviewTime })}
                        className="bg-muted px-2 py-1 rounded text-sm border border-border disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                </SettingRow>
            </div>

            <div className="border-t border-border/50"></div>

            <div data-settings-key="dailyDigest" className="space-y-3">
                <div>
                    <p className="text-sm font-medium">{t.dailyDigest}</p>
                    <p className="text-xs text-muted-foreground mt-1">{t.dailyDigestDesc}</p>
                </div>

                <SettingRow settingsKey="dailyDigestMorning" title={t.dailyDigestMorning}>
                    <TimeInput
                        aria-label={t.dailyDigestMorning}
                        value={dailyDigestMorningTime}
                        disabled={!dailyDigestMorningEnabled}
                        onChange={(dailyDigestMorningTime) => handleUpdate({ dailyDigestMorningTime })}
                        className="bg-muted px-2 py-1 rounded text-sm border border-border disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                    <Switch
                        checked={dailyDigestMorningEnabled}
                        onCheckedChange={(checked) => handleUpdate({ dailyDigestMorningEnabled: checked })}
                        aria-label={t.dailyDigestMorning}
                    />
                </SettingRow>

                <SettingRow settingsKey="dailyDigestEvening" title={t.dailyDigestEvening}>
                    <TimeInput
                        aria-label={t.dailyDigestEvening}
                        value={dailyDigestEveningTime}
                        disabled={!dailyDigestEveningEnabled}
                        onChange={(dailyDigestEveningTime) => handleUpdate({ dailyDigestEveningTime })}
                        className="bg-muted px-2 py-1 rounded text-sm border border-border disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                    <Switch
                        checked={dailyDigestEveningEnabled}
                        onCheckedChange={(checked) => handleUpdate({ dailyDigestEveningEnabled: checked })}
                        aria-label={t.dailyDigestEvening}
                    />
                </SettingRow>
            </div>
        </div>
    );
}

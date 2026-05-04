import type { AppData } from '@mindwtr/core';

import { cn } from '../../../lib/utils';
import { reportError } from '../../../lib/report-error';
import { requestDesktopNotificationPermission } from '../../../lib/notification-service';

type Labels = {
    notificationsDesc: string;
    notificationsEnable: string;
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

type SettingsNotificationsPageProps = {
    t: Labels;
    notificationsEnabled: boolean;
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

            <div className="flex items-start justify-between gap-4">
                <div>
                    <p className="text-sm font-medium">{t.notificationsEnable}</p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={notificationsEnabled}
                    onClick={() => handleUpdate({ notificationsEnabled: !notificationsEnabled })}
                    className={cn(
                        "relative inline-flex h-5 w-9 items-center rounded-full border transition-colors",
                        notificationsEnabled ? "bg-primary border-primary" : "bg-muted/50 border-border"
                    )}
                >
                    <span
                        className={cn(
                            "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
                            notificationsEnabled ? "translate-x-4" : "translate-x-1"
                        )}
                    />
                </button>
            </div>

            <div className="flex items-start justify-between gap-4">
                <div>
                    <p className="text-sm font-medium">{t.startDateNotifications}</p>
                    <p className="text-xs text-muted-foreground mt-1">{t.startDateNotificationsDesc}</p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={startDateNotificationsEnabled}
                    onClick={() => handleUpdate({ startDateNotificationsEnabled: !startDateNotificationsEnabled })}
                    disabled={!notificationsEnabled}
                    className={cn(
                        "relative inline-flex h-5 w-9 items-center rounded-full border transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                        startDateNotificationsEnabled ? "bg-primary border-primary" : "bg-muted/50 border-border"
                    )}
                >
                    <span
                        className={cn(
                            "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
                            startDateNotificationsEnabled ? "translate-x-4" : "translate-x-1"
                        )}
                    />
                </button>
            </div>

            <div className="flex items-start justify-between gap-4">
                <div>
                    <p className="text-sm font-medium">{t.dueDateNotifications}</p>
                    <p className="text-xs text-muted-foreground mt-1">{t.dueDateNotificationsDesc}</p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={dueDateNotificationsEnabled}
                    onClick={() => handleUpdate({ dueDateNotificationsEnabled: !dueDateNotificationsEnabled })}
                    disabled={!notificationsEnabled}
                    className={cn(
                        "relative inline-flex h-5 w-9 items-center rounded-full border transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                        dueDateNotificationsEnabled ? "bg-primary border-primary" : "bg-muted/50 border-border"
                    )}
                >
                    <span
                        className={cn(
                            "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
                            dueDateNotificationsEnabled ? "translate-x-4" : "translate-x-1"
                        )}
                    />
                </button>
            </div>

            <div className="flex items-start justify-between gap-4">
                <div>
                    <p className="text-sm font-medium">{t.reviewAtNotifications}</p>
                    <p className="text-xs text-muted-foreground mt-1">{t.reviewAtNotificationsDesc}</p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={reviewAtNotificationsEnabled}
                    onClick={() => handleUpdate({ reviewAtNotificationsEnabled: !reviewAtNotificationsEnabled })}
                    disabled={!notificationsEnabled}
                    className={cn(
                        "relative inline-flex h-5 w-9 items-center rounded-full border transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                        reviewAtNotificationsEnabled ? "bg-primary border-primary" : "bg-muted/50 border-border"
                    )}
                >
                    <span
                        className={cn(
                            "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
                            reviewAtNotificationsEnabled ? "translate-x-4" : "translate-x-1"
                        )}
                    />
                </button>
            </div>

            <div className="border-t border-border/50"></div>

            <div className="space-y-3">
                <div>
                    <p className="text-sm font-medium">{t.weeklyReview}</p>
                    <p className="text-xs text-muted-foreground mt-1">{t.weeklyReviewDesc}</p>
                </div>

                <div className="flex items-center justify-between gap-4">
                    <div className="text-sm font-medium">{t.weeklyReview}</div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={weeklyReviewEnabled}
                        onClick={() => handleUpdate({ weeklyReviewEnabled: !weeklyReviewEnabled })}
                        disabled={!notificationsEnabled}
                        className={cn(
                            "relative inline-flex h-5 w-9 items-center rounded-full border transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                            weeklyReviewEnabled ? "bg-primary border-primary" : "bg-muted/50 border-border"
                        )}
                    >
                        <span
                            className={cn(
                                "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
                                weeklyReviewEnabled ? "translate-x-4" : "translate-x-1"
                            )}
                        />
                    </button>
                </div>

                <div className="flex items-center justify-between gap-4">
                    <div className="text-sm font-medium">{t.weeklyReviewDay}</div>
                    <select
                        value={weeklyReviewDay}
                        disabled={!notificationsEnabled || !weeklyReviewEnabled}
                        onChange={(e) => handleUpdate({ weeklyReviewDay: Number(e.target.value) })}
                        className="bg-muted px-2 py-1 rounded text-sm border border-border disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {weekdayOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                </div>

                <div className="flex items-center justify-between gap-4">
                    <div className="text-sm font-medium">{t.weeklyReviewTime}</div>
                    <input
                        type="time"
                        value={weeklyReviewTime}
                        disabled={!notificationsEnabled || !weeklyReviewEnabled}
                        onChange={(e) => handleUpdate({ weeklyReviewTime: e.target.value })}
                        className="bg-muted px-2 py-1 rounded text-sm border border-border disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                </div>
            </div>

            <div className="border-t border-border/50"></div>

            <div className="space-y-3">
                <div>
                    <p className="text-sm font-medium">{t.dailyDigest}</p>
                    <p className="text-xs text-muted-foreground mt-1">{t.dailyDigestDesc}</p>
                </div>

                <div className="flex items-center justify-between gap-4">
                    <div className="text-sm font-medium">{t.dailyDigestMorning}</div>
                    <div className="flex items-center gap-3">
                        <input
                            type="time"
                            value={dailyDigestMorningTime}
                            disabled={!notificationsEnabled || !dailyDigestMorningEnabled}
                            onChange={(e) => handleUpdate({ dailyDigestMorningTime: e.target.value })}
                            className="bg-muted px-2 py-1 rounded text-sm border border-border disabled:opacity-50 disabled:cursor-not-allowed"
                        />
                        <button
                            type="button"
                            role="switch"
                            aria-checked={dailyDigestMorningEnabled}
                            onClick={() => handleUpdate({ dailyDigestMorningEnabled: !dailyDigestMorningEnabled })}
                            disabled={!notificationsEnabled}
                            className={cn(
                                "relative inline-flex h-5 w-9 items-center rounded-full border transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                                dailyDigestMorningEnabled ? "bg-primary border-primary" : "bg-muted/50 border-border"
                            )}
                        >
                            <span
                                className={cn(
                                    "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
                                    dailyDigestMorningEnabled ? "translate-x-4" : "translate-x-1"
                                )}
                            />
                        </button>
                    </div>
                </div>

                <div className="flex items-center justify-between gap-4">
                    <div className="text-sm font-medium">{t.dailyDigestEvening}</div>
                    <div className="flex items-center gap-3">
                        <input
                            type="time"
                            value={dailyDigestEveningTime}
                            disabled={!notificationsEnabled || !dailyDigestEveningEnabled}
                            onChange={(e) => handleUpdate({ dailyDigestEveningTime: e.target.value })}
                            className="bg-muted px-2 py-1 rounded text-sm border border-border disabled:opacity-50 disabled:cursor-not-allowed"
                        />
                        <button
                            type="button"
                            role="switch"
                            aria-checked={dailyDigestEveningEnabled}
                            onClick={() => handleUpdate({ dailyDigestEveningEnabled: !dailyDigestEveningEnabled })}
                            disabled={!notificationsEnabled}
                            className={cn(
                                "relative inline-flex h-5 w-9 items-center rounded-full border transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                                dailyDigestEveningEnabled ? "bg-primary border-primary" : "bg-muted/50 border-border"
                            )}
                        >
                            <span
                                className={cn(
                                    "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
                                    dailyDigestEveningEnabled ? "translate-x-4" : "translate-x-1"
                                )}
                            />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

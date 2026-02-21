import type { AppData, Attachment } from './types';

const SYNC_FILE_NAME = 'data.json';

export type PendingAttachmentUpload = {
    ownerType: 'task' | 'project';
    ownerId: string;
    attachmentId: string;
    title: string;
};

export const normalizeWebdavUrl = (rawUrl: string): string => {
    const trimmed = rawUrl.replace(/\/+$/, '');
    return trimmed.toLowerCase().endsWith(`/${SYNC_FILE_NAME}`) || trimmed.toLowerCase().endsWith('.json')
        ? trimmed
        : `${trimmed}/${SYNC_FILE_NAME}`;
};

export const normalizeCloudUrl = (rawUrl: string): string => {
    const trimmed = rawUrl.replace(/\/+$/, '');
    return trimmed.toLowerCase().endsWith('/data') ? trimmed : `${trimmed}/data`;
};

const isLocalAttachmentUri = (uri: string): boolean => {
    const trimmed = uri.trim();
    if (!trimmed) return false;
    return !/^https?:\/\//i.test(trimmed);
};

const collectPendingUploads = (
    ownerType: PendingAttachmentUpload['ownerType'],
    ownerId: string,
    attachments?: Attachment[]
): PendingAttachmentUpload[] => {
    if (!attachments || attachments.length === 0) return [];

    return attachments
        .filter((attachment) => {
            if (attachment.kind !== 'file') return false;
            if (attachment.deletedAt) return false;
            if (attachment.cloudKey) return false;
            if (!isLocalAttachmentUri(attachment.uri)) return false;
            if (attachment.localStatus === 'missing') return false;
            return true;
        })
        .map((attachment) => ({
            ownerType,
            ownerId,
            attachmentId: attachment.id,
            title: attachment.title,
        }));
};

export const findPendingAttachmentUploads = (data: AppData): PendingAttachmentUpload[] => {
    const pending: PendingAttachmentUpload[] = [];

    for (const task of data.tasks) {
        pending.push(...collectPendingUploads('task', task.id, task.attachments));
    }

    for (const project of data.projects) {
        pending.push(...collectPendingUploads('project', project.id, project.attachments));
    }

    return pending;
};

export const assertNoPendingAttachmentUploads = (data: AppData): void => {
    const pending = findPendingAttachmentUploads(data);
    if (pending.length === 0) return;

    const sample = pending
        .slice(0, 3)
        .map((item) => `${item.ownerType}:${item.ownerId}:${item.attachmentId}`)
        .join(', ');
    const extra = pending.length > 3 ? `, +${pending.length - 3} more` : '';
    throw new Error(
        `Attachment upload incomplete: ${pending.length} file attachment(s) are still pending upload (${sample}${extra}).`
    );
};

export const sanitizeAppDataForRemote = (data: AppData): AppData => {
    const sanitizeAttachments = (attachments?: Attachment[]): Attachment[] | undefined => {
        if (!attachments) return attachments;
        return attachments.map((attachment) => {
            if (attachment.kind !== 'file') return attachment;
            return {
                ...attachment,
                uri: '',
                localStatus: undefined,
            };
        });
    };

    const sanitizeSettingsForRemote = (settings: AppData['settings']): AppData['settings'] => {
        const prefs = settings.syncPreferences ?? {};
        const next: AppData['settings'] = {
            syncPreferences: { ...prefs },
            syncPreferencesUpdatedAt: settings.syncPreferencesUpdatedAt
                ? { ...settings.syncPreferencesUpdatedAt }
                : undefined,
        };

        if (prefs.appearance === true) {
            next.theme = settings.theme;
            next.appearance = settings.appearance ? { ...settings.appearance } : settings.appearance;
            next.keybindingStyle = settings.keybindingStyle;
            // Desktop global shortcut registration is local runtime behavior and should never sync.
            next.globalQuickAddShortcut = undefined;
        }

        if (prefs.language === true) {
            next.language = settings.language;
            next.weekStart = settings.weekStart;
            next.dateFormat = settings.dateFormat;
        }

        if (prefs.externalCalendars === true) {
            next.externalCalendars = settings.externalCalendars
                ? settings.externalCalendars.map((item) => ({ ...item }))
                : settings.externalCalendars;
        }

        if (prefs.ai === true && settings.ai) {
            next.ai = {
                ...settings.ai,
                apiKey: undefined,
                speechToText: settings.ai.speechToText
                    ? {
                        ...settings.ai.speechToText,
                        offlineModelPath: undefined,
                    }
                    : settings.ai.speechToText,
            };
        }

        return next;
    };

    return {
        ...data,
        tasks: data.tasks.map((task) => ({
            ...task,
            attachments: sanitizeAttachments(task.attachments),
        })),
        projects: data.projects.map((project) => ({
            ...project,
            attachments: sanitizeAttachments(project.attachments),
        })),
        settings: sanitizeSettingsForRemote(data.settings),
    };
};

const normalizeForSyncComparison = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map((item) => normalizeForSyncComparison(item));
    }
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const normalized: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) {
            normalized[key] = normalizeForSyncComparison(record[key]);
        }
        return normalized;
    }
    return value;
};

export const areSyncPayloadsEqual = (left: AppData, right: AppData): boolean =>
    JSON.stringify(normalizeForSyncComparison(left)) === JSON.stringify(normalizeForSyncComparison(right));

type ExternalCalendarProvider = {
    load: () => Promise<AppData['settings']['externalCalendars'] | undefined>;
    save: (calendars: AppData['settings']['externalCalendars'] | undefined) => Promise<void>;
    onWarn?: (message: string, error?: unknown) => void;
};

export const injectExternalCalendars = async (
    data: AppData,
    provider: ExternalCalendarProvider
): Promise<AppData> => {
    if (data.settings.syncPreferences?.externalCalendars !== true) return data;
    try {
        const stored = await provider.load();
        if (!stored || stored.length === 0) return data;
        if (data.settings.externalCalendars && data.settings.externalCalendars.length > 0) {
            return data;
        }
        return {
            ...data,
            settings: {
                ...data.settings,
                externalCalendars: stored,
            },
        };
    } catch (error) {
        provider.onWarn?.('Failed to load external calendars for sync', error);
        return data;
    }
};

export const persistExternalCalendars = async (
    data: AppData,
    provider: ExternalCalendarProvider
): Promise<void> => {
    if (data.settings.syncPreferences?.externalCalendars !== true) return;
    try {
        await provider.save(data.settings.externalCalendars ?? []);
    } catch (error) {
        provider.onWarn?.('Failed to save external calendars from sync', error);
    }
};

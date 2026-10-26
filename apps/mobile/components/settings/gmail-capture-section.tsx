import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { safeFormatDate } from '@mindwtr/core';

import { useThemeColors } from '@/hooks/use-theme-colors';
import {
    cancelGmailCapture, clearGmailReceiptsReset, configureGmailCapture, connectGmailCapture, disconnectGmailCapture,
    getGmailCaptureConfig, getGmailCaptureLabels, getGmailCaptureStatus, gmailCaptureErrorTranslation,
    gmailReceiptsWereReset, pollGmailCaptureNow, subscribeGmailCaptureStatus, toGmailCaptureError,
    type GmailCaptureConfig, type GmailCaptureLabel,
} from '@/lib/gmail-capture';

import { SettingRow } from './setting-row';
import { useSettingsLocalization } from './settings.hooks';
import { styles } from './settings.styles';

type Operation = 'connect' | 'cancel' | 'save' | 'check' | 'disconnect' | null;

export function GmailCaptureSection() {
    const tc = useThemeColors();
    const { t } = useSettingsLocalization();
    const [open, setOpen] = useState(false);
    const [config, setConfig] = useState<GmailCaptureConfig | null>(null);
    const [labels, setLabels] = useState<GmailCaptureLabel[]>([]);
    const [labelId, setLabelId] = useState('');
    const [pickerOpen, setPickerOpen] = useState(false);
    const [operation, setOperation] = useState<Operation>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [status, setStatus] = useState(getGmailCaptureStatus);
    const generation = useRef(0);
    const busy = operation !== null;

    useEffect(() => subscribeGmailCaptureStatus(setStatus), []);
    useEffect(() => {
        const current = ++generation.current;
        void (async () => {
            try {
                const next = await getGmailCaptureConfig();
                if (current !== generation.current) return;
                setConfig(next);
                // The status read opens the receipts file, so a reset it just made shows too.
                if (gmailReceiptsWereReset()) setError('settings.gmailCaptureReceiptsReset');
                if (next.connected) {
                    const nextLabels = await getGmailCaptureLabels();
                    if (current !== generation.current) return;
                    setLabels(nextLabels);
                    setLabelId(next.labelId ?? nextLabels.find((label) => label.name === 'Mindwtr')?.id ?? '');
                }
            } catch (failure) {
                if (current === generation.current) setError(gmailCaptureErrorTranslation(toGmailCaptureError(failure)));
            }
        })();
        return () => { generation.current += 1; };
    }, []);

    const runOperation = async (nextOperation: Exclude<Operation, null>, work: (current: number) => Promise<void>) => {
        const current = ++generation.current;
        setOperation(nextOperation);
        setError(null);
        setNotice(null);
        try {
            await work(current);
        } catch (failure) {
            if (current === generation.current) setError(gmailCaptureErrorTranslation(toGmailCaptureError(failure)));
        } finally {
            if (current === generation.current) setOperation(null);
        }
    };
    const retireAccount = () => {
        setConfig((previous) => previous && ({ ...previous, connected: false, account: null, accountId: null, labelId: null, enabled: false }));
        setLabels([]);
        setLabelId('');
        setPickerOpen(false);
    };
    const connect = () => runOperation('connect', async (current) => {
        retireAccount();
        const next = await connectGmailCapture();
        if (current !== generation.current) return;
        setConfig(next);
        const nextLabels = await getGmailCaptureLabels();
        if (current !== generation.current) return;
        setLabels(nextLabels);
        setLabelId(next.labelId ?? nextLabels.find((label) => label.name === 'Mindwtr')?.id ?? '');
    });
    const cancel = () => runOperation('cancel', async (current) => {
        await cancelGmailCapture();
        if (current === generation.current) setNotice('settings.gmailCaptureCancelled');
    });
    const save = () => runOperation('save', async (current) => {
        setConfig((previous) => previous && ({ ...previous, enabled: false }));
        const next = await configureGmailCapture(labelId, true);
        clearGmailReceiptsReset();
        if (current !== generation.current) return;
        setConfig(next);
        setLabelId(next.labelId ?? '');
    });
    const disconnect = () => runOperation('disconnect', async (current) => {
        retireAccount();
        const result = await disconnectGmailCapture();
        clearGmailReceiptsReset();
        if (current === generation.current) setNotice(result.revoked ? 'settings.gmailCaptureDisconnected' : 'settings.gmailCaptureRevokeManually');
    });
    const check = () => runOperation('check', async () => { await pollGmailCaptureNow(); });
    const button = (id: string, key: string, onPress: () => Promise<void>, disabled = busy) => (
        <TouchableOpacity
            testID={`gmail-${id}`}
            accessibilityRole="button"
            accessibilityLabel={t(key)}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => { void onPress(); }}
            style={[localStyles.button, { borderColor: tc.tint, opacity: disabled ? 0.5 : 1 }]}
        >
            <Text style={{ color: tc.tint, fontWeight: '600' }}>{t(key)}</Text>
        </TouchableOpacity>
    );
    const displayedError = error ?? (status.lastError ? gmailCaptureErrorTranslation(status.lastError) : null);

    return (
        <View testID="gmail-capture-section" style={[styles.settingCard, localStyles.card, { backgroundColor: tc.cardBg }]}>
            <SettingRow
                testID="gmail-expand"
                label={t('settings.gmailCapture')}
                description={t('settings.gmailCaptureDesc')}
                onPress={() => setOpen((previous) => !previous)}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
            >
                <Text style={{ color: tc.secondaryText }} aria-hidden>{open ? '▾' : '▸'}</Text>
            </SettingRow>
            {open && (
                <View style={[localStyles.body, { borderTopColor: tc.border }]}>
                    <Text style={[localStyles.description, { color: tc.secondaryText }]}>{t('settings.gmailCaptureDisclosure')}</Text>
                    {config && !config.available ? (
                        <Text style={{ color: tc.secondaryText }}>{t('settings.gmailCaptureUnavailable')}</Text>
                    ) : (
                        <>
                            {config?.connected && (
                                <>
                                    <Text selectable style={{ color: tc.text }}>{t('settings.gmailCaptureAccount')}: {config.account}</Text>
                                    <SettingRow
                                        testID="gmail-label-picker"
                                        label={t('settings.gmailCaptureLabel')}
                                        description={labels.find((label) => label.id === labelId)?.name ?? t('settings.gmailCaptureChooseLabel')}
                                        disabled={busy}
                                        onPress={() => setPickerOpen(true)}
                                        accessibilityRole="button"
                                        accessibilityState={{ disabled: busy }}
                                    />
                                    <Text style={[localStyles.description, { color: tc.secondaryText }]}>{t('settings.gmailCaptureLabelHint')}</Text>
                                    <Text testID="gmail-enabled-status" style={{ color: tc.secondaryText }}>{t(config.enabled ? 'settings.gmailCaptureActive' : 'settings.gmailCapturePaused')}</Text>
                                </>
                            )}
                            <View style={localStyles.actions}>
                                {button('connect', operation === 'connect' ? 'settings.gmailCaptureConnecting' : config?.connected ? 'settings.gmailCaptureReconnect' : 'settings.gmailCaptureConnect', connect, busy || !config?.available)}
                                {operation === 'connect' && button('cancel', 'settings.gmailCaptureCancel', cancel, false)}
                                {config?.connected && (
                                    <>
                                        {button('disconnect', 'settings.gmailCaptureDisconnect', disconnect, operation === 'disconnect' || operation === 'cancel')}
                                        {button('check', operation === 'check' ? 'settings.gmailCaptureChecking' : 'settings.gmailCaptureCheckNow', check, busy || !config.enabled || status.terminal)}
                                        {button('save', operation === 'save' ? 'settings.gmailCaptureSaving' : 'settings.gmailCaptureSave', save, busy || !labelId)}
                                    </>
                                )}
                            </View>
                        </>
                    )}
                    {status.lastPollAt && config?.connected && (
                        <Text style={[localStyles.description, { color: tc.secondaryText }]}>
                            {t('settings.gmailCaptureLastChecked')}: {safeFormatDate(status.lastPollAt, 'PPpp', status.lastPollAt)}
                            {status.lastImportCount > 0 && !status.lastError ? ` · ${t('settings.gmailCaptureImportedCount').replace('{{count}}', String(status.lastImportCount))}` : ''}
                        </Text>
                    )}
                    {displayedError && <Text accessibilityRole="alert" testID="gmail-error" style={{ color: tc.warning }}>{t(displayedError)}</Text>}
                    {notice && <Text accessibilityLiveRegion="polite" testID="gmail-notice" style={{ color: tc.secondaryText }}>{t(notice)}</Text>}
                </View>
            )}
            <Modal visible={pickerOpen} transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
                <Pressable style={styles.pickerOverlay} onPress={() => setPickerOpen(false)}>
                    <Pressable accessibilityViewIsModal style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]} onPress={(event) => event.stopPropagation()}>
                        <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('settings.gmailCaptureLabel')}</Text>
                        <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                            {labels.map((label) => (
                                <TouchableOpacity
                                    key={label.id}
                                    testID={`gmail-label-${label.id}`}
                                    accessibilityRole="radio"
                                    accessibilityState={{ checked: labelId === label.id }}
                                    onPress={() => { setLabelId(label.id); setPickerOpen(false); }}
                                    style={[styles.pickerOption, { borderColor: tc.border }]}
                                >
                                    <Text style={{ color: tc.text }}>{label.name}</Text>
                                </TouchableOpacity>
                            ))}
                        </ScrollView>
                    </Pressable>
                </Pressable>
            </Modal>
        </View>
    );
}

const localStyles = StyleSheet.create({
    card: { marginTop: 12 },
    body: { borderTopWidth: StyleSheet.hairlineWidth, padding: 16, gap: 12 },
    description: { fontSize: 13, lineHeight: 19 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    button: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, minHeight: 44, justifyContent: 'center' },
});

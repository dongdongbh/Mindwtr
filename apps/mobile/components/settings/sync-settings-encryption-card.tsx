import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from 'react-native';

import {
    generateDicewarePassphrase,
    isSyncEncryptionRemoteVersionUnavailableError,
    type AppData,
    type SyncEncryptionState,
    type SyncEncryptionTransitionProgress,
} from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';
import { logSettingsError } from '@/lib/settings-utils';
import { mobileSyncCryptoPrimitives } from '@/lib/sync-crypto-native';
import {
    changeSyncEncryptionPassphrase,
    declineSyncEncryptionPassphrase,
    disableSyncEncryption,
    enableSyncEncryption,
    getSyncEncryptionStatus,
    isSyncEncryptionBackendPending,
    provideSyncEncryptionPassphrase,
} from '@/lib/sync-encryption-service';

import { styles } from './settings.styles';

type Translate = (key: string) => string;

/** Which message the card shows after a failed transition. `rotation-first` is the
 *  one terminal case with a remedy: an interrupted passphrase change left the sync
 *  location on two salts, and only re-running the change can heal it. */
type ErrorKind =
    | 'mismatch'
    | 'wrong-passphrase'
    | 'rotation-first'
    | 'backend-required'
    | 'backend-incompatible'
    | 'generic';

type Flow = 'none' | 'enable' | 'change' | 'disable' | 'unlock';

export type SyncEncryptionCardProps = {
    /** Supplies the attachment worklist; phase 2 leaves attachments plaintext without it. */
    appData: AppData;
    t: Translate;
    tc: ThemeColors;
};

const classifyFailure = (error: unknown, terminal: ErrorKind): ErrorKind => {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    if (message.includes('SYNC_ENCRYPTION_BACKEND_REQUIRED')) return 'backend-required';
    if (isSyncEncryptionRemoteVersionUnavailableError(error)) return 'backend-incompatible';
    if (/MWENC1|SYNC_ENCRYPTION|passphrase/i.test(message)) return terminal;
    return 'generic';
};

export function SyncEncryptionCard({ appData, t, tc }: SyncEncryptionCardProps) {
    const [state, setState] = useState<SyncEncryptionState | null>(null);
    const [stateUnavailable, setStateUnavailable] = useState(false);
    const [flow, setFlow] = useState<Flow>('none');
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<SyncEncryptionTransitionProgress | null>(null);
    const [error, setError] = useState<ErrorKind | null>(null);
    const [currentPassphrase, setCurrentPassphrase] = useState('');
    const [nextPassphrase, setNextPassphrase] = useState('');
    const [confirmPassphrase, setConfirmPassphrase] = useState('');
    const [revealed, setRevealed] = useState(false);
    const [generated, setGenerated] = useState(false);

    // A status read that failed says nothing about the folder; reporting 'off'
    // would offer "Enable encryption" for a folder that may already be encrypted.
    // null is paired with stateUnavailable so the card can offer a safe retry
    // without guessing that encryption is off.
    const readState = useCallback(async (): Promise<{
        state: SyncEncryptionState | null;
        unavailable: boolean;
    }> => {
        try {
            return { state: (await getSyncEncryptionStatus()).state, unavailable: false };
        } catch (failure) {
            logSettingsError(failure);
            return { state: null, unavailable: true };
        }
    }, []);

    // Durable backend, not the screen's editor selection: a typed-but-unproven config
    // still runs transitions local-only, and the copy must say so (#1001).
    const [pendingFirstSync, setPendingFirstSync] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void readState().then((next) => {
            if (!cancelled) {
                setState(next.state);
                setStateUnavailable(next.unavailable);
            }
        });
        void isSyncEncryptionBackendPending()
            .then((pending) => {
                if (!cancelled) setPendingFirstSync(pending);
            })
            .catch(logSettingsError);
        return () => {
            cancelled = true;
        };
    }, [readState]);

    const closeFlow = useCallback(() => {
        setFlow('none');
        setCurrentPassphrase('');
        setNextPassphrase('');
        setConfirmPassphrase('');
        setRevealed(false);
        setGenerated(false);
        setError(null);
    }, []);

    const openFlow = (next: Flow) => {
        closeFlow();
        setFlow(next);
    };

    const generate = () => {
        const phrase = generateDicewarePassphrase(undefined, mobileSyncCryptoPrimitives.randomBytes);
        setNextPassphrase(phrase);
        setConfirmPassphrase(phrase);
        setRevealed(true);
        setGenerated(true);
        setError(null);
    };

    const run = async (operation: () => Promise<void>, terminal: ErrorKind) => {
        setBusy(true);
        setError(null);
        setProgress(null);
        let succeeded = false;
        try {
            await operation();
            succeeded = true;
        } catch (failure) {
            logSettingsError(failure);
            setError(classifyFailure(failure, terminal));
        }
        // Transitions are resumable, so a half-finished run still moved the state.
        const nextState = await readState();
        setState(nextState.state);
        setStateUnavailable(nextState.unavailable);
        setPendingFirstSync(await isSyncEncryptionBackendPending().catch(() => false));
        setProgress(null);
        setBusy(false);
        if (succeeded) closeFlow();
    };

    const submitEnable = () => {
        if (nextPassphrase !== confirmPassphrase) {
            setError('mismatch');
            return;
        }
        void run(
            () => enableSyncEncryption(nextPassphrase, { appData, onProgress: setProgress }),
            'generic',
        );
    };

    const submitChange = () => {
        if (nextPassphrase !== confirmPassphrase) {
            setError('mismatch');
            return;
        }
        void run(
            () => changeSyncEncryptionPassphrase(currentPassphrase, nextPassphrase, { appData, onProgress: setProgress }),
            'wrong-passphrase',
        );
    };

    const submitDisable = () => {
        void run(() => disableSyncEncryption({ appData, onProgress: setProgress }), 'rotation-first');
    };

    const submitUnlock = () => {
        void (async () => {
            setBusy(true);
            setError(null);
            let accepted = false;
            try {
                accepted = (await provideSyncEncryptionPassphrase(currentPassphrase)) === 'ok';
                if (!accepted) setError('wrong-passphrase');
            } catch (failure) {
                logSettingsError(failure);
                setError(classifyFailure(failure, 'wrong-passphrase'));
            }
            const nextState = await readState();
            setState(nextState.state);
            setStateUnavailable(nextState.unavailable);
            setBusy(false);
            if (accepted) closeFlow();
        })();
    };

    const decline = () => {
        closeFlow();
        void declineSyncEncryptionPassphrase()
            .catch(logSettingsError)
            .then(async () => {
                const nextState = await readState();
                setState(nextState.state);
                setStateUnavailable(nextState.unavailable);
            });
    };

    const retryState = () => {
        void (async () => {
            setBusy(true);
            const nextState = await readState();
            setState(nextState.state);
            setStateUnavailable(nextState.unavailable);
            setBusy(false);
        })();
    };

    if (state === null) {
        if (!stateUnavailable) return null;
        return (
            <>
                <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 16 }]}>
                    {t('settings.syncEncryption')}
                </Text>
                <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                    <View style={styles.settingRowColumn}>
                        <Text accessibilityRole="alert" style={[styles.settingDescription, { color: tc.danger }]}>
                            {t('settings.syncEncryptionStateUnavailable')}
                        </Text>
                    </View>
                    <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityState={{ busy, disabled: busy }}
                        disabled={busy}
                        onPress={retryState}
                        style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                    >
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: busy ? tc.secondaryText : tc.tint }]}>
                                {t('settings.syncEncryptionRetry')}
                            </Text>
                        </View>
                        {busy && <ActivityIndicator size="small" color={tc.tint} />}
                    </TouchableOpacity>
                </View>
            </>
        );
    }

    const errorMessage = error === 'mismatch'
        ? t('settings.syncEncryptionErrorMismatch')
        : error === 'wrong-passphrase'
            ? t('settings.syncEncryptionErrorWrongPassphrase')
            : error === 'rotation-first'
                ? t('settings.syncEncryptionErrorRotationFirst')
                : error === 'backend-required'
                    ? t('settings.syncEncryptionErrorBackendRequired')
                    : error === 'backend-incompatible'
                        ? t('settings.syncEncryptionErrorBackendIncompatible')
                        : error === 'generic'
                            ? t('settings.syncEncryptionErrorGeneric')
                            : null;

    const progressLabel = progress
        ? `${progress.phase === 'attachments'
            ? t('settings.syncEncryptionProgressAttachments')
            : t('settings.syncEncryptionProgressDocuments')} ${progress.completed} / ${progress.total}`
        : null;

    const renderPassphraseInput = (label: string, value: string, onChange: (value: string) => void) => (
        <View style={[styles.inputGroup, { borderTopWidth: 1, borderTopColor: tc.border }]}>
            <Text style={[styles.settingLabel, { color: tc.text }]}>{label}</Text>
            <TextInput
                accessibilityLabel={label}
                value={value}
                onChangeText={(text) => {
                    onChange(text);
                    setError(null);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry={!revealed}
                style={[styles.textInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
            />
        </View>
    );

    const renderAction = (label: string, onPress: () => void, disabled = false) => (
        <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{ busy, disabled: disabled || busy }}
            disabled={disabled || busy}
            onPress={onPress}
            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
        >
            <View style={styles.settingInfo}>
                <Text style={[styles.settingLabel, { color: disabled || busy ? tc.secondaryText : tc.tint }]}>
                    {label}
                </Text>
            </View>
            {busy && <ActivityIndicator size="small" color={tc.tint} />}
        </TouchableOpacity>
    );

    const renderRevealToggle = () => (
        <TouchableOpacity
            accessibilityRole="switch"
            accessibilityState={{ checked: revealed }}
            onPress={() => setRevealed((shown) => !shown)}
            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
        >
            <View style={styles.settingInfo}>
                <Text style={[styles.settingLabel, { color: tc.tint }]}>
                    {t('settings.syncEncryptionShowPassphrase')}
                </Text>
            </View>
        </TouchableOpacity>
    );

    return (
        <>
            <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 16 }]}>
                {t('settings.syncEncryption')}
            </Text>
            <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                {state === 'off' && (
                    <>
                        <View style={styles.settingRowColumn}>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                {t('settings.syncEncryptionDesc')}
                            </Text>
                        </View>
                        {flow !== 'enable'
                            ? renderAction(t('settings.syncEncryptionEnable'), () => openFlow('enable'))
                            : (
                                <>
                                    <View style={[styles.settingRowColumn, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                        <Text style={[styles.settingDescription, { color: tc.warning }]}>
                                            {t('settings.syncEncryptionWarningLost')}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.warning, marginTop: 8 }]}>
                                            {t('settings.syncEncryptionWarningDevices')}
                                        </Text>
                                        {pendingFirstSync && (
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 8 }]}>
                                                {t('settings.syncEncryptionEnableBeforeFirstSyncHint')}
                                            </Text>
                                        )}
                                    </View>
                                    {renderPassphraseInput(t('settings.syncEncryptionPassphrase'), nextPassphrase, setNextPassphrase)}
                                    {renderPassphraseInput(t('settings.syncEncryptionPassphraseConfirm'), confirmPassphrase, setConfirmPassphrase)}
                                    {renderRevealToggle()}
                                    {renderAction(t('settings.syncEncryptionGenerate'), generate)}
                                    {generated && (
                                        <View style={styles.settingRowColumn}>
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                                {t('settings.syncEncryptionGeneratedHint')}
                                            </Text>
                                        </View>
                                    )}
                                    {renderAction(
                                        t('settings.syncEncryptionEnable'),
                                        submitEnable,
                                        !nextPassphrase || !confirmPassphrase,
                                    )}
                                    {renderAction(t('common.cancel'), closeFlow)}
                                </>
                            )}
                    </>
                )}

                {(state === 'enabled' || state === 'remote-plaintext') && (
                    <>
                        <View style={styles.settingRowColumn}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>
                                {t('settings.syncEncryptionStatusOn')}
                            </Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                {state === 'remote-plaintext'
                                    ? t('settings.syncEncryptionRemotePlaintextDesc')
                                    : t('settings.syncEncryptionDesc')}
                            </Text>
                        </View>
                        {flow === 'none' && (
                            <>
                                {/* Changing the passphrase would run against a location that no
                                    longer holds ciphertext — disabling here is the only remedy. */}
                                {state === 'enabled' && renderAction(t('settings.syncEncryptionChange'), () => openFlow('change'))}
                                {renderAction(t('settings.syncEncryptionDisable'), () => openFlow('disable'))}
                            </>
                        )}
                        {flow === 'change' && (
                            <>
                                {renderPassphraseInput(t('settings.syncEncryptionCurrentPassphrase'), currentPassphrase, setCurrentPassphrase)}
                                {renderPassphraseInput(t('settings.syncEncryptionNewPassphrase'), nextPassphrase, setNextPassphrase)}
                                {renderPassphraseInput(t('settings.syncEncryptionPassphraseConfirm'), confirmPassphrase, setConfirmPassphrase)}
                                {renderRevealToggle()}
                                {renderAction(t('settings.syncEncryptionGenerate'), generate)}
                                {generated && (
                                    <View style={styles.settingRowColumn}>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {t('settings.syncEncryptionGeneratedHint')}
                                        </Text>
                                    </View>
                                )}
                                {renderAction(
                                    t('settings.syncEncryptionChange'),
                                    submitChange,
                                    !currentPassphrase || !nextPassphrase || !confirmPassphrase,
                                )}
                                {renderAction(t('common.cancel'), closeFlow)}
                            </>
                        )}
                        {flow === 'disable' && (
                            <>
                                <View style={[styles.settingRowColumn, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <Text style={[styles.settingDescription, { color: tc.warning }]}>
                                        {t(pendingFirstSync
                                            ? 'settings.syncEncryptionDisableWarningNoBackend'
                                            : 'settings.syncEncryptionDisableWarning')}
                                    </Text>
                                </View>
                                {renderAction(t('settings.syncEncryptionDisable'), submitDisable)}
                                {renderAction(t('common.cancel'), closeFlow)}
                            </>
                        )}
                    </>
                )}

                {state === 'remote-encrypted-no-key' && (
                    <>
                        <View style={styles.settingRowColumn}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>
                                {t('settings.syncEncryptionLockedTitle')}
                            </Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                {t('settings.syncEncryptionLockedDesc')}
                            </Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 8 }]}>
                                {t('settings.syncEncryptionPausedDesc')}
                            </Text>
                        </View>
                        {flow !== 'unlock'
                            ? renderAction(t('settings.syncEncryptionUnlock'), () => openFlow('unlock'))
                            : (
                                <>
                                    {renderPassphraseInput(t('settings.syncEncryptionPassphrase'), currentPassphrase, setCurrentPassphrase)}
                                    {renderRevealToggle()}
                                    {renderAction(t('settings.syncEncryptionUnlock'), submitUnlock, !currentPassphrase)}
                                    {renderAction(t('settings.syncEncryptionDecline'), decline)}
                                </>
                            )}
                    </>
                )}

                {progressLabel && (
                    <View style={[styles.settingRowColumn, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                        <Text accessibilityLiveRegion="polite" style={[styles.settingDescription, { color: tc.secondaryText }]}>
                            {progressLabel}
                        </Text>
                    </View>
                )}
                {errorMessage && (
                    <View style={[styles.settingRowColumn, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                        <Text accessibilityLiveRegion="polite" style={[styles.settingDescription, { color: tc.danger }]}>{errorMessage}</Text>
                    </View>
                )}
            </View>
        </>
    );
}

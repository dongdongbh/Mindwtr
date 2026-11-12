import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from 'react-native';

import {
    getDocsGuideUrl,
    type AppData,
    type Language,
} from '@mindwtr/core';
import {
    createSyncEncryptionCard,
    getSyncEncryptionCardMessages,
    isSyncEncryptionUpgradeAvailable,
    type SyncEncryptionPassphraseField,
} from '@mindwtr/core/sync-encryption-card';

import type { ThemeColors } from '@/hooks/use-theme-colors';
import { logSettingsError } from '@/lib/settings-utils';
import { mobileSyncCryptoPrimitives } from '@/lib/sync-crypto-native';
import {
    abandonSyncEncryptionTransition,
    changeSyncEncryptionPassphrase,
    declineSyncEncryptionPassphrase,
    disableSyncEncryption,
    enableSyncEncryption,
    upgradeSyncEncryption,
    getSyncEncryptionStatus,
    isSyncEncryptionBackendPending,
    isSyncEncryptionCleanupDeferredError,
    provideSyncEncryptionPassphrase,
    recheckPartlyEncryptedLocation,
} from '@/lib/sync-encryption-service';

import { SettingsGuideLink } from './settings.shell';
import { styles } from './settings.styles';

type Translate = (key: string) => string;

export type SyncEncryptionCardProps = {

    appData: AppData;
    t: Translate;
    tc: ThemeColors;
    language?: Language;


    transportBusy?: boolean;
};


export function SyncEncryptionCard({ appData, t, tc, language, transportBusy = false }: SyncEncryptionCardProps) {
    const appDataRef = useRef(appData);
    appDataRef.current = appData;

    const [card] = useState(() => createSyncEncryptionCard({
        getStatus: () => getSyncEncryptionStatus(),
        isBackendPending: () => isSyncEncryptionBackendPending(),
        enable: (passphrase, options) => enableSyncEncryption(passphrase, options),
        upgrade: (passphrase, options) => upgradeSyncEncryption(passphrase, options),
        change: (current, next, options) => changeSyncEncryptionPassphrase(current, next, options),
        disable: (options) => disableSyncEncryption(options),
        provide: (passphrase) => provideSyncEncryptionPassphrase(passphrase),
        decline: () => declineSyncEncryptionPassphrase(),
        abandon: () => abandonSyncEncryptionTransition(),
        recheck: () => recheckPartlyEncryptedLocation(),
        isCleanupDeferredError: (error): error is Error & { cleanupKind?: string; outcome?: unknown } => isSyncEncryptionCleanupDeferredError(error),
        randomBytes: (length) => mobileSyncCryptoPrimitives.randomBytes(length),
        appData: () => appDataRef.current,
        logSettingsError: (error) => logSettingsError(error),
    }));
    const cardState = useSyncExternalStore(card.subscribe, card.getState);
    const {
        state,
        stateUnavailable,
        incompleteTransition,
        partlyEncrypted,
        flow,
        busy,
        currentPassphrase,
        nextPassphrase,
        confirmPassphrase,
        revealed,
        generated,
        pendingFirstSync,
    } = cardState;

    useEffect(() => card.refresh(), [card]);


    const previousTransportBusy = React.useRef(transportBusy);
    useEffect(() => {
        const wasBusy = previousTransportBusy.current;
        previousTransportBusy.current = transportBusy;
        if (!wasBusy || transportBusy) return;
        return card.refresh();
    }, [transportBusy, card]);

    const closeFlow = card.closeFlow;
    const openFlow = card.openFlow;
    const generate = card.generate;
    const submitEnable = () => {
        void card.submitEnable();
    };
    const submitChange = () => {
        void card.submitChange();
    };
    const submitDisable = () => {
        void card.submitDisable();
    };
    const submitAbandon = () => {
        void card.submitAbandon();
    };
    const recheckLocation = () => {
        void card.recheckLocation();
    };
    const submitUnlock = () => {
        void card.submitUnlock();
    };
    const decline = () => {
        void card.decline();
    };
    const retryState = () => {
        void card.retryState();
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

    const { errorMessage, progressLabel, warningMessage } = getSyncEncryptionCardMessages(cardState, t);

    const renderPassphraseInput = (label: string, value: string, field: SyncEncryptionPassphraseField) => (
        <View style={[styles.inputGroup, { borderTopWidth: 1, borderTopColor: tc.border }]}>
            <Text style={[styles.settingLabel, { color: tc.text }]}>{label}</Text>
            <TextInput
                accessibilityLabel={label}
                value={value}
                onChangeText={(text) => card.setField(field, text)}
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


    const errorBlock = errorMessage
        ? (
            <View style={[styles.settingRowColumn, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                <Text
                    accessibilityLiveRegion="assertive"
                    accessibilityRole="alert"
                    style={[styles.settingDescription, { color: tc.danger }]}
                >
                    {errorMessage}
                </Text>
            </View>
        )
        : null;

    const renderRevealToggle = () => (
        <TouchableOpacity
            accessibilityRole="switch"
            accessibilityState={{ checked: revealed }}
            onPress={card.toggleRevealed}
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
            <SettingsGuideLink
                title={t('settings.syncEncryptionGuideTitle')}
                description={t('settings.syncEncryptionGuideDesc')}
                url={getDocsGuideUrl('data-sync/', language, 'sync-encryption')}
                testID="sync-encryption-guide-link"
            />
            <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                {                                                                                         }
                {state === 'off' && partlyEncrypted && (
                    <>
                        <View style={styles.settingRowColumn}>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                {t('settings.syncEncryptionDesc')}
                            </Text>
                        </View>
                        <View style={[styles.settingRowColumn, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                            <Text accessibilityRole="alert" style={[styles.settingDescription, { color: tc.danger }]}>
                                {t('settings.syncEncryptionPartlyEncrypted')}
                            </Text>
                        </View>
                        {renderAction(t('settings.syncEncryptionRecheck'), recheckLocation)}
                    </>
                )}

                {state === 'off' && !partlyEncrypted && (
                    <>
                        <View style={styles.settingRowColumn}>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                {t('settings.syncEncryptionDesc')}
                            </Text>
                        </View>
                        {flow === 'none' && renderAction(t('settings.syncEncryptionEnable'), () => openFlow('enable'))}
                        {flow === 'enable' && (
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
                                {renderPassphraseInput(t('settings.syncEncryptionPassphrase'), nextPassphrase, 'next')}
                                {renderPassphraseInput(t('settings.syncEncryptionPassphraseConfirm'), confirmPassphrase, 'confirm')}
                                {errorBlock}
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
                                {
                                                                                                     }
                                {state === 'enabled' && renderAction(t('settings.syncEncryptionChange'), () => openFlow('change'))}
                                {renderAction(t('settings.syncEncryptionDisable'), () => openFlow('disable'))}
                            </>
                        )}
                        {flow === 'change' && (
                            <>
                                {renderPassphraseInput(t('settings.syncEncryptionCurrentPassphrase'), currentPassphrase, 'current')}
                                {renderPassphraseInput(t('settings.syncEncryptionNewPassphrase'), nextPassphrase, 'next')}
                                {renderPassphraseInput(t('settings.syncEncryptionPassphraseConfirm'), confirmPassphrase, 'confirm')}
                                {errorBlock}
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
                                {errorBlock}
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
                            <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 8 }]}>
                                {t('settings.syncEncryptionLockedRecheckHint')}
                            </Text>
                        </View>
                        {flow === 'none' && renderAction(t('settings.syncEncryptionUnlock'), () => openFlow('unlock'))}
                        {flow === 'unlock' && (
                            <>
                                {renderPassphraseInput(t('settings.syncEncryptionPassphrase'), currentPassphrase, 'current')}
                                {errorBlock}
                                {renderRevealToggle()}
                                {renderAction(t('settings.syncEncryptionUnlock'), submitUnlock, !currentPassphrase)}
                                {renderAction(t('settings.syncEncryptionDecline'), decline)}
                            </>
                        )}
                    </>
                )}

                {                                                                                           }
                {flow === 'none' && isSyncEncryptionUpgradeAvailable(cardState)
                    && renderAction(t('settings.syncEncryptionUpgrade'), () => openFlow('upgrade'))}
                {flow === 'upgrade' && (
                    <>
                        <View style={[styles.settingRowColumn, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                            <Text style={[styles.settingDescription, { color: tc.warning }]}>
                                {t('settings.syncEncryptionUpgradeWarning')}
                            </Text>
                        </View>
                        {renderPassphraseInput(t('settings.syncEncryptionCurrentPassphrase'), currentPassphrase, 'current')}
                        {errorBlock}
                        {renderRevealToggle()}
                        {renderAction(t('settings.syncEncryptionUpgrade'), () => { void card.submitUpgrade(); }, !currentPassphrase)}
                        {renderAction(t('common.cancel'), closeFlow)}
                    </>
                )}

                {flow === 'abandon' && (
                    <>
                        <View style={[styles.settingRowColumn, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                            <Text style={[styles.settingDescription, { color: tc.warning }]}>
                                {t('settings.syncEncryptionAbandonWarning')}
                            </Text>
                        </View>
                        {errorBlock}
                        {renderAction(t('settings.syncEncryptionAbandon'), submitAbandon)}
                        {renderAction(t('common.cancel'), closeFlow)}
                    </>
                )}

                {progressLabel && (
                    <View style={[styles.settingRowColumn, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                        <Text accessibilityLiveRegion="polite" style={[styles.settingDescription, { color: tc.secondaryText }]}>
                            {progressLabel}
                        </Text>
                    </View>
                )}
                {warningMessage && (
                    <View style={[styles.settingRowColumn, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                        <Text accessibilityLiveRegion="polite" style={[styles.settingDescription, { color: tc.warning }]}>
                            {warningMessage}
                        </Text>
                    </View>
                )}
                {
                                                                 }
                {flow === 'none' && errorBlock}
                {flow !== 'abandon' && incompleteTransition
                    && renderAction(t('settings.syncEncryptionAbandon'), () => openFlow('abandon'))}
            </View>
        </>
    );
}

import { useState } from 'react';
import { Eye, EyeOff, Lock } from 'lucide-react';

import { SettingField } from '../SettingRow';
import type { SettingsSyncPageProps } from './types';

type SyncEncryptionSectionProps = Pick<SettingsSyncPageProps, 't' | 'encryption'>;

// One flow open at a time. The section is a settings row, not a wizard: the form
// opens in place under the button that asked for it and closes when it is done.
type Flow = 'none' | 'enable' | 'change' | 'disable' | 'unlock';

const INPUT_CLS = 'w-full bg-muted p-2 rounded text-sm border border-border focus:outline-none focus:ring-2 focus:ring-primary';
const PRIMARY_BUTTON_CLS = 'px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 whitespace-nowrap disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed';
const SECONDARY_BUTTON_CLS = 'px-4 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium hover:bg-secondary/90 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed';

export function SyncEncryptionSection({ encryption, t }: SyncEncryptionSectionProps) {
    const [flow, setFlow] = useState<Flow>('none');
    const [currentPassphrase, setCurrentPassphrase] = useState('');
    const [nextPassphrase, setNextPassphrase] = useState('');
    const [confirmPassphrase, setConfirmPassphrase] = useState('');
    const [revealed, setRevealed] = useState(false);
    const [mismatch, setMismatch] = useState(false);
    const [generated, setGenerated] = useState(false);

    const { busy, error, progress, state, supported } = encryption;

    const closeFlow = () => {
        setFlow('none');
        setCurrentPassphrase('');
        setNextPassphrase('');
        setConfirmPassphrase('');
        setRevealed(false);
        setMismatch(false);
        setGenerated(false);
        encryption.clearError();
    };

    const openFlow = (next: Flow) => {
        closeFlow();
        setFlow(next);
    };

    const generate = () => {
        const phrase = encryption.generatePassphrase();
        setNextPassphrase(phrase);
        setConfirmPassphrase(phrase);
        setRevealed(true);
        setGenerated(true);
        setMismatch(false);
    };

    const submit = async () => {
        if (flow === 'unlock') {
            if (await encryption.unlock(currentPassphrase)) closeFlow();
            return;
        }
        if (flow === 'disable') {
            if (await encryption.disable()) closeFlow();
            return;
        }
        if (nextPassphrase !== confirmPassphrase) {
            setMismatch(true);
            return;
        }
        setMismatch(false);
        const done = flow === 'enable'
            ? await encryption.enable(nextPassphrase)
            : await encryption.changePassphrase(currentPassphrase, nextPassphrase);
        if (done) closeFlow();
    };

    // Rendered after the hooks so the component's hook order never depends on the
    // backend: `supported` flips whenever the user changes the sync backend.
    if (!supported) return null;
    if (state === null) {
        if (!encryption.stateUnavailable) return null;
        return (
            <section className="space-y-3">
                <h2 data-settings-key="syncEncryption" className="text-lg font-semibold flex items-center gap-2">
                    <Lock className="w-5 h-5" />
                    {t.syncEncryption}
                </h2>
                <div className="bg-card border border-border rounded-lg p-6 space-y-4">
                    <p role="alert" className="text-sm text-destructive">
                        {t.syncEncryptionStateUnavailable}
                    </p>
                    <div className="flex justify-end">
                        <button
                            type="button"
                            onClick={() => void encryption.retryState()}
                            disabled={busy}
                            aria-busy={busy}
                            className={PRIMARY_BUTTON_CLS}
                        >
                            {t.syncEncryptionRetry}
                        </button>
                    </div>
                </div>
            </section>
        );
    }

    const errorMessage = mismatch
        ? t.syncEncryptionErrorMismatch
        : error === 'wrong-passphrase'
            ? t.syncEncryptionErrorWrongPassphrase
            : error === 'rotation-first'
                ? t.syncEncryptionErrorRotationFirst
                : error === 'backend-required'
                    ? t.syncEncryptionErrorBackendRequired
                    : error === 'generic'
                        ? t.syncEncryptionErrorGeneric
                        : null;

    const progressLabel = progress
        ? `${progress.phase === 'attachments' ? t.syncEncryptionProgressAttachments : t.syncEncryptionProgressDocuments} ${progress.completed} / ${progress.total}`
        : null;

    const passphraseInput = (
        label: string,
        value: string,
        onChange: (value: string) => void,
        autoFocus = false,
    ) => (
        <SettingField settingsKey={null} title={label}>
            <div className="flex items-center gap-2">
                <input
                    type={revealed ? 'text' : 'password'}
                    value={value}
                    autoFocus={autoFocus}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={label}
                    onChange={(event) => {
                        onChange(event.target.value);
                        setMismatch(false);
                    }}
                    className={INPUT_CLS}
                />
                <button
                    type="button"
                    aria-label={t.syncEncryptionShowPassphrase}
                    aria-pressed={revealed}
                    onClick={() => setRevealed((shown) => !shown)}
                    className="p-2 rounded-md text-muted-foreground hover:bg-muted shrink-0"
                >
                    {revealed ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
            </div>
        </SettingField>
    );

    const formActions = (confirmLabel: string, disabled: boolean) => (
        <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" onClick={closeFlow} disabled={busy} className={SECONDARY_BUTTON_CLS}>
                {t.syncEncryptionCancel}
            </button>
            <button
                type="button"
                onClick={() => void submit()}
                disabled={disabled || busy}
                aria-busy={busy}
                className={PRIMARY_BUTTON_CLS}
            >
                {confirmLabel}
            </button>
        </div>
    );

    return (
        <section className="space-y-3">
            <h2 data-settings-key="syncEncryption" className="text-lg font-semibold flex items-center gap-2">
                <Lock className="w-5 h-5" />
                {t.syncEncryption}
            </h2>
            <div className="bg-card border border-border rounded-lg p-6 space-y-4">
                {state === 'off' && (
                    <>
                        <p className="text-sm text-muted-foreground">{t.syncEncryptionDesc}</p>
                        {flow !== 'enable' ? (
                            <div className="flex justify-end">
                                <button type="button" onClick={() => openFlow('enable')} className={PRIMARY_BUTTON_CLS}>
                                    {t.syncEncryptionEnable}
                                </button>
                            </div>
                        ) : (
                            <div className="space-y-4 border-t border-border pt-4">
                                <p className="text-sm text-warning">{t.syncEncryptionWarningLost}</p>
                                <p className="text-sm text-warning">{t.syncEncryptionWarningDevices}</p>
                                {encryption.pendingFirstSync && (
                                    <p className="text-sm text-muted-foreground">{t.syncEncryptionEnableBeforeFirstSyncHint}</p>
                                )}
                                {passphraseInput(t.syncEncryptionPassphrase, nextPassphrase, setNextPassphrase, true)}
                                {passphraseInput(t.syncEncryptionPassphraseConfirm, confirmPassphrase, setConfirmPassphrase)}
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <button type="button" onClick={generate} disabled={busy} className={SECONDARY_BUTTON_CLS}>
                                        {t.syncEncryptionGenerate}
                                    </button>
                                    {generated && (
                                        <p className="text-xs text-muted-foreground">{t.syncEncryptionGeneratedHint}</p>
                                    )}
                                </div>
                                {formActions(t.syncEncryptionEnable, !nextPassphrase || !confirmPassphrase)}
                            </div>
                        )}
                    </>
                )}

                {(state === 'enabled' || state === 'remote-plaintext') && (
                    <>
                        <p className="text-sm font-medium">{t.syncEncryptionStatusOn}</p>
                        <p className="text-sm text-muted-foreground">
                            {state === 'remote-plaintext' ? t.syncEncryptionRemotePlaintextDesc : t.syncEncryptionDesc}
                        </p>
                        {flow === 'none' && (
                            <div className="flex flex-wrap items-center justify-end gap-2">
                                {/* Changing the passphrase would run against a location that no
                                    longer holds ciphertext — disabling here is the only remedy. */}
                                {state === 'enabled' && (
                                    <button type="button" onClick={() => openFlow('change')} className={SECONDARY_BUTTON_CLS}>
                                        {t.syncEncryptionChange}
                                    </button>
                                )}
                                <button type="button" onClick={() => openFlow('disable')} className={SECONDARY_BUTTON_CLS}>
                                    {t.syncEncryptionDisable}
                                </button>
                            </div>
                        )}
                        {flow === 'change' && (
                            <div className="space-y-4 border-t border-border pt-4">
                                {passphraseInput(t.syncEncryptionCurrentPassphrase, currentPassphrase, setCurrentPassphrase, true)}
                                {passphraseInput(t.syncEncryptionNewPassphrase, nextPassphrase, setNextPassphrase)}
                                {passphraseInput(t.syncEncryptionPassphraseConfirm, confirmPassphrase, setConfirmPassphrase)}
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <button type="button" onClick={generate} disabled={busy} className={SECONDARY_BUTTON_CLS}>
                                        {t.syncEncryptionGenerate}
                                    </button>
                                    {generated && (
                                        <p className="text-xs text-muted-foreground">{t.syncEncryptionGeneratedHint}</p>
                                    )}
                                </div>
                                {formActions(
                                    t.syncEncryptionChange,
                                    !currentPassphrase || !nextPassphrase || !confirmPassphrase,
                                )}
                            </div>
                        )}
                        {flow === 'disable' && (
                            <div className="space-y-4 border-t border-border pt-4">
                                <p className="text-sm text-warning">
                                    {encryption.pendingFirstSync
                                        ? t.syncEncryptionDisableWarningNoBackend
                                        : t.syncEncryptionDisableWarning}
                                </p>
                                {formActions(t.syncEncryptionDisable, false)}
                            </div>
                        )}
                    </>
                )}

                {state === 'remote-encrypted-no-key' && (
                    <>
                        <p className="text-sm font-medium">{t.syncEncryptionLockedTitle}</p>
                        <p className="text-sm text-muted-foreground">{t.syncEncryptionLockedDesc}</p>
                        <p className="text-sm text-muted-foreground">{t.syncEncryptionPausedDesc}</p>
                        {flow !== 'unlock' ? (
                            <div className="flex justify-end">
                                <button type="button" onClick={() => openFlow('unlock')} className={PRIMARY_BUTTON_CLS}>
                                    {t.syncEncryptionUnlock}
                                </button>
                            </div>
                        ) : (
                            <div className="space-y-4 border-t border-border pt-4">
                                {passphraseInput(t.syncEncryptionPassphrase, currentPassphrase, setCurrentPassphrase, true)}
                                <div className="flex flex-wrap items-center justify-end gap-2">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            closeFlow();
                                            void encryption.decline();
                                        }}
                                        disabled={busy}
                                        className={SECONDARY_BUTTON_CLS}
                                    >
                                        {t.syncEncryptionDecline}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void submit()}
                                        disabled={!currentPassphrase || busy}
                                        aria-busy={busy}
                                        className={PRIMARY_BUTTON_CLS}
                                    >
                                        {t.syncEncryptionUnlock}
                                    </button>
                                </div>
                            </div>
                        )}
                    </>
                )}

                {progressLabel && <p className="text-sm text-muted-foreground" role="status">{progressLabel}</p>}
                {errorMessage && <p className="text-sm text-destructive" role="alert">{errorMessage}</p>}
            </div>
        </section>
    );
}

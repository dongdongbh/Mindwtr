import { Alert, type AlertButton } from 'react-native';

type Translate = (key: string) => string;

export function confirmMobileSandboxEntry(t: Translate, onEnter: () => void): void {
    const buttons: AlertButton[] = [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('sandbox.enter'), onPress: onEnter },
    ];
    Alert.alert(
        t('sandbox.confirmTitle'),
        t('sandbox.confirmDescription'),
        buttons,
    );
}

/** Check again when Enter is pressed because another operation may start while the alert is open. */
export function requestMobileSandboxEntry(
    t: Translate,
    onEnter: () => void,
    isBlocked: () => boolean,
): boolean {
    if (isBlocked()) return false;
    confirmMobileSandboxEntry(t, () => {
        if (!isBlocked()) onEnter();
    });
    return true;
}

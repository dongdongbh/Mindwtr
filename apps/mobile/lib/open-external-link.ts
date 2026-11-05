import { Alert } from 'react-native';
import * as Linking from 'expo-linking';
import * as Clipboard from 'expo-clipboard';
import { isSandboxMode, tFallback } from '@mindwtr/core';
import { logInfo, logWarn } from './app-log';


export async function openExternalLink(
  href: string,
  t: (key: string) => string,
  surface: 'markdown' | 'attachment',
): Promise<void> {
  if (isSandboxMode()) {
    Alert.alert(t('common.notice'), t('sandbox.unavailable'));
    return;
  }
  const isUpNote = /^upnote:\/\//i.test(href);
  const logOutcome = (outcome: 'opened' | 'failed') => {
    if (!isUpNote) return;
    const log = outcome === 'opened' ? logInfo : logWarn;
    void log('External app link handoff', {
      scope: 'links', force: true,
      extra: { outcome, surface, scheme: 'upnote' },
    }).catch(() => undefined);
  };
  try {
    await Linking.openURL(href);
    logOutcome('opened');
  } catch {
    logOutcome('failed');
    Alert.alert(t('common.error'), tFallback(t, 'markdown.openLinkFailed',
      'Could not open this link. Make sure the app that handles it is installed. You can copy the link and open it there.'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: tFallback(t, 'markdown.copyLink', 'Copy link'),
        onPress: () => {
          void Clipboard.setStringAsync(href).catch(() => {
            Alert.alert(t('common.error'), tFallback(t, 'markdown.copyLinkFailed', 'Could not copy this link.'));
          });
        },
      },
    ]);
  }
}

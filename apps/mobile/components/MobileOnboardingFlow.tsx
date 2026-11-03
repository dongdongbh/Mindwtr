import React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { Database, Download, RefreshCw, X } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { useLanguage } from '@/contexts/language-context';

type MobileOnboardingFlowProps = {
  busy?: boolean;
  error?: string | null;
  isOpen: boolean;
  onOpenImport: () => void;
  onOpenSync: () => void;
  onSkip: () => void;
  onStartFresh: () => void;
};

export function MobileOnboardingFlow({
  busy = false,
  error = null,
  isOpen,
  onOpenImport,
  onOpenSync,
  onSkip,
  onStartFresh,
}: MobileOnboardingFlowProps) {
  const tc = useThemeColors();
  const filledButton = useFilledButtonColors();
  const onFilled = filledButton.textColor ?? tc.onTint;
  const { t } = useLanguage();
  const { fontScale } = useWindowDimensions();


  const stackFooter = fontScale >= 1.5;

  return (
    <Modal
      animationType="fade"
      transparent
      visible={isOpen}
      onRequestClose={() => { if (!busy) onSkip(); }}
    >
      <SafeAreaView style={styles.overlay}>
        <View style={[styles.card, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
          <ScrollView bounces={false}>
            <View style={[styles.header, { borderBottomColor: tc.border }]}>
              <View style={styles.headerText}>
                <Text style={[styles.title, { color: tc.text }]}>{t('onboarding.title')}</Text>
                <Text style={[styles.subtitle, { color: tc.secondaryText }]}>
                  {t('onboarding.subtitle')}
                </Text>
              </View>
            </View>
            <View style={styles.body}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ busy, disabled: busy }}
              activeOpacity={0.82}
              disabled={busy}
              onPress={onStartFresh}
              style={[
                styles.option,
                styles.primaryOption,
                { backgroundColor: filledButton.backgroundColor, borderColor: filledButton.backgroundColor, opacity: busy ? 0.68 : 1 },
              ]}
            >
              <View style={[styles.iconSlot, styles.primaryIconSlot]}>
                {busy ? (
                  <ActivityIndicator color={onFilled} size="small" />
                ) : (
                  <Database color={onFilled} size={22} strokeWidth={2.2} />
                )}
              </View>
              <View style={styles.optionText}>
                <Text style={[styles.primaryOptionTitle, { color: onFilled }]}>{busy ? t('onboarding.startFreshBusy') : t('onboarding.startFreshTitle')}</Text>
                <Text style={[styles.primaryOptionDescription, { color: onFilled }]}>
                  {t('onboarding.startFreshDesc')}
                </Text>
              </View>
            </TouchableOpacity>
            <OnboardingOption
              disabled={busy}
              description={t('onboarding.syncDesc')}
              icon={<RefreshCw color={tc.tint} size={22} strokeWidth={2.2} />}
              onPress={onOpenSync}
              title={t('onboarding.syncTitle')}
            />
            <OnboardingOption
              disabled={busy}
              description={t('onboarding.importDescMobile')}
              icon={<Download color={tc.tint} size={22} strokeWidth={2.2} />}
              onPress={onOpenImport}
              title={t('onboarding.importTitle')}
            />
            {error ? (
              <View style={[styles.errorBox, { borderColor: tc.danger, backgroundColor: `${tc.danger}18` }]}>
                <Text style={[styles.errorText, { color: tc.danger }]}>{error}</Text>
              </View>
            ) : null}
            </View>

            <View style={[styles.footer, stackFooter ? styles.footerStacked : null, { borderTopColor: tc.border }]}>
              <Text style={[styles.footerText, stackFooter ? styles.footerTextStacked : null, { color: tc.secondaryText }]}>
                {t('onboarding.footer')}
              </Text>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={onSkip}
                style={stackFooter ? styles.skipButtonStacked : null}
              >
                <Text style={[styles.skipText, { color: busy ? tc.secondaryText : tc.tint }]}>{t('onboarding.skipForNow')}</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>

          <Pressable
            accessibilityLabel={t('onboarding.skip')}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            hitSlop={8}
            onPress={onSkip}
            style={({ pressed }) => [
              styles.closeButton,
              { backgroundColor: tc.cardBg, opacity: pressed ? 0.72 : busy ? 0.45 : 1 },
            ]}
          >
            <X color={tc.secondaryText} size={22} strokeWidth={2.2} />
          </Pressable>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function OnboardingOption({
  description,
  disabled,
  icon,
  onPress,
  title,
}: {
  description: string;
  disabled?: boolean;
  icon: React.ReactNode;
  onPress: () => void;
  title: string;
}) {
  const tc = useThemeColors();

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled === true }}
      activeOpacity={0.78}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.option,
        {
          backgroundColor: tc.inputBg,
          borderColor: tc.border,
          opacity: disabled ? 0.58 : 1,
        },
      ]}
    >
      <View style={[styles.iconSlot, { backgroundColor: `${tc.tint}18` }]}>{icon}</View>
      <View style={styles.optionText}>
        <Text style={[styles.optionTitle, { color: tc.text }]}>{title}</Text>
        <Text style={[styles.optionDescription, { color: tc.secondaryText }]}>{description}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.68)',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 20,
  },
  card: {
    width: '100%',
    maxHeight: '92%',
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  header: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 20,
    paddingVertical: 18,
  },
  headerText: {
    minWidth: 0,

    paddingRight: 38,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 21,
    marginTop: 6,
  },
  closeButton: {
    alignItems: 'center',
    borderRadius: 19,
    height: 38,
    justifyContent: 'center',
    position: 'absolute',
    right: 12,
    top: 12,
    width: 38,
  },
  body: {
    gap: 12,
    padding: 20,
  },
  option: {
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 14,
    minHeight: 88,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  primaryOption: {
    minHeight: 92,
  },
  iconSlot: {
    alignItems: 'center',
    borderRadius: 10,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  primaryIconSlot: {
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
  },
  optionText: {
    flex: 1,
    justifyContent: 'center',
    minWidth: 0,
  },
  optionTitle: {
    fontSize: 17,
    fontWeight: '800',
  },
  optionDescription: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: 4,
  },
  primaryOptionTitle: {
    fontSize: 17,
    fontWeight: '800',
  },
  primaryOptionDescription: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: 4,
    opacity: 0.84,
  },
  errorBox: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  errorText: {
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  footer: {
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  footerStacked: {
    alignItems: 'stretch',
    flexDirection: 'column',
  },
  footerText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  footerTextStacked: {
    flex: 0,
  },
  skipButtonStacked: {
    alignSelf: 'flex-end',
  },
  skipText: {
    fontSize: 15,
    fontWeight: '800',
  },
});

import React from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { ExternalLink, Megaphone, MessageSquare, X } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { translateWithFallback, type AppAnnouncement, type AppAnnouncementAction } from '@mindwtr/core';
import { useLanguage } from '@/contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';

type AppAnnouncementModalProps = {
  announcement: AppAnnouncement | null;
  visible: boolean;
  onAction: (action: AppAnnouncementAction) => void;
  onDismiss: () => void;
  onShown?: () => void;
};

export function AppAnnouncementModal({
  announcement,
  onAction,
  onDismiss,
  onShown,
  visible,
}: AppAnnouncementModalProps) {
  const tc = useThemeColors();
  const filledButton = useFilledButtonColors();
  const { t } = useLanguage();

  React.useEffect(() => {
    if (visible && announcement) onShown?.();
  }, [announcement, onShown, visible]);

  if (!announcement) return null;

  const action = announcement.action;
  const dismissLabel = announcement.dismissLabel ?? translateWithFallback(t, 'common.notNow', 'Not now');
  const actionIcon = action?.type === 'feedback'
    ? <MessageSquare color={tc.onTint} size={16} strokeWidth={2.2} />
    : <ExternalLink color={tc.onTint} size={16} strokeWidth={2.2} />;

  return (
    <Modal
      animationType="fade"
      onRequestClose={onDismiss}
      transparent
      visible={visible}
    >
      <SafeAreaView style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onDismiss}>
          <Pressable
            accessibilityRole="alert"
            accessibilityViewIsModal
            style={[styles.card, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
            onPress={(event) => event.stopPropagation()}
          >
            <View style={[styles.header, { borderBottomColor: tc.border }]}>
              <View style={[styles.iconSlot, { backgroundColor: `${tc.tint}18` }]}>
                <Megaphone color={tc.tint} size={18} strokeWidth={2.2} />
              </View>
              <View style={styles.titleBlock}>
                <Text style={[styles.title, { color: tc.text }]}>{announcement.title}</Text>
              </View>
              <TouchableOpacity
                accessibilityLabel={translateWithFallback(t, 'announcement.dismiss', 'Dismiss announcement')}
                accessibilityRole="button"
                hitSlop={8}
                onPress={onDismiss}
                style={styles.closeButton}
              >
                <X color={tc.secondaryText} size={21} strokeWidth={2.2} />
              </TouchableOpacity>
            </View>

            <ScrollView
              bounces={false}
              contentContainerStyle={styles.body}
              style={styles.scroll}
            >
              <Text style={[styles.bodyText, { color: tc.secondaryText }]}>
                {announcement.body}
              </Text>
            </ScrollView>

            <View style={[styles.actions, { borderTopColor: tc.border }]}>
              <TouchableOpacity
                accessibilityRole="button"
                activeOpacity={0.82}
                onPress={onDismiss}
                style={[styles.secondaryButton, { borderColor: tc.border }]}
              >
                <Text numberOfLines={1} style={[styles.secondaryButtonText, { color: tc.secondaryText }]}>
                  {dismissLabel}
                </Text>
              </TouchableOpacity>
              {action ? (
                <TouchableOpacity
                  accessibilityRole="button"
                  activeOpacity={0.86}
                  onPress={() => onAction(action)}
                  style={[styles.primaryButton, { backgroundColor: filledButton.backgroundColor }]}
                >
                  {actionIcon}
                  <Text numberOfLines={1} style={[styles.primaryButtonText, { color: filledButton.textColor ?? tc.onTint }]}>
                    {action.label}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </Pressable>
        </Pressable>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
  },
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.42)',
    padding: 18,
  },
  card: {
    alignSelf: 'center',
    borderRadius: 12,
    borderWidth: 1,
    maxHeight: '82%',
    maxWidth: 460,
    overflow: 'hidden',
    width: '100%',
  },
  header: {
    alignItems: 'flex-start',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  iconSlot: {
    alignItems: 'center',
    borderRadius: 10,
    height: 36,
    justifyContent: 'center',
    marginTop: 1,
    width: 36,
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    lineHeight: 23,
  },
  closeButton: {
    alignItems: 'center',
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  scroll: {
    flexGrow: 0,
  },
  body: {
    padding: 16,
  },
  bodyText: {
    fontSize: 14,
    lineHeight: 21,
  },
  actions: {
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'flex-end',
    padding: 14,
  },
  primaryButton: {
    alignItems: 'center',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 126,
    paddingHorizontal: 14,
  },
  primaryButtonText: {
    flexShrink: 1,
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryButton: {
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 92,
    paddingHorizontal: 14,
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: '700',
  },
});

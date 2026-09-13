import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image as NativeImage,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { X } from 'lucide-react-native';
import Svg, { Image as SvgImage, parse, SvgAst } from 'react-native-svg';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  renderShareCardSvg,
  SHARE_CARD_REFLECTION_LIMIT,
  type ShareCardStyle,
} from '@mindwtr/core/share-card';

import { useLanguage } from '../contexts/language-context';
import { useFilledButtonColors } from '../hooks/use-filled-button-colors';
import { useThemeColors } from '../hooks/use-theme-colors';
import {
  exportShareCardPng,
  isShareCardDismissal,
  ShareCardUnavailableError,
} from '../lib/share-card-export';

type ShareCardModalProps = {
  onClose: () => void;
  visible: boolean;
};

const SHARE_CARD_STYLES: readonly ShareCardStyle[] = ['reflection', 'minimal', 'ripple'];

export function ShareCardModal({ onClose, visible }: ShareCardModalProps) {
  if (!visible) return null;

  return <ShareCardModalContent onClose={onClose} />;
}

function limitShareCardReflection(value: string): string {
  return Array.from(value).slice(0, SHARE_CARD_REFLECTION_LIMIT).join('');
}

function ShareCardModalContent({ onClose }: Pick<ShareCardModalProps, 'onClose'>) {
  const { language, t } = useLanguage();
  const tc = useThemeColors();
  const filledButton = useFilledButtonColors();
  const { width, height } = useWindowDimensions();
  const svgRef = useRef<Svg | null>(null);
  const [keyboardVisible, setKeyboardVisible] = useState(() => Keyboard.isVisible());
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  const [iconReady, setIconReady] = useState(false);
  const iconReadyFrame = useRef<number | null>(null);
  const [reviewDate] = useState(() => new Date().toLocaleDateString(language, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }));
  const [reflection, setReflection] = useState('');
  const [cardStyle, setCardStyle] = useState<ShareCardStyle>('reflection');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<'error' | 'success'>('error');
  const handleIconLoad = useCallback(() => {
    if (Platform.OS !== 'ios') {
      setIconReady(true);
      return;
    }
    if (iconReadyFrame.current !== null) cancelAnimationFrame(iconReadyFrame.current);
    iconReadyFrame.current = requestAnimationFrame(() => {
      iconReadyFrame.current = null;
      setIconReady(true);
    });
  }, []);

  const svg = useMemo(() => {
    return renderShareCardSvg({
      kind: 'review',
      style: cardStyle,
      reviewDate,
      reflection: reflection || undefined,
    }, t, { textLayout: Platform.OS === 'web' ? 'svg' : 'native' });
  }, [cardStyle, reflection, reviewDate, t]);
  const { iconUri, svgAst } = useMemo(() => {
    let parsedIconUri: string | null = null;
    const ast = parse(svg, (root) => {
    const attachImageLoad = (node: typeof root) => {
      if (node.tag === 'image') {
        const imageUri = node.props.href ?? node.props.xlinkHref;
        if (typeof imageUri === 'string') parsedIconUri = imageUri;
          node.props = {
            ...node.props,
            onLoad: handleIconLoad,
        } as unknown as typeof node.props;
      }
      for (const child of node.children) {
        if (typeof child === 'object') attachImageLoad(child);
      }
    };
      attachImageLoad(root);
      return root;
    });
    if (ast) {
      const stabilizeImage = (child: React.ReactNode): React.ReactNode => {
        if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return child;
        const children = React.Children.toArray(child.props.children).map(stabilizeImage);
        const props = child.type === SvgImage ? { key: 'share-card-icon' } : {};
        return React.cloneElement(child, props, children);
      };
      ast.children = ast.children.map(stabilizeImage) as typeof ast.children;
    }
    return { iconUri: parsedIconUri, svgAst: ast };
  }, [handleIconLoad, svg]);
  useEffect(() => {
    if (Platform.OS !== 'android' || !iconUri || iconReady) return;
    const queryCache = NativeImage.queryCache;
    if (!queryCache) return;
    let active = true;
    void queryCache([iconUri]).then((cache) => {
      if (active && cache[iconUri] === 'memory') setIconReady(true);
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [iconReady, iconUri]);
  useEffect(() => () => {
    if (iconReadyFrame.current !== null) cancelAnimationFrame(iconReadyFrame.current);
  }, []);
  const reflectionLength = Array.from(reflection).length;
  const availableWidth = width - 40;
  const previewSize = Math.max(180, Math.min(availableWidth * 0.87, height * 0.4, 400));
  const onFilled = filledButton.textColor ?? tc.onTint;
  const exportDisabled = pending || !iconReady;

  const handleExport = async () => {
    if (pending || !iconReady) return;
    setPending(true);
    setMessage(null);
    try {
      const method = await exportShareCardPng(svgRef.current, t('shareCard.title'));
      if (method === 'download') {
        setMessageTone('success');
        setMessage(t('shareCard.saved'));
      }
    } catch (error) {
      if (!isShareCardDismissal(error)) {
        setMessageTone('error');
        setMessage(error instanceof ShareCardUnavailableError
          ? t('shareCard.unavailable')
          : t('shareCard.error'));
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      allowSwipeDismissal={!pending}
      onRequestClose={() => {
        if (!pending) onClose();
      }}
      accessibilityViewIsModal
    >
      <SafeAreaView style={[styles.root, { backgroundColor: tc.bg }]} edges={['top', 'bottom', 'left', 'right']}>
        <View style={[styles.header, { borderBottomColor: tc.border }]}>
          <Text style={[styles.title, { color: tc.text }]} accessibilityRole="header">
            {t('shareCard.title')}
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={t('shareCard.close')}
            accessibilityState={{ disabled: pending }}
            disabled={pending}
            hitSlop={8}
            onPress={onClose}
            style={[styles.closeButton, pending ? styles.disabled : null]}
            testID="share-card-close"
          >
            <X size={22} color={tc.text} />
          </TouchableOpacity>
        </View>

        <KeyboardAvoidingView
          // Keep the measured outer frame stable when the native share sheet
          // hides the keyboard; height avoidance can feed back into its own layout.
          behavior="padding"
          // Android hide events can retain coordinates from the sharing activity.
          enabled={Platform.OS !== 'android' || keyboardVisible}
          style={styles.body}
        >
          <ScrollView
            contentContainerStyle={styles.content}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            <View
              accessibilityLabel={t('shareCard.preview')}
              accessibilityRole="image"
              accessible
              style={[
                styles.preview,
                { width: previewSize, height: previewSize, borderColor: tc.border },
              ]}
              testID="share-card-preview"
            >
              <SvgAst
                ast={svgAst}
                override={{
                  ref: svgRef,
                  width: '100%',
                  height: '100%',
                }}
              />
            </View>

            <Text style={[styles.privacy, { color: tc.secondaryText }]}>
              {t('shareCard.privacy')}
            </Text>

            <View style={styles.styleField}>
              <Text style={[styles.styleLabel, { color: tc.text }]}>
                {t('shareCard.styleLabel')}
              </Text>
              <View style={[styles.styleOptions, { borderColor: tc.border }]}>
                {SHARE_CARD_STYLES.map((option) => {
                  const selected = cardStyle === option;
                  const label = t(`shareCard.style${option[0].toUpperCase()}${option.slice(1)}`);
                  return (
                    <TouchableOpacity
                      accessibilityLabel={label}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected, disabled: pending }}
                      disabled={pending}
                      key={option}
                      onPress={() => setCardStyle(option)}
                      style={[
                        styles.styleOption,
                        { backgroundColor: selected ? tc.tint : tc.cardBg },
                        pending ? styles.disabled : null,
                      ]}
                      testID={`share-card-style-${option}`}
                    >
                      <Text style={[
                        styles.styleOptionText,
                        { color: selected ? tc.onTint : tc.text },
                      ]}>
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            <View style={styles.reflectionField}>
              <View style={styles.reflectionHeader}>
                <Text style={[styles.reflectionLabel, { color: tc.text }]}>
                  {t('shareCard.reflectionLabel')}
                </Text>
                <Text
                  accessibilityLabel={`${reflectionLength} / ${SHARE_CARD_REFLECTION_LIMIT}`}
                  style={[styles.characterCount, { color: tc.secondaryText }]}
                >
                  {reflectionLength}/{SHARE_CARD_REFLECTION_LIMIT}
                </Text>
              </View>
              <TextInput
                accessibilityLabel={t('shareCard.reflectionLabel')}
                accessibilityState={{ disabled: pending }}
                editable={!pending}
                multiline
                onChangeText={(value) => setReflection(limitShareCardReflection(value))}
                placeholder={t('shareCard.reflectionPlaceholder')}
                placeholderTextColor={tc.secondaryText}
                style={[
                  styles.reflectionInput,
                  { color: tc.text, borderColor: tc.border, backgroundColor: tc.cardBg },
                  pending ? styles.disabled : null,
                ]}
                textAlignVertical="top"
                testID="share-card-reflection"
                value={reflection}
              />
              {!reflection.trim() ? (
                <Text style={[styles.defaultHint, { color: tc.secondaryText }]}>
                  {t('shareCard.defaultHint')}
                </Text>
              ) : null}
            </View>

            {message ? (
              <Text
                accessibilityRole={messageTone === 'error' ? 'alert' : 'text'}
                style={[styles.message, { color: messageTone === 'error' ? tc.danger : tc.success }]}
                testID="share-card-message"
              >
                {message}
              </Text>
            ) : null}
          </ScrollView>

          <View style={[styles.footer, { borderTopColor: tc.border }]}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={Platform.OS === 'web' ? t('shareCard.save') : t('shareCard.share')}
              accessibilityState={{ disabled: exportDisabled }}
              disabled={exportDisabled}
              onPress={() => void handleExport()}
              style={[
                styles.actionButton,
                { backgroundColor: filledButton.backgroundColor },
                exportDisabled ? styles.disabled : null,
              ]}
              testID="share-card-export"
            >
              {pending ? <ActivityIndicator size="small" color={onFilled} /> : null}
              <Text style={[styles.actionButtonText, { color: onFilled }]}>
                {pending
                  ? t('shareCard.generating')
                  : Platform.OS === 'web' ? t('shareCard.save') : t('shareCard.share')}
              </Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1 },
  header: {
    minHeight: 56,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: 20, fontWeight: '700' },
  closeButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -8,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 28,
    alignItems: 'center',
  },
  preview: {
    maxWidth: '100%',
    aspectRatio: 1,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    backgroundColor: 'transparent',
  },
  privacy: {
    width: '100%',
    maxWidth: 520,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 14,
    marginBottom: 20,
  },
  reflectionField: {
    width: '100%',
    maxWidth: 520,
  },
  styleField: {
    width: '100%',
    maxWidth: 520,
    marginBottom: 20,
  },
  styleLabel: { fontSize: 15, lineHeight: 21, fontWeight: '600', marginBottom: 8 },
  styleOptions: {
    minHeight: 50,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 3,
    flexDirection: 'row',
    gap: 3,
  },
  styleOption: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: 8,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  styleOptionText: { fontSize: 14, lineHeight: 18, fontWeight: '600', textAlign: 'center' },
  reflectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
  },
  reflectionLabel: { flex: 1, fontSize: 15, lineHeight: 21, fontWeight: '600' },
  characterCount: { fontSize: 12, lineHeight: 18 },
  reflectionInput: {
    minHeight: 104,
    marginTop: 8,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    fontSize: 16,
    lineHeight: 22,
  },
  defaultHint: { marginTop: 8, fontSize: 13, lineHeight: 18 },
  message: { width: '100%', maxWidth: 520, marginTop: 14, fontSize: 14, lineHeight: 20 },
  footer: { paddingHorizontal: 20, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth },
  actionButton: {
    minHeight: 48,
    borderRadius: 12,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  actionButtonText: { fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.48 },
});

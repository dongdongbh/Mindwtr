import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { useLanguage } from '@/contexts/language-context';

type NativeAlert = typeof Alert.alert;
type ThemedAlertButton = NonNullable<Parameters<NativeAlert>[2]>[number];
type ThemedAlertOptions = Parameters<NativeAlert>[3];

type ThemedAlertRequest = {
  id: number;
  title: string;
  message?: string;
  buttons: ThemedAlertButton[];
  options?: ThemedAlertOptions;
};

type ThemedAlertPresenter = (request: ThemedAlertRequest) => void;

let originalNativeAlert: NativeAlert | null = null;
let activePresenter: ThemedAlertPresenter | null = null;
let nextAlertId = 0;

const getAlertTarget = () => Alert as unknown as { alert: NativeAlert };

const normalizeButtons = (buttons?: ThemedAlertButton[]): ThemedAlertButton[] => (
  buttons && buttons.length > 0 ? buttons : [{} as ThemedAlertButton]
);

const getOptionsConfig = (options?: ThemedAlertOptions): { cancelable?: boolean; onDismiss?: () => void } => (
  options && typeof options === 'object' ? options as { cancelable?: boolean; onDismiss?: () => void } : {}
);

export function installThemedAlert() {
  if (!originalNativeAlert) {
    originalNativeAlert = getAlertTarget().alert.bind(Alert) as NativeAlert;
  }

  getAlertTarget().alert = ((title, message, buttons, options) => {
    if (!activePresenter) {
      originalNativeAlert?.(title, message, buttons, options);
      return;
    }

    activePresenter({
      id: nextAlertId += 1,
      title: String(title ?? ''),
      message,
      buttons: normalizeButtons(buttons),
      options,
    });
  }) as NativeAlert;

  return () => {
    if (originalNativeAlert) {
      getAlertTarget().alert = originalNativeAlert;
    }
  };
}

export function setThemedAlertPresenter(presenter: ThemedAlertPresenter | null) {
  activePresenter = presenter;
}

function ThemedAlertOverlay({
  embedded = false,
  request,
  onButtonPress,
  onDismiss,
}: {
  embedded?: boolean;
  request: ThemedAlertRequest;
  onButtonPress: (button: ThemedAlertButton) => void;
  onDismiss: () => void;
}) {
  const tc = useThemeColors();
  const { t } = useLanguage();
  const canDismiss = getOptionsConfig(request.options).cancelable !== false;
  const horizontalActions = request.buttons.length <= 2;
  const defaultButtonText = t('common.ok');

  const handleDismiss = () => {
    if (!canDismiss) return;
    onDismiss();
  };

  return (
    <Pressable
      style={embedded ? [styles.overlay, styles.embeddedOverlay] : styles.overlay}
      onPress={handleDismiss}
      accessibilityRole="button"
      accessibilityLabel={request.title}
      accessibilityViewIsModal={embedded || undefined}
    >
      <Pressable
        style={[styles.card, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
        onPress={() => {}}
      >
        <Text style={[styles.title, { color: tc.text }]}>{request.title}</Text>
        {request.message ? (
          <ScrollView style={styles.messageContainer} contentContainerStyle={styles.messageContent}>
            <Text style={[styles.message, { color: tc.secondaryText }]}>{request.message}</Text>
          </ScrollView>
        ) : null}
        <View style={[styles.actions, horizontalActions ? styles.actionsHorizontal : styles.actionsVertical]}>
          {request.buttons.map((button, index) => {
            const isDestructive = button.style === 'destructive';
            const isCancel = button.style === 'cancel';
            const isPrimary = !isCancel && !isDestructive && index === request.buttons.length - 1;
            const backgroundColor = isDestructive
              ? tc.danger
              : isPrimary
                ? tc.tint
                : tc.filterBg;
            const color = isDestructive || isPrimary ? tc.onTint : tc.text;

            return (
              <TouchableOpacity
                key={`${button.text ?? defaultButtonText}-${index}`}
                style={[
                  styles.actionButton,
                  horizontalActions && styles.actionButtonHorizontal,
                  {
                    backgroundColor,
                    borderColor: isDestructive || isPrimary ? backgroundColor : tc.border,
                  },
                ]}
                accessibilityRole="button"
                onPress={() => onButtonPress(button)}
              >
                <Text style={[styles.actionText, { color }]}>{button.text ?? defaultButtonText}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </Pressable>
    </Pressable>
  );
}

function ThemedAlertModal({
  request,
  onButtonPress,
  onDismiss,
}: {
  request: ThemedAlertRequest;
  onButtonPress: (button: ThemedAlertButton) => void;
  onDismiss: () => void;
}) {
  const canDismiss = getOptionsConfig(request.options).cancelable !== false;

  const handleRequestClose = () => {
    if (canDismiss) {
      onDismiss();
      return;
    }
    const cancelButton = request.buttons.find((button) => button.style === 'cancel');
    if (cancelButton) {
      onButtonPress(cancelButton);
      return;
    }
    if (request.buttons.length === 1) {
      onButtonPress(request.buttons[0]);
    }
  };

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      accessibilityViewIsModal
      onRequestClose={handleRequestClose}
    >
      <ThemedAlertOverlay request={request} onButtonPress={onButtonPress} onDismiss={onDismiss} />
    </Modal>
  );
}

type ThemedAlertHostId = object;

type ThemedAlertHostContextValue = {
  activeHostId: ThemedAlertHostId | null;
  onButtonPress: (button: ThemedAlertButton) => void;
  onDismiss: () => void;
  registerHost: (hostId: ThemedAlertHostId) => () => void;
  request: ThemedAlertRequest | null;
};

const ThemedAlertHostContext = createContext<ThemedAlertHostContextValue | null>(null);


export function ThemedAlertHost() {
  const context = useContext(ThemedAlertHostContext);
  const hostId = useRef<ThemedAlertHostId>({}).current;
  const registerHost = context?.registerHost;

  useEffect(() => registerHost?.(hostId), [hostId, registerHost]);

  if (!context || !context.request || context.activeHostId !== hostId) return null;

  return (
    <ThemedAlertOverlay
      key={context.request.id}
      embedded
      request={context.request}
      onButtonPress={context.onButtonPress}
      onDismiss={context.onDismiss}
    />
  );
}

export function ThemedAlertProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<ThemedAlertRequest | null>(null);
  const requestRef = useRef<ThemedAlertRequest | null>(null);
  const queueRef = useRef<ThemedAlertRequest[]>([]);
  const [hostStack, setHostStack] = useState<ThemedAlertHostId[]>([]);

  const showNextRequest = useCallback(() => {
    const nextRequest = queueRef.current.shift() ?? null;
    requestRef.current = nextRequest;
    setRequest(nextRequest);
  }, []);

  const presentRequest = useCallback((nextRequest: ThemedAlertRequest) => {
    if (requestRef.current) {
      queueRef.current.push(nextRequest);
      return;
    }
    requestRef.current = nextRequest;
    setRequest(nextRequest);
  }, []);

  useEffect(() => {
    const uninstall = installThemedAlert();
    setThemedAlertPresenter(presentRequest);
    return () => {
      setThemedAlertPresenter(null);
      uninstall();
    };
  }, [presentRequest]);

  const handleDismiss = useCallback(() => {
    const currentRequest = requestRef.current;
    showNextRequest();
    getOptionsConfig(currentRequest?.options).onDismiss?.();
  }, [showNextRequest]);

  const handleButtonPress = useCallback((button: ThemedAlertButton) => {
    showNextRequest();
    button.onPress?.();
  }, [showNextRequest]);

  const registerHost = useCallback((hostId: ThemedAlertHostId) => {


    setHostStack((prev) => [...prev, hostId]);
    return () => setHostStack((prev) => prev.filter((id) => id !== hostId));
  }, []);


  const activeHostId = Platform.OS === 'ios' ? hostStack[hostStack.length - 1] ?? null : null;

  const hostContext = useMemo<ThemedAlertHostContextValue>(() => ({
    activeHostId,
    onButtonPress: handleButtonPress,
    onDismiss: handleDismiss,
    registerHost,
    request,
  }), [activeHostId, handleButtonPress, handleDismiss, registerHost, request]);

  return (
    <ThemedAlertHostContext.Provider value={hostContext}>
      {children}
      {request && !activeHostId ? (
        <ThemedAlertModal
          key={request.id}
          request={request}
          onButtonPress={handleButtonPress}
          onDismiss={handleDismiss}
        />
      ) : null}
    </ThemedAlertHostContext.Provider>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.58)',
    justifyContent: 'center',
    padding: 24,
  },
  embeddedOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1000,
    elevation: 1000,
  },
  card: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 20,
    gap: 14,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.24,
    shadowRadius: 28,
    elevation: 14,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
  },
  messageContainer: {
    maxHeight: 240,
  },
  messageContent: {
    paddingRight: 2,
  },
  message: {
    fontSize: 16,
    lineHeight: 23,
  },
  actions: {
    marginTop: 8,
    gap: 10,
  },
  actionsHorizontal: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  actionsVertical: {
    flexDirection: 'column',
  },
  actionButton: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionButtonHorizontal: {
    flex: 1,
  },
  actionText: {
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
});

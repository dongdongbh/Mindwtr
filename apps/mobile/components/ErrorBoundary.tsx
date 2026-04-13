import React, { Component, ErrorInfo, ReactNode, useContext } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { AlertTriangle } from 'lucide-react-native';
import { resolveThemeColors } from '@/hooks/use-theme-colors';
import { logError } from '@/lib/app-log';
import { LanguageContext } from '@/contexts/language-context';
import { ThemeContext } from '@/contexts/theme-context';

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

const FALLBACK_ERROR_STRINGS: Record<string, string> = {
    'errorBoundary.title': 'Something went wrong',
    'errorBoundary.message': 'The app hit an unexpected error.',
    'errorBoundary.retry': 'Try again',
};

function ErrorFallback({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
    const themeContext = useContext(ThemeContext);
    const languageContext = useContext(LanguageContext);
    const tc = resolveThemeColors(themeContext);
    const t = (key: string) => languageContext?.t(key) ?? FALLBACK_ERROR_STRINGS[key] ?? key;
    return (
        <View style={[styles.container, { backgroundColor: tc.bg }]}>
            <AlertTriangle size={56} color={tc.danger} style={styles.icon} strokeWidth={1.5} />
            <Text style={[styles.title, { color: tc.text }]}>{t('errorBoundary.title')}</Text>
            <Text style={[styles.message, { color: tc.secondaryText }]}>
                {t('errorBoundary.message')}
            </Text>
            <View style={[styles.errorBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                <Text style={[styles.errorText, { color: tc.danger }]}>
                    {error?.message}
                </Text>
            </View>
            <TouchableOpacity style={[styles.button, { backgroundColor: tc.tint }]} onPress={onRetry}>
                <Text style={[styles.buttonText, { color: tc.onTint }]}>{t('errorBoundary.retry')}</Text>
            </TouchableOpacity>
        </View>
    );
}

export class ErrorBoundary extends Component<Props, State> {
    public state: State = {
        hasError: false,
        error: null,
    };

    public static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        void logError(error, {
            scope: 'react',
            extra: { componentStack: errorInfo.componentStack || '' },
        });
    }

    private handleRetry = () => {
        this.setState({ hasError: false, error: null });
    };

    public render() {
        if (this.state.hasError) {
            return <ErrorFallback error={this.state.error} onRetry={this.handleRetry} />;
        }

        return this.props.children;
    }
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    icon: {
        marginBottom: 16,
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        marginBottom: 8,
    },
    message: {
        fontSize: 16,
        textAlign: 'center',
        marginBottom: 16,
    },
    errorBox: {
        padding: 16,
        borderRadius: 8,
        borderWidth: 1,
        marginBottom: 24,
        maxWidth: '100%',
    },
    errorText: {
        fontSize: 14,
        fontFamily: 'monospace',
    },
    button: {
        paddingHorizontal: 24,
        paddingVertical: 12,
        borderRadius: 8,
    },
    buttonText: {
        fontSize: 16,
        fontWeight: '600',
    },
});

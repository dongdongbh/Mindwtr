import React, { Component, ErrorInfo, ReactNode } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Colors } from '@/constants/theme';
import { logError } from '@/lib/app-log';

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
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
        console.error('Uncaught error:', error, errorInfo);
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
            return (
                <View style={styles.container}>
                    <Text style={styles.emoji}>💥</Text>
                    <Text style={styles.title}>Something went wrong</Text>
                    <Text style={styles.message}>
                        The app encountered an unexpected error.
                    </Text>
                    <View style={styles.errorBox}>
                        <Text style={styles.errorText}>
                            {this.state.error?.message}
                        </Text>
                    </View>
                    <TouchableOpacity style={styles.button} onPress={this.handleRetry}>
                        <Text style={styles.buttonText}>Try Again</Text>
                    </TouchableOpacity>
                </View>
            );
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
        backgroundColor: Colors.dark.background,
    },
    emoji: {
        fontSize: 64,
        marginBottom: 16,
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        color: Colors.dark.text,
        marginBottom: 8,
    },
    message: {
        fontSize: 16,
        color: '#9CA3AF',
        textAlign: 'center',
        marginBottom: 16,
    },
    errorBox: {
        backgroundColor: '#1F2937',
        padding: 16,
        borderRadius: 8,
        marginBottom: 24,
        maxWidth: '100%',
    },
    errorText: {
        fontSize: 14,
        fontFamily: 'monospace',
        color: '#EF4444',
    },
    button: {
        backgroundColor: '#3B82F6',
        paddingHorizontal: 24,
        paddingVertical: 12,
        borderRadius: 8,
    },
    buttonText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '600',
    },
});

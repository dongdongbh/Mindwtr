import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import type { ThemeColors } from '@/hooks/use-theme-colors';

type TaskEditModalErrorBoundaryProps = {
    children: React.ReactNode;
    onClose: () => void;
    taskId?: string;
    t: (key: string) => string;
    tc: ThemeColors;
};

type TaskEditModalErrorBoundaryState = {
    hasError: boolean;
};

export class TaskEditModalErrorBoundary extends React.Component<TaskEditModalErrorBoundaryProps, TaskEditModalErrorBoundaryState> {
    state: TaskEditModalErrorBoundaryState = { hasError: false };

    static getDerivedStateFromError(): TaskEditModalErrorBoundaryState {
        return { hasError: true };
    }

    componentDidCatch(error: unknown) {
        logTaskError('Task edit modal crashed', error);
    }

    componentDidUpdate(prevProps: TaskEditModalErrorBoundaryProps) {
        if (prevProps.taskId !== this.props.taskId || (!prevProps.taskId && this.props.taskId)) {
            if (this.state.hasError) {
                this.setState({ hasError: false });
            }
        }
    }

    render() {
        if (!this.state.hasError) {
            return this.props.children;
        }

        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: this.props.tc.bg }}>
                <Text style={{ fontSize: 18, fontWeight: '700', color: this.props.tc.text, marginBottom: 12 }}>
                    {this.props.t('taskEdit.title')}
                </Text>
                <Text style={{ fontSize: 14, color: this.props.tc.secondaryText, textAlign: 'center', marginBottom: 16 }}>
                    {this.props.t('common.error')}
                </Text>
                <TouchableOpacity
                    onPress={this.props.onClose}
                    style={{
                        paddingHorizontal: 16,
                        paddingVertical: 10,
                        borderRadius: 999,
                        backgroundColor: this.props.tc.tint,
                    }}
                >
                    <Text style={{ color: '#fff', fontWeight: '700' }}>{this.props.t('common.close')}</Text>
                </TouchableOpacity>
            </View>
        );
    }
}

function logTaskError(message: string, error: unknown) {
    console.error(message, error);
}

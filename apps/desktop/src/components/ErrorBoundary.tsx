import { Component, ErrorInfo, ReactNode } from 'react';
import { logError } from '../lib/app-log';

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
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

    public render() {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }

            return (
                <div className="min-h-screen flex items-center justify-center bg-background">
                    <div className="max-w-md p-8 text-center space-y-4">
                        <div className="text-6xl">💥</div>
                        <h1 className="text-2xl font-bold text-foreground">Something went wrong</h1>
                        <p className="text-muted-foreground">
                            The app encountered an unexpected error. Please try refreshing the page.
                        </p>
                        <div className="bg-muted p-4 rounded-lg text-left">
                            <p className="text-sm font-mono text-destructive">
                                {this.state.error?.message}
                            </p>
                        </div>
                        <button
                            onClick={() => window.location.reload()}
                            className="bg-primary text-primary-foreground px-6 py-2 rounded-lg font-medium hover:bg-primary/90"
                        >
                            Refresh Page
                        </button>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}

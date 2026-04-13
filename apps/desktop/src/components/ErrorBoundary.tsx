import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { logError } from '../lib/app-log';
import { useLanguage } from '../contexts/language-context';
import { Button } from './ui/Button';

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
    strings?: {
        title: string;
        message: string;
        retry: string;
    };
}

interface State {
    hasError: boolean;
    error: Error | null;
}

class BaseErrorBoundary extends Component<Props, State> {
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

    public render() {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }

            return (
                <div className="min-h-screen flex items-center justify-center bg-background" role="alert" aria-live="assertive">
                    <div className="max-w-md p-8 text-center space-y-4">
                        <AlertTriangle className="w-14 h-14 mx-auto text-destructive" aria-hidden="true" strokeWidth={1.5} />
                        <h1 className="text-2xl font-bold text-foreground">{this.props.strings?.title ?? 'Something went wrong'}</h1>
                        <p className="text-muted-foreground">
                            {this.props.strings?.message ?? 'The app encountered an unexpected error.'}
                        </p>
                        <div className="bg-muted p-4 rounded-lg text-left">
                            <p className="text-sm font-mono text-destructive">
                                {this.state.error?.message}
                            </p>
                        </div>
                        <Button size="lg" onClick={() => window.location.reload()}>
                            {this.props.strings?.retry ?? 'Try again'}
                        </Button>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}

export function ErrorBoundary({ children, fallback }: Omit<Props, 'strings'>) {
    const { t } = useLanguage();
    return (
        <BaseErrorBoundary
            fallback={fallback}
            strings={{
                title: t('errorBoundary.title'),
                message: t('errorBoundary.message'),
                retry: t('errorBoundary.retry'),
            }}
        >
            {children}
        </BaseErrorBoundary>
    );
}

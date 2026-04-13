import { Button } from '../../ui/Button';

type EmptyState = {
    title: string;
    body: string;
    action?: string;
};

type ListEmptyStateProps = {
    hasFilters: boolean;
    emptyState: EmptyState;
    onAddTask: () => void;
    t: (key: string) => string;
};

export function ListEmptyState({ hasFilters, emptyState, onAddTask, t }: ListEmptyStateProps) {
    return (
        <div className="text-center py-12 text-muted-foreground flex flex-col items-center gap-3">
            {hasFilters ? (
                <p>{t('filters.noMatch')}</p>
            ) : (
                <>
                    <div className="text-base font-medium text-foreground">{emptyState.title}</div>
                    <p className="text-sm text-muted-foreground max-w-sm">{emptyState.body}</p>
                    {emptyState.action && (
                        <Button size="xs" onClick={onAddTask}>
                            {emptyState.action}
                        </Button>
                    )}
                </>
            )}
        </div>
    );
}

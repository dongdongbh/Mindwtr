import { Calendar, ChevronDown, List } from 'lucide-react';

import { cn } from '../../../lib/utils';
import type { NextGroupBy } from '../list/next-grouping';

type AgendaHeaderProps = {
    nextActionsCount: number;
    nextGroupBy: NextGroupBy;
    onChangeGroupBy: (value: NextGroupBy) => void;
    onToggleDetails: () => void;
    onToggleTop3: () => void;
    resolveText: (key: string, fallback: string) => string;
    showListDetails: boolean;
    t: (key: string) => string;
    top3Only: boolean;
};

export function AgendaHeader({
    nextActionsCount,
    nextGroupBy,
    onChangeGroupBy,
    onToggleDetails,
    onToggleTop3,
    resolveText,
    showListDetails,
    t,
    top3Only,
}: AgendaHeaderProps) {
    return (
        <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
                <h2 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
                    <Calendar className="h-8 w-8" />
                    {t('agenda.title')}
                </h2>
                <p className="text-muted-foreground">
                    {nextActionsCount} {t('list.next') || t('agenda.nextActions')}
                </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={onToggleTop3}
                    className={cn(
                        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors',
                        top3Only
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted',
                    )}
                >
                    {t('agenda.top3Only')}
                </button>
                <button
                    type="button"
                    onClick={onToggleDetails}
                    aria-pressed={showListDetails}
                    className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors',
                        showListDetails
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                    title={showListDetails ? (t('list.details') || 'Details on') : (t('list.detailsOff') || 'Details off')}
                >
                    <List className="h-3.5 w-3.5" />
                    {showListDetails ? (t('list.details') || 'Details') : (t('list.detailsOff') || 'Details off')}
                </button>
                <div className="relative">
                    <select
                        value={nextGroupBy}
                        onChange={(event) => onChangeGroupBy(event.target.value as NextGroupBy)}
                        aria-label={resolveText('list.groupBy', 'Group')}
                        className={cn(
                            'min-w-[136px] appearance-none rounded-full border py-1.5 pl-3 pr-8 text-xs leading-none transition-colors',
                            'border-border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                            'focus:outline-none focus:ring-2 focus:ring-primary/40',
                        )}
                    >
                        <option value="none">{resolveText('list.groupByNone', 'No grouping')}</option>
                        <option value="context">{resolveText('list.groupByContext', 'Context')}</option>
                        <option value="area">{resolveText('list.groupByArea', 'Area')}</option>
                    </select>
                    <ChevronDown
                        className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                        aria-hidden="true"
                    />
                </div>
            </div>
        </header>
    );
}

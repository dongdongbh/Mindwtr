import { type ComponentType, useEffect, useState, useMemo, useId } from 'react';
import { Search } from 'lucide-react';

import { cn } from '../../../lib/utils';
import {
    formatSettingsSearchPath,
    matchSettingsSearchResults,
    type SettingsSearchResult,
} from './settings-search';

type NavItem = {
    id: string;
    icon: ComponentType<{ className?: string }>;
    label: string;
    description?: string;
    badge?: boolean;
    badgeLabel?: string;
};

type SettingsSidebarProps = {
    title: string;
    subtitle: string;
    items: NavItem[];
    activeId: string;
    onSelect: (id: string) => void;
    searchPlaceholder?: string;
    searchResults?: readonly SettingsSearchResult[];
    onSelectSearchResult?: (result: SettingsSearchResult) => void;
    noResultsLabel?: string;
};

export function SettingsSidebar({
    title,
    subtitle,
    items,
    activeId,
    onSelect,
    searchPlaceholder,
    searchResults = [],
    onSelectSearchResult,
    noResultsLabel,
}: SettingsSidebarProps) {
    const [search, setSearch] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);
    const resultsId = useId();
    const isSearching = search.trim().length > 0;
    const matches = useMemo(
        () => (isSearching ? matchSettingsSearchResults(searchResults, search) : []),
        [isSearching, search, searchResults],
    );

    useEffect(() => {
        setActiveIndex(0);
    }, [search]);

    useEffect(() => {
        if (isSearching) document.getElementById(`${resultsId}-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
    }, [activeIndex, isSearching, resultsId]);

    const pick = (result: SettingsSearchResult | undefined) => {
        if (!result) return;
        onSelectSearchResult?.(result);
        setSearch('');
    };

    const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            setSearch('');
            return;
        }
        if (!matches.length) return;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveIndex((index) => (index + 1) % matches.length);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex((index) => (index - 1 + matches.length) % matches.length);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            pick(matches[activeIndex]);
        }
    };

    return (
        <aside className="w-full lg:w-48 xl:w-52 shrink-0 space-y-4">
            <div>
                <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
                <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
            </div>
            <select
                value={activeId}
                onChange={(event) => { onSelect(event.target.value); setSearch(''); }}
                aria-label={title}
                className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 lg:hidden"
            >
                {items.map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                ))}
            </select>
            <div className="relative">
                <Search aria-hidden="true" className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={handleSearchKeyDown}
                    placeholder={searchPlaceholder ?? 'Search settings\u2026'}
                    aria-label={searchPlaceholder ?? 'Search settings\u2026'}
                    role="combobox"
                    aria-expanded={isSearching}
                    aria-controls={isSearching ? resultsId : undefined}
                    aria-activedescendant={isSearching && matches[activeIndex] ? `${resultsId}-${activeIndex}` : undefined}
                    aria-autocomplete="list"
                    className="w-full h-11 lg:h-8 pl-8 pr-3 text-sm lg:text-xs bg-card border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
            </div>
            {isSearching ? (
                <ul
                    id={resultsId}
                    role="listbox"
                    aria-label={searchPlaceholder ?? 'Search settings\u2026'}
                    className="space-y-0.5 max-h-[40vh] overflow-y-auto lg:max-h-none"
                >
                    {matches.map((result, index) => (
                        <li key={`${result.pageId}:${result.key}`} role="presentation">
                            <button
                                type="button"
                                role="option"
                                id={`${resultsId}-${index}`}
                                tabIndex={-1}
                                aria-selected={index === activeIndex}
                                onMouseEnter={() => setActiveIndex(index)}
                                onClick={() => pick(result)}
                                className={cn(
                                    'w-full min-h-11 lg:min-h-0 rounded-lg px-3 py-2 text-left transition-colors',
                                    index === activeIndex ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted/60',
                                )}
                            >
                                <div className="truncate text-[13px] font-medium">{result.title}</div>
                                <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                                    {formatSettingsSearchPath(result)}
                                </div>
                            </button>
                        </li>
                    ))}
                    {matches.length === 0 ? (
                        <li className="px-3 py-2 text-[11px] text-muted-foreground">
                            {noResultsLabel ?? 'No matches'}
                        </li>
                    ) : null}
                </ul>
            ) : null}
            <nav className={cn('space-y-0.5', isSearching ? 'hidden' : 'hidden lg:block')}>
                {items.map((item) => {
                    const Icon = item.icon;
                    const isActive = item.id === activeId;
                    return (
                        <button
                            key={item.id}
                            onClick={() => onSelect(item.id)}
                            className={cn(
                                "w-full flex items-start gap-2.5 px-3 py-2 rounded-lg text-left text-[13px] font-medium transition-colors",
                                isActive
                                    ? "bg-primary/10 text-primary"
                                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                            )}
                        >
                            <Icon className="w-4 h-4 flex-shrink-0 mt-0.5" />
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <span>{item.label}</span>
                                    {item.badge && (
                                        <span className="inline-flex items-center">
                                            <span
                                                aria-hidden="true"
                                                className="h-2 w-2 rounded-full bg-destructive"
                                            />
                                            <span className="sr-only">{item.badgeLabel ?? 'Update available'}</span>
                                        </span>
                                    )}
                                </div>
                            </div>
                        </button>
                    );
                })}
            </nav>
        </aside>
    );
}

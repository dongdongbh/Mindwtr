import { Calendar, Inbox, CheckSquare, Archive, Layers, Tag, CheckCircle2, HelpCircle, Folder, Settings, Target, Search } from 'lucide-react';
import { cn } from '../lib/utils';
import { useTaskStore } from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';

interface LayoutProps {
    children: React.ReactNode;
    currentView: string;
    onViewChange: (view: string) => void;
}

export function Layout({ children, currentView, onViewChange }: LayoutProps) {
    const { tasks } = useTaskStore();
    const { t } = useLanguage();

    // Filter out deleted tasks from counts
    const activeTasks = tasks.filter(t => !t.deletedAt);
    const inboxCount = activeTasks.filter(t => t.status === 'inbox').length;
    const nextCount = activeTasks.filter(t => t.status === 'next').length;

    // Trigger global search by simulating Cmd+K
    const triggerSearch = () => {
        const event = new KeyboardEvent('keydown', {
            key: 'k',
            metaKey: true,
            ctrlKey: true,
            bubbles: true
        });
        window.dispatchEvent(event);
    };

    const navItems = [
        { id: 'inbox', labelKey: 'nav.inbox', icon: Inbox, count: inboxCount },
        { id: 'agenda', labelKey: 'nav.agenda', icon: Target },
        { id: 'board', labelKey: 'nav.board', icon: Layers },
        { id: 'projects', labelKey: 'nav.projects', icon: Folder },
        { id: 'contexts', labelKey: 'nav.contexts', icon: Tag, path: 'contexts' },
        { id: 'next', labelKey: 'nav.next', icon: Layers, count: nextCount },
        { id: 'waiting', labelKey: 'nav.waiting', icon: Archive },
        { id: 'someday', labelKey: 'nav.someday', icon: Archive },
        { id: 'calendar', labelKey: 'nav.calendar', icon: Calendar },
        { id: 'review', labelKey: 'nav.review', icon: CheckCircle2, path: 'review' },
        { id: 'tutorial', labelKey: 'nav.tutorial', icon: HelpCircle, path: 'tutorial' },
        // Settings moved to footer
        { id: 'done', labelKey: 'nav.done', icon: CheckSquare },
        { id: 'archived', labelKey: 'nav.archived', icon: Archive },
    ];

    return (
        <div className="flex h-screen bg-background text-foreground">
            {/* Sidebar */}
            <aside className="w-64 border-r border-border bg-card p-4 flex flex-col">
                <div className="flex items-center gap-2 px-2 mb-4">
                    <img
                        src="/logo.png"
                        alt="Mindwtr"
                        className="w-8 h-8 rounded-lg"
                    />
                    <h1 className="text-xl font-bold">{t('app.name')}</h1>
                </div>

                {/* Search Button */}
                <button
                    onClick={triggerSearch}
                    className="w-full flex items-center gap-3 px-3 py-2 mb-4 rounded-md text-sm font-medium transition-colors bg-muted/50 hover:bg-accent hover:text-accent-foreground text-muted-foreground"
                >
                    <Search className="w-4 h-4" />
                    <span className="flex-1 text-left">{t('search.placeholder') || 'Search...'}</span>
                    <span className="text-xs opacity-50">⌘K</span>
                </button>

                <nav className="space-y-1 flex-1">
                    {navItems.map((item) => (
                        <button
                            key={item.id}
                            onClick={() => onViewChange(item.id)}
                            className={cn(
                                "w-full flex items-center justify-between px-3 py-2 rounded-md text-sm font-medium transition-colors",
                                currentView === item.id
                                    ? "bg-primary text-primary-foreground"
                                    : "hover:bg-accent hover:text-accent-foreground text-muted-foreground"
                            )}
                            aria-current={currentView === item.id ? 'page' : undefined}
                        >
                            <div className="flex items-center gap-3">
                                <item.icon className="w-4 h-4" />
                                {t(item.labelKey)}
                            </div>
                            {item.count !== undefined && item.count > 0 && (
                                <span className={cn(
                                    "text-xs px-2 py-0.5 rounded-full",
                                    currentView === item.id
                                        ? "bg-primary-foreground/20 text-primary-foreground"
                                        : "bg-muted text-muted-foreground"
                                )}>
                                    {item.count}
                                </span>
                            )}
                        </button>
                    ))}
                </nav>

                <div className="mt-auto pt-4 border-t border-border space-y-1">
                    <button
                        onClick={() => onViewChange('settings')}
                        className={cn(
                            "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                            currentView === 'settings'
                                ? "bg-primary text-primary-foreground"
                                : "hover:bg-accent hover:text-accent-foreground text-muted-foreground"
                        )}
                        aria-current={currentView === 'settings' ? 'page' : undefined}
                    >
                        <Settings className="w-4 h-4" />
                        {t('nav.settings')}
                    </button>
                </div>
            </aside>

            {/* Main Content */}
            <main className="flex-1 overflow-auto">
                <div className={cn(
                    "mx-auto p-8 h-full",
                    ['board', 'calendar'].includes(currentView) ? "max-w-full" : "max-w-4xl"
                )}>
                    {children}
                </div>
            </main>
        </div>
    );
}

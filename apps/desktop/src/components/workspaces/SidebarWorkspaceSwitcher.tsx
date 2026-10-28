import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, FolderOpen } from 'lucide-react';

import { useLanguage } from '../../contexts/language-context';
import { cn } from '../../lib/utils';
import { useWorkspaces } from './use-workspaces';

function ColorDot({ color }: { color: string | null }) {
    return (
        <span
            className={cn('inline-block h-2 w-2 shrink-0 rounded-full', !color && 'bg-muted-foreground/40')}
            style={color ? { backgroundColor: color } : undefined}
            aria-hidden="true"
        />
    );
}

/**
 * Sidebar workspace switcher (#1473). Renders nothing until a second
 * workspace exists, so a user who never adds one sees no change.
 */
export function SidebarWorkspaceSwitcher({ collapsed = false }: { collapsed?: boolean }) {
    const { t } = useLanguage();
    const { list, nameOf, requestSwitch, confirmModal, switching } = useWorkspaces();
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const handleClick = (event: MouseEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [open]);

    if (!list || list.workspaces.length < 2) return null;
    const active = list.workspaces.find((workspace) => workspace.id === list.activeId) ?? list.workspaces[0];
    const activeName = nameOf(active);
    const label = `${t('workspaces.switcherLabel')}: ${activeName}`;

    return (
        <div ref={containerRef} className="relative mb-1.5" data-workspace-switcher>
            <button
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                onKeyDown={(event) => {
                    if (event.key === 'Escape' && open) {
                        event.preventDefault();
                        setOpen(false);
                    }
                }}
                disabled={switching}
                className={cn(
                    'flex items-center gap-2 rounded-lg border-none bg-muted/40 text-[13px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40',
                    collapsed
                        ? 'h-10 w-10 justify-center hover:bg-accent hover:text-accent-foreground'
                        : 'h-9 w-full justify-between px-3',
                )}
                aria-haspopup="true"
                aria-expanded={open}
                aria-label={label}
                title={label}
            >
                {collapsed ? (
                    <span className="relative">
                        <FolderOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="absolute -right-1.5 -top-1.5">
                            <ColorDot color={active.color} />
                        </span>
                    </span>
                ) : (
                    <>
                        <span className="flex min-w-0 items-center gap-2">
                            <ColorDot color={active.color} />
                            <span className="truncate">{activeName}</span>
                        </span>
                        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    </>
                )}
            </button>
            {open && (
                <div
                    role="menu"
                    aria-label={t('workspaces.switcherLabel')}
                    className={cn(
                        'absolute z-20 rounded-lg border border-border bg-popover p-1 shadow-lg',
                        collapsed ? 'bottom-0 left-full ml-2 w-52' : 'bottom-full mb-1 w-full',
                    )}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                            event.preventDefault();
                            setOpen(false);
                        }
                    }}
                >
                    {list.workspaces.map((workspace) => {
                        const isActive = workspace.id === list.activeId;
                        return (
                            <button
                                key={workspace.id}
                                type="button"
                                role="menuitemradio"
                                aria-checked={isActive}
                                onClick={() => {
                                    setOpen(false);
                                    void requestSwitch(workspace);
                                }}
                                className={cn(
                                    'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted/50',
                                    isActive && 'bg-muted/70',
                                )}
                            >
                                <span className="flex min-w-0 items-center gap-2">
                                    <ColorDot color={workspace.color} />
                                    <span className="truncate">{nameOf(workspace)}</span>
                                </span>
                                <Check className={cn('h-3.5 w-3.5 shrink-0', isActive ? 'opacity-100' : 'opacity-0')} />
                            </button>
                        );
                    })}
                </div>
            )}
            {confirmModal}
        </div>
    );
}

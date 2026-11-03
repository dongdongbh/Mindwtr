import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { cn } from '../../../lib/utils';


type SettingKeyProps = {
    settingsKey: string | null;
    title: ReactNode;
    description?: ReactNode;
    className?: string;
    children?: ReactNode;
};

export type SettingRowProps = SettingKeyProps & {


    padded?: boolean;
};


export function SettingRow({
    settingsKey,
    title,
    description,
    padded = false,
    className,
    children,
}: SettingRowProps) {
    return (
        <div
            data-settings-key={settingsKey ?? undefined}
            className={cn(
                'flex items-center justify-between',
                padded ? 'p-4 gap-6' : 'gap-4',
                className,
            )}
        >
            <div className="min-w-0">
                <div className="text-sm font-medium">{title}</div>
                {description ? <div className="text-xs text-muted-foreground mt-1">{description}</div> : null}
            </div>
            {children ? <div className="flex items-center gap-2 shrink-0">{children}</div> : null}
        </div>
    );
}


export function SettingField({
    settingsKey,
    title,
    description,
    className,
    children,
}: SettingKeyProps) {
    return (
        <div
            data-settings-key={settingsKey ?? undefined}
            className={cn('flex flex-col gap-2', className)}
        >
            <label className="text-sm font-medium">{title}</label>
            {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
            {children}
        </div>
    );
}


export function SettingsCard({ children }: { children: ReactNode }) {
    return (
        <div className="bg-card border border-border rounded-lg divide-y divide-border/50">
            {children}
        </div>
    );
}

type SettingsDisclosureCardProps = {


    sectionKey: string;


    settingsKey?: string | null;
    title: string;
    description?: string;
    hint?: string;
    open: boolean;
    onToggle: () => void;
    children: ReactNode;
};


export function SettingsDisclosureCard({
    sectionKey,
    settingsKey = sectionKey,
    title,
    description,
    hint,
    open,
    onToggle,
    children,
}: SettingsDisclosureCardProps) {
    return (
        <div className="bg-card border border-border rounded-lg">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                data-settings-section={sectionKey}
                data-settings-key={settingsKey ?? undefined}
                className="w-full p-4 flex items-center justify-between gap-4 text-left"
            >
                <div className="min-w-0">
                    <div className="text-sm font-medium">{title}</div>
                    {description ? <div className="text-xs text-muted-foreground mt-1">{description}</div> : null}
                    {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
                </div>
                {open ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
            </button>
            {open ? (
                <div className="border-t border-border divide-y divide-border">
                    {children}
                </div>
            ) : null}
        </div>
    );
}

export function SettingsSectionHeader({ children }: { children: ReactNode }) {
    return (
        <h3 className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            {children}
        </h3>
    );
}

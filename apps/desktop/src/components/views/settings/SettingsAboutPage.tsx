import { ExternalLink, RefreshCw } from 'lucide-react';

import { cn } from '../../../lib/utils';

type Labels = {
    version: string;
    installChannel: string;
    developer: string;
    license: string;
    website: string;
    github: string;
    documentation: string;
    sponsorProject: string;
    checkForUpdates: string;
    checking: string;
    checkFailed: string;
};

export type SettingsAboutPageProps = {
    t: Labels;
    appVersion: string;
    installChannel?: string | null;
    onOpenLink: (url: string) => void;
    onCheckUpdates: () => void;
    isCheckingUpdate: boolean;
    updateActionLabel?: string;
    updateError: string | null;
    updateNotice: string | null;
};

export function SettingsAboutPage({
    t,
    appVersion,
    installChannel,
    onOpenLink,
    onCheckUpdates,
    isCheckingUpdate,
    updateActionLabel,
    updateError,
    updateNotice,
}: SettingsAboutPageProps) {
    const actionLabel = updateActionLabel ?? t.checkForUpdates;
    return (
        <div className="bg-muted/30 rounded-lg p-6 space-y-4 border border-border">
            <div className="flex justify-between items-center">
                <span className="text-muted-foreground">{t.version}</span>
                <span className="font-mono bg-muted px-2 py-1 rounded text-sm">v{appVersion}</span>
            </div>
            {installChannel && (
                <>
                    <div className="border-t border-border/50"></div>
                    <div className="flex justify-between items-center gap-4">
                        <span className="text-muted-foreground">{t.installChannel}</span>
                        <span className="font-mono bg-muted px-2 py-1 rounded text-sm">{installChannel}</span>
                    </div>
                </>
            )}
            <div className="border-t border-border/50"></div>
            <div className="flex justify-between items-center">
                <span className="text-muted-foreground">{t.documentation}</span>
                <button
                    onClick={() => onOpenLink('https://github.com/dongdongbh/Mindwtr/wiki')}
                    className="text-primary hover:underline flex items-center gap-1"
                >
                    GitHub Wiki
                    <ExternalLink className="w-3 h-3" />
                </button>
            </div>
            <div className="border-t border-border/50"></div>
            <div className="flex justify-between items-center">
                <span className="text-muted-foreground">{t.sponsorProject}</span>
                <button
                    onClick={() => onOpenLink('https://ko-fi.com/dongdongbh')}
                    className="text-blue-400 hover:underline cursor-pointer flex items-center gap-1"
                >
                    ko-fi.com/dongdongbh
                    <ExternalLink className="w-3 h-3" />
                </button>
            </div>
            <div className="border-t border-border/50"></div>
            <div className="flex justify-between items-center">
                <span className="text-muted-foreground">{t.github}</span>
                <button
                    onClick={() => onOpenLink('https://github.com/dongdongbh/Mindwtr')}
                    className="text-blue-400 hover:underline cursor-pointer flex items-center gap-1"
                >
                    github.com/dongdongbh/Mindwtr
                    <ExternalLink className="w-3 h-3" />
                </button>
            </div>
            <div className="border-t border-border/50"></div>
            <div className="flex justify-between items-center">
                <span className="text-muted-foreground">{t.website}</span>
                <button
                    onClick={() => onOpenLink('https://dongdongbh.tech')}
                    className="text-primary hover:underline flex items-center gap-1"
                >
                    dongdongbh.tech
                    <ExternalLink className="w-3 h-3" />
                </button>
            </div>
            <div className="border-t border-border/50"></div>
            <div className="flex justify-between items-center">
                <span className="text-muted-foreground">{t.developer}</span>
                <span className="font-medium">dongdongbh</span>
            </div>
            <div className="border-t border-border/50"></div>
            <div className="flex justify-between items-center">
                <span className="text-muted-foreground">{t.license}</span>
                <span className="font-medium">AGPL-3.0</span>
            </div>
            <div className="border-t border-border/50"></div>
            <div className="flex justify-between items-center">
                <span className="text-muted-foreground">{actionLabel}</span>
                <button
                    onClick={onCheckUpdates}
                    disabled={isCheckingUpdate}
                    className={cn(
                        "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                        isCheckingUpdate
                            ? "bg-muted text-muted-foreground cursor-not-allowed"
                            : "bg-primary text-primary-foreground hover:bg-primary/90",
                    )}
                >
                    <RefreshCw className={cn("w-4 h-4", isCheckingUpdate && "animate-spin")} />
                    {isCheckingUpdate ? t.checking : actionLabel}
                </button>
            </div>
            {updateError && (
                <div className="text-red-500 text-sm">{t.checkFailed}</div>
            )}
            {updateNotice && !updateError && (
                <div className="text-sm text-muted-foreground">{updateNotice}</div>
            )}
        </div>
    );
}

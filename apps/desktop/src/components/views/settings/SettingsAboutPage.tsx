import { ExternalLink, RefreshCw } from 'lucide-react';

import { cn } from '../../../lib/utils';

type Labels = {
    localData: string;
    localDataDesc: string;
    webDataDesc: string;
    version: string;
    developer: string;
    license: string;
    website: string;
    github: string;
    checkForUpdates: string;
    checking: string;
    checkFailed: string;
};

type SettingsAboutPageProps = {
    t: Labels;
    isTauri: boolean;
    dataPath: string;
    dbPath: string;
    configPath: string;
    appVersion: string;
    onOpenLink: (url: string) => void;
    onCheckUpdates: () => void;
    isCheckingUpdate: boolean;
    updateError: string | null;
    updateNotice: string | null;
};

export function SettingsAboutPage({
    t,
    isTauri,
    dataPath,
    dbPath,
    configPath,
    appVersion,
    onOpenLink,
    onCheckUpdates,
    isCheckingUpdate,
    updateError,
    updateNotice,
}: SettingsAboutPageProps) {
    return (
        <div className="bg-muted/30 rounded-lg p-6 space-y-4 border border-border">
            <div className="space-y-1">
                <div className="text-sm font-medium">{t.localData}</div>
                <div className="text-xs text-muted-foreground">
                    {isTauri ? t.localDataDesc : t.webDataDesc}
                </div>
            </div>
            {isTauri && (
                <div className="grid sm:grid-cols-2 gap-3">
                    {dbPath && (
                        <div className="space-y-1">
                            <div className="text-xs font-medium text-muted-foreground">mindwtr.db</div>
                            <div className="text-xs font-mono bg-muted/60 border border-border rounded px-2 py-1 break-all">
                                {dbPath}
                            </div>
                        </div>
                    )}
                    <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">data.json (backup)</div>
                        <div className="text-xs font-mono bg-muted/60 border border-border rounded px-2 py-1 break-all">
                            {dataPath}
                        </div>
                    </div>
                    <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">config.toml</div>
                        <div className="text-xs font-mono bg-muted/60 border border-border rounded px-2 py-1 break-all">
                            {configPath}
                        </div>
                    </div>
                </div>
            )}
            <div className="border-t border-border/50"></div>
            <div className="flex justify-between items-center">
                <span className="text-muted-foreground">{t.version}</span>
                <span className="font-mono bg-muted px-2 py-1 rounded text-sm">v{appVersion}</span>
            </div>
            <div className="border-t border-border/50"></div>
            <div className="flex justify-between items-center">
                <span className="text-muted-foreground">{t.developer}</span>
                <span className="font-medium">dongdongbh</span>
            </div>
            <div className="border-t border-border/50"></div>
            <div className="flex justify-between items-center">
                <span className="text-muted-foreground">{t.license}</span>
                <span className="font-medium">MIT</span>
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
                <span className="text-muted-foreground">{t.checkForUpdates}</span>
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
                    {isCheckingUpdate ? t.checking : t.checkForUpdates}
                </button>
            </div>
            {updateError && (
                <>
                    <div className="border-t border-border/50"></div>
                    <div className="text-red-500 text-sm">{t.checkFailed}</div>
                </>
            )}
            {updateNotice && !updateError && (
                <>
                    <div className="border-t border-border/50"></div>
                    <div className="text-sm text-muted-foreground">{updateNotice}</div>
                </>
            )}
        </div>
    );
}

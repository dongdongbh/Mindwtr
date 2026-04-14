import { ExternalLink } from 'lucide-react';
import type { UpdateInfo } from '../../../lib/update-service';
import { cn } from '../../../lib/utils';

export type RecommendedDownload = {
    label: string;
    url?: string;
};

export type SettingsUpdateModalProps = {
    isOpen: boolean;
    updateInfo: UpdateInfo | null;
    t: Record<string, string>;
    recommendedDownload: RecommendedDownload | null;
    linuxFlavor: string | null;
    isDownloading: boolean;
    downloadNotice: string | null;
    canDownload: boolean;
    onClose: () => void;
    onDownload: () => void;
};

export function SettingsUpdateModal({
    isOpen,
    updateInfo,
    t,
    recommendedDownload,
    linuxFlavor,
    isDownloading,
    downloadNotice,
    canDownload,
    onClose,
    onDownload,
}: SettingsUpdateModalProps) {
    if (!isOpen || !updateInfo) return null;
    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-card border border-border rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[80vh] flex flex-col">
                <div className="p-6 border-b border-border">
                    <h3 className="text-xl font-semibold text-green-500 flex items-center gap-2">{t.updateAvailable}</h3>
                    <p className="text-muted-foreground mt-1">
                        v{updateInfo.currentVersion} → v{updateInfo.latestVersion}
                    </p>
                </div>
                <div className="p-6 overflow-y-auto flex-1">
                    <h4 className="font-medium mb-2">{t.changelog}</h4>
                    <div className="bg-muted/50 rounded-md p-4 text-sm whitespace-pre-wrap max-h-60 overflow-y-auto">
                        {updateInfo.releaseNotes || t.noChangelog}
                    </div>
                    {recommendedDownload && (
                        <div className="mt-4 text-xs text-muted-foreground">
                            {t.downloadRecommended}: {recommendedDownload.label}
                            {!recommendedDownload.url && linuxFlavor === 'arch' && (
                                <span className="ml-1">• {t.downloadAURHint}</span>
                            )}
                        </div>
                    )}
                    {(isDownloading || downloadNotice) && (
                        <div className="mt-4 space-y-2">
                            {downloadNotice && (
                                <div className="text-xs text-muted-foreground">{downloadNotice}</div>
                            )}
                            {isDownloading && (
                                <div className="h-2 w-full rounded bg-muted">
                                    <div className="h-2 w-1/2 rounded bg-green-500 animate-pulse"></div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
                <div className="p-6 border-t border-border flex gap-3 justify-end">
                    <button
                        onClick={onClose}
                        disabled={isDownloading}
                        className="px-4 py-2 rounded-md text-sm font-medium bg-muted hover:bg-muted/80 transition-colors"
                    >
                        {t.later}
                    </button>
                    <button
                        onClick={onDownload}
                        disabled={isDownloading || !canDownload}
                        className={cn(
                            "px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2",
                            isDownloading || !canDownload
                                ? "bg-muted text-muted-foreground cursor-not-allowed"
                                : "bg-green-600 text-white hover:bg-green-700"
                        )}
                    >
                        <ExternalLink className="w-4 h-4" />
                        {isDownloading ? t.downloadStarting : t.download}
                    </button>
                </div>
            </div>
        </div>
    );
}

import { useId } from 'react';
import { ExternalLink } from 'lucide-react';
import type { UpdateInfo } from '../../../lib/update-service';
import { cn } from '../../../lib/utils';
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '../../ui/Dialog';

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
    const titleId = useId();
    if (!isOpen || !updateInfo) return null;
    const primaryActionLabel = updateInfo.installSource === 'microsoft-store'
        ? t.checkStoreUpdates
        : t.download;
    return (
        <Dialog
            onClose={() => { if (!isDownloading) onClose(); }}
            labelledBy={titleId}

            closeOnBackdrop={false}
            panelClassName="max-w-lg mx-4 max-h-[80vh] bg-card rounded-lg border-border shadow-xl"
        >
            <DialogHeader className="p-6 border-b border-border">
                <h3 id={titleId} className="text-xl font-semibold text-success flex items-center gap-2">{t.updateAvailable}</h3>
                <p className="text-muted-foreground mt-1">
                    v{updateInfo.currentVersion} → v{updateInfo.latestVersion}
                </p>
            </DialogHeader>
            <DialogBody className="p-6 flex-1">
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
                                <div className="h-2 w-1/2 rounded bg-success animate-pulse"></div>
                            </div>
                        )}
                    </div>
                )}
            </DialogBody>
            <DialogFooter className="p-6 border-t border-border flex gap-3 justify-end">
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
                            : "bg-success text-success-foreground hover:bg-success/90"
                    )}
                >
                    <ExternalLink className="w-4 h-4" />
                    {isDownloading ? t.downloadStarting : primaryActionLabel}
                </button>
            </DialogFooter>
        </Dialog>
    );
}

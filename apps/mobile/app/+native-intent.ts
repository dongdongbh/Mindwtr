import { isEntityOpenUrl, isOpenFeatureUrl, parseOpenFeatureUrl, resolveOpenFeaturePath } from '@/lib/capture-deeplink';

const isQuickCaptureUrl = (path: string): boolean => {
    const url = new URL(path);
    if (url.protocol !== 'mindwtr:') return false;
    return url.hostname === 'capture-quick' || url.pathname === '/capture-quick';
};

// Expo Router routes incoming system URLs by path, so mindwtr://open-feature
// would land on the Unmatched Route screen before the root-layout hook can
// redirect. Rewrite it to the destination route up front (#755).
//
// Entity-open links (mindwtr://open?task=...) get the same treatment (#1017):
// land on /inbox immediately so there's no Unmatched Route flash, then
// useRootLayoutExternalCapture's incoming-URL effect (which still sees the
// original URL via Linking.useURL()) resolves the real entity once data is
// ready and re-navigates.
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
    try {
        if (isOpenFeatureUrl(path)) {
            return resolveOpenFeaturePath(parseOpenFeatureUrl(path)?.feature ?? null);
        }
        if (isEntityOpenUrl(path)) {
            return '/inbox';
        }
        // The hidden tab route depends on a focus callback that is not reliable
        // during an Android widget/tile cold launch. The root capture modal is
        // purpose-built for system entry points and works on both cold and warm
        // launches. Current native widget/tile entry points request text mode.
        if (isQuickCaptureUrl(path)) {
            return '/capture-modal';
        }
    } catch {
        // redirectSystemPath must never throw; fall through to the original path.
    }
    return path;
}

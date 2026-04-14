export function normalizeAnalyticsInstallChannel(value: string | null | undefined): string {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return 'unknown';

    // Mindwtr's official Flatpak distribution is Flathub, and analytics dashboards
    // bucket these installs under the store channel rather than generic "flatpak".
    if (normalized === 'flatpak' || normalized.startsWith('flatpak:')) {
        return 'flathub';
    }

    switch (normalized) {
        case 'mac-app-store':
        case 'app-store':
        case 'appstore':
            return 'app-store';
        case 'microsoft-store':
        case 'microsoftstore':
        case 'windows-store':
        case 'ms-store':
        case 'msstore':
            return 'microsoft-store';
        case 'brew':
        case 'home-brew':
            return 'homebrew';
        case 'aur':
            return 'aur-source';
        case 'github-release':
        case 'winget':
        case 'homebrew':
        case 'aur-bin':
        case 'aur-source':
        case 'apt':
        case 'rpm':
        case 'snap':
        case 'appimage':
        case 'portable':
        case 'direct':
            return normalized;
        default:
            return 'unknown';
    }
}

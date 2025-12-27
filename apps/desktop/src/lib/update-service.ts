/**
 * Update service for checking GitHub releases and downloading updates
 */

const GITHUB_RELEASES_API = 'https://api.github.com/repos/dongdongbh/Mindwtr/releases/latest';
const GITHUB_RELEASES_URL = 'https://github.com/dongdongbh/Mindwtr/releases/latest';

export interface UpdateInfo {
    hasUpdate: boolean;
    currentVersion: string;
    latestVersion: string;
    releaseUrl: string;
    releaseNotes: string;
    downloadUrl: string | null;
    platform: string;
    assets: Array<{ name: string; url: string }>;
}

interface GitHubAsset {
    name: string;
    browser_download_url: string;
}

interface GitHubRelease {
    tag_name: string;
    html_url: string;
    body: string;
    assets: GitHubAsset[];
}

/**
 * Detect current platform
 */
function detectPlatform(): string {
    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.includes('win')) return 'windows';
    if (userAgent.includes('mac')) return 'macos';
    if (userAgent.includes('linux')) return 'linux';
    return 'unknown';
}

/**
 * Get platform-specific download URL from release assets
 */
function getDownloadUrl(assets: GitHubAsset[], platform: string): string | null {
    const patterns: Record<string, RegExp[]> = {
        windows: [/\.msi$/i, /\.exe$/i],
        macos: [/\.dmg$/i, /\.app\.tar\.gz$/i],
        linux: [/\.AppImage$/i, /\.deb$/i, /\.rpm$/i]
    };

    const platformPatterns = patterns[platform] || [];

    for (const pattern of platformPatterns) {
        const asset = assets.find(a => pattern.test(a.name));
        if (asset) return asset.browser_download_url;
    }

    return null;
}

/**
 * Compare two semver version strings
 * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1: string, v2: string): number {
    const clean1 = v1.replace(/^v/, '');
    const clean2 = v2.replace(/^v/, '');

    const parts1 = clean1.split('.').map(Number);
    const parts2 = clean2.split('.').map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2) return 1;
        if (p1 < p2) return -1;
    }
    return 0;
}

/**
 * Check for updates from GitHub releases
 */
export async function checkForUpdates(currentVersion: string): Promise<UpdateInfo> {
    const platform = detectPlatform();

    try {
        const response = await fetch(GITHUB_RELEASES_API, {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'Mindwtr-App'
            }
        });

        if (!response.ok) {
            throw new Error(`GitHub API error: ${response.status}`);
        }

        const release: GitHubRelease = await response.json();
        const latestVersion = release.tag_name.replace(/^v/, '');
        const cleanCurrentVersion = currentVersion.replace(/^v/, '');
        const hasUpdate = compareVersions(latestVersion, cleanCurrentVersion) > 0;
        const assets = (release.assets || []).map((asset) => ({
            name: asset.name,
            url: asset.browser_download_url,
        }));
        const downloadUrl = getDownloadUrl(release.assets || [], platform);

        return {
            hasUpdate,
            currentVersion: cleanCurrentVersion,
            latestVersion,
            releaseUrl: release.html_url || GITHUB_RELEASES_URL,
            releaseNotes: release.body || '',
            downloadUrl,
            platform,
            assets,
        };
    } catch (error) {
        console.error('[UpdateService] Failed to check for updates:', error);
        throw error;
    }
}

/**
 * Download and install update
 * Opens the download URL in browser - user will download and run installer
 */
export async function downloadUpdate(downloadUrl: string): Promise<void> {
    // Open the download URL in the default browser
    // The user will download the installer and run it
    window.open(downloadUrl, '_blank');
}

export { GITHUB_RELEASES_URL };

import {
  GITHUB_RELEASES_URL,
  HOMEBREW_CASK_URL,
  findPortableZipAsset,
  type InstallSource,
  type UpdateInfo,
} from "../../../lib/update-service";

export type LinuxDistroInfo = { id?: string; id_like?: string[] };
export type LinuxFlavor = "arch" | "debian" | "rpm" | "other";

export type RecommendedDownload = {
  label: string;
  url?: string;
};

type LinuxPostDownloadNoticeArgs = {
  downloadAURHint: string;
  installSource: InstallSource;
  linuxFlavor: LinuxFlavor | null;
  linuxUpdateHint: string;
};

type PreferredDownloadUrlArgs = {
  installSource: InstallSource;
  linuxFlavor: LinuxFlavor | null;
  recommendedDownload: RecommendedDownload | null;
  updateInfo: UpdateInfo | null;
};

type RecommendedDownloadArgs = {
  installSource: InstallSource;
  linuxFlavor: LinuxFlavor | null;
  updateInfo: UpdateInfo | null;
};

export const resolveLinuxFlavor = (
  linuxDistro: LinuxDistroInfo | null,
): LinuxFlavor | null => {
  if (!linuxDistro) return null;
  const tokens = [linuxDistro.id, ...(linuxDistro.id_like ?? [])]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  if (
    tokens.some((token) => token.includes("arch") || token.includes("manjaro"))
  ) {
    return "arch";
  }
  if (
    tokens.some(
      (token) =>
        token.includes("debian") ||
        token.includes("ubuntu") ||
        token.includes("pop"),
    )
  ) {
    return "debian";
  }
  if (
    tokens.some(
      (token) =>
        token.includes("fedora") ||
        token.includes("rhel") ||
        token.includes("redhat") ||
        token.includes("centos") ||
        token.includes("rocky") ||
        token.includes("alma") ||
        token.includes("suse") ||
        token.includes("opensuse"),
    )
  ) {
    return "rpm";
  }
  return "other";
};

export const buildLinuxPostDownloadNotice = ({
  downloadAURHint,
  installSource,
  linuxFlavor,
  linuxUpdateHint,
}: LinuxPostDownloadNoticeArgs): string => {
  if (linuxFlavor === "arch") {
    if (installSource === "aur-source") {
      return `${downloadAURHint}: yay -Syu mindwtr / paru -Syu mindwtr`;
    }
    if (installSource === "aur-bin") {
      return `${downloadAURHint}: yay -Syu mindwtr-bin / paru -Syu mindwtr-bin`;
    }
    return `${downloadAURHint}: yay -Syu mindwtr / paru -Syu mindwtr`;
  }
  if (linuxFlavor === "debian") {
    return `${linuxUpdateHint} APT repo update: sudo apt update && sudo apt install --only-upgrade mindwtr. Local file install: sudo apt install ./<downloaded-file>.deb`;
  }
  if (linuxFlavor === "rpm") {
    return `${linuxUpdateHint} Repo update: sudo dnf upgrade mindwtr. Local file install: sudo dnf install ./<downloaded-file>.rpm`;
  }
  return `${linuxUpdateHint} AppImage tip: chmod +x <downloaded-file>.AppImage && ./<downloaded-file>.AppImage`;
};

export const resolveRecommendedDownload = ({
  installSource,
  linuxFlavor,
  updateInfo,
}: RecommendedDownloadArgs): RecommendedDownload | null => {
  if (!updateInfo) return null;
  if (installSource === "homebrew") {
    return { label: "Homebrew" };
  }
  if (installSource === "winget") {
    return { label: "winget" };
  }
  if (installSource === "mac-app-store") {
    return { label: "App Store" };
  }
  if (installSource === "microsoft-store") {
    return { label: "Microsoft Store" };
  }

  const assets = updateInfo.assets || [];
  const findAsset = (patterns: RegExp[]) =>
    assets.find((asset) =>
      patterns.some((pattern) => pattern.test(asset.name)),
    );

  if (updateInfo.platform === "windows") {
    if (installSource === "portable") {
      const asset = findPortableZipAsset(assets);
      return asset?.url ? { label: ".zip (portable)", url: asset.url } : null;
    }
    const asset = findAsset([/\.msi$/i, /\.exe$/i]);
    return asset ? { label: ".msi/.exe", url: asset.url } : null;
  }

  if (updateInfo.platform === "macos") {
    return { label: "Homebrew (recommended)", url: HOMEBREW_CASK_URL };
  }

  if (updateInfo.platform === "linux") {
    if (linuxFlavor === "arch") {
      return { label: "AUR" };
    }
    if (linuxFlavor === "debian") {
      const asset = findAsset([/\.deb$/i]);
      return asset?.url ? { label: ".deb", url: asset.url } : null;
    }
    if (linuxFlavor === "rpm") {
      const asset = findAsset([/\.rpm$/i]);
      return asset?.url ? { label: ".rpm", url: asset.url } : null;
    }
    const asset = findAsset([/\.AppImage$/i]);
    return asset?.url ? { label: ".AppImage", url: asset.url } : null;
  }

  return null;
};

export const resolvePreferredDownloadUrl = ({
  installSource,
  linuxFlavor,
  recommendedDownload,
  updateInfo,
}: PreferredDownloadUrlArgs): string | null => {
  if (!updateInfo) return null;
  if (
    installSource === "homebrew" ||
    installSource === "winget" ||
    installSource === "mac-app-store" ||
    installSource === "microsoft-store"
  ) {
    return null;
  }
  if (updateInfo.platform === "linux") {
    if (linuxFlavor === "arch") return null;
    if (linuxFlavor === "debian" || linuxFlavor === "rpm") {
      return (
        recommendedDownload?.url ?? updateInfo.releaseUrl ?? GITHUB_RELEASES_URL
      );
    }
  }
  return (
    recommendedDownload?.url ??
    updateInfo.downloadUrl ??
    updateInfo.releaseUrl ??
    GITHUB_RELEASES_URL
  );
};

export const canDownloadRecommendedUpdate = ({
  installSource,
  isArchLinuxUpdate,
  preferredDownloadUrl,
}: {
  installSource: InstallSource;
  isArchLinuxUpdate: boolean;
  preferredDownloadUrl: string | null;
}): boolean => {
  if (
    installSource === "homebrew" ||
    installSource === "winget" ||
    installSource === "mac-app-store" ||
    installSource === "microsoft-store"
  ) {
    return true;
  }
  return Boolean(preferredDownloadUrl) && !isArchLinuxUpdate;
};

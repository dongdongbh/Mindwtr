# Desktop Installation

Detailed installation instructions for all desktop platforms.

---

## Linux

### Arch Linux (AUR)

The easiest way to install on Arch-based distributions:

```bash
# Using yay
yay -S mindwtr-bin

# Using paru
paru -S mindwtr-bin

# Using pamac (Manjaro)
pamac install mindwtr-bin
```

📦 [AUR Package](https://aur.archlinux.org/packages/mindwtr-bin)

### Debian / Ubuntu

Add the APT repo (recommended):

```bash
curl -fsSL https://dongdongbh.github.io/Mindwtr/mindwtr.gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/mindwtr-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/mindwtr-archive-keyring.gpg] https://dongdongbh.github.io/Mindwtr/deb ./" | sudo tee /etc/apt/sources.list.d/mindwtr.list
sudo apt update
sudo apt install mindwtr
```

Manual install: download the `.deb` from [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases) and run `sudo dpkg -i mindwtr_*.deb`.

### Fedora / RHEL / openSUSE

Add the DNF/YUM repo (recommended):

```bash
cat <<'EOF' | sudo tee /etc/yum.repos.d/mindwtr.repo
[mindwtr]
name=Mindwtr Repository
baseurl=https://dongdongbh.github.io/Mindwtr/rpm
enabled=1
gpgcheck=0
EOF

sudo dnf install mindwtr
```

Manual install: download the `.rpm` from [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases) and run `sudo rpm -i mindwtr-*.rpm`.

### AppImage (Universal)

Works on most Linux distributions:

```bash
# Download
wget https://github.com/dongdongbh/Mindwtr/releases/latest/download/Mindwtr.AppImage

# Make executable
chmod +x Mindwtr*.AppImage

# Run
./Mindwtr*.AppImage
```

> **Tip:** Use [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher) for better desktop integration.

### Other Distributions

For other distributions, use the AppImage or build from source (see [[Developer Guide]]).

---

## Windows

### Microsoft Store (Recommended)

Install from the Microsoft Store:
https://apps.microsoft.com/detail/9n0v5b0b6frx?ocid=webpdpshare

### Winget

Winget is built into Windows 10 and 11. Install Mindwtr with:

```powershell
winget install dongdongbh.Mindwtr
```

### Scoop

If you use Scoop:

```powershell
scoop bucket add mindwtr https://github.com/dongdongbh/homebrew-mindwtr
scoop install mindwtr
```

### Installer (.msi or .exe)

1. Download the installer from [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases)
2. Run the installer
3. Follow the installation wizard
4. Launch Mindwtr from the Start menu

### Portable

1. Download `mindwtr_<version>_windows_x64_portable.zip` from [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases).
2. Extract it to any writable folder.
3. Keep `portable.txt` next to `mindwtr.exe`.

Portable mode stores local state beside the executable:

- `profile/data/` for the SQLite DB, sync JSON, logs, snapshots, and audio captures
- `profile/config/` for `config.toml` and `secrets.toml`

Windows WebView2 is still required.

---

## macOS

### Homebrew (Recommended)

Install using [Homebrew](https://brew.sh/):

```bash
brew install --cask mindwtr
```

### Disk Image (.dmg)

1. Download the `.dmg` from [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases)
2. Open the disk image
3. Drag Mindwtr to your Applications folder
4. Launch from Applications or Spotlight

---

## Data Location

After installation, your data is stored at:

| Platform    | SQLite DB                                     | Sync JSON                                    |
| ----------- | --------------------------------------------- | -------------------------------------------- |
| **Linux**   | `~/.local/share/mindwtr/mindwtr.db`            | `~/.local/share/mindwtr/data.json`           |
| **Windows** | `%APPDATA%/mindwtr/mindwtr.db`                 | `%APPDATA%/mindwtr/data.json`                |
| **macOS**   | `~/Library/Application Support/mindwtr/mindwtr.db` | `~/Library/Application Support/mindwtr/data.json` |

Config is stored separately:

| Platform    | Location                                       |
| ----------- | ---------------------------------------------- |
| **Linux**   | `~/.config/mindwtr/config.toml`                |
| **Windows** | `%APPDATA%/mindwtr/config.toml`                |
| **macOS**   | `~/Library/Application Support/mindwtr/config.toml` |

---

## Updating

1. Check for updates in Settings → About → Check for Updates
2. Download the new version from [Releases](https://github.com/dongdongbh/Mindwtr/releases)
3. Install over your existing installation

Your data is preserved between updates.

---

## Uninstalling

### Linux (Package Manager)
```bash
# AUR
yay -R mindwtr-bin

# Debian/Ubuntu
sudo dpkg -r mindwtr
```

### Windows
Use "Add or Remove Programs" in Windows Settings.

### macOS
Drag Mindwtr from Applications to Trash.

### Data Cleanup
To remove all data, delete both the config and data directories:
```bash
# Linux
rm -rf ~/.config/mindwtr
rm -rf ~/.local/share/mindwtr

# macOS
rm -rf ~/Library/Application\ Support/mindwtr

# Windows (PowerShell)
Remove-Item -Recurse -Force "$env:APPDATA\\mindwtr"
```

---

## Troubleshooting

### App Won't Start (Linux)

Ensure WebKitGTK is installed:
```bash
# Arch
sudo pacman -S webkit2gtk-4.1

# Debian/Ubuntu
sudo apt install libwebkit2gtk-4.1-0
```

### Missing Icons

Install a complete icon theme:
```bash
sudo pacman -S papirus-icon-theme
```

### Blank Window

Try running with GPU disabled:
```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 mindwtr
```

---

## See Also

- [[Getting Started]]
- [[User Guide Desktop]]
- [[Data and Sync]]

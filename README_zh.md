<div align="center">

<img src="apps/mobile/assets/images/icon.png" width="120" alt="Mindwtr Logo">

# Mindwtr

中文 | [English](./README.md)

免费、开源、跨平台的 GTD 应用。本地优先，无需账号。*Mind Like Water.*

*GTD 新手？可阅读 [15 分钟入门 GTD](https://hamberg.no/gtd)。*

[立即安装](#安装) · [快速开始](https://github.com/dongdongbh/Mindwtr/wiki/Getting-Started) · [数据与同步](https://github.com/dongdongbh/Mindwtr/wiki/Data-and-Sync) · [云同步](https://github.com/dongdongbh/Mindwtr/wiki/Cloud-Sync) · [MCP 服务器](https://github.com/dongdongbh/Mindwtr/wiki/MCP-Server)

[![CI](https://github.com/dongdongbh/Mindwtr/actions/workflows/ci.yml/badge.svg)](https://github.com/dongdongbh/Mindwtr/actions/workflows/ci.yml)
[![GitHub license](https://img.shields.io/github/license/dongdongbh/Mindwtr?color=brightgreen)](LICENSE)
[![GitHub downloads](https://img.shields.io/github/downloads/dongdongbh/Mindwtr/total)](https://github.com/dongdongbh/Mindwtr/releases)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/dongdongbh/Mindwtr)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/ahhFxuDBb4)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-ff5f5f?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/dongdongbh)
[![Ko-fi](https://img.shields.io/badge/Sponsor-Ko--fi-29abe0?logo=kofi&logoColor=white)](https://ko-fi.com/D1D01T20WK)

<p align="center" style="text-align: center;">
  <a href="https://apps.microsoft.com/detail/9n0v5b0b6frx?ocid=webpdpshare" target="_blank">
    <img src="https://developer.microsoft.com/store/badges/images/English_get-it-from-MS.png"
         align="center"
         alt="Microsoft Store"
         style="height: 50px"
         height="50" />
  </a>
  <a href="https://play.google.com/store/apps/details?id=tech.dongdongbh.mindwtr" target="_blank">
    <img src="https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png"
         align="center"
         alt="Google Play"
         style="height: 56px"
         height="56" />
  </a>
  <a href="https://apps.apple.com/app/mindwtr/id6758597144" target="_blank">
    <img src="https://tools.applemediaservices.com/api/badges/download-on-the-app-store/black/en-us?size=250x83"
         align="center"
         alt="App Store"
         style="height: 50px"
         height="50" />
  </a>
  <a href="https://apt.izzysoft.de/fdroid/index/apk/tech.dongdongbh.mindwtr" target="_blank">
    <img src="https://gitlab.com/IzzyOnDroid/repo/-/raw/master/assets/IzzyOnDroidButtonGreyBorder_nofont.png"
         align="center"
         alt="Get it on IzzyOnDroid"
         style="height: 50px"
         height="50" />
  </a>
  <a href="https://flathub.org/apps/tech.dongdongbh.mindwtr" target="_blank">
    <img alt="在 Flathub 获取"
         src="https://flathub.org/api/badge?locale=zh-Hans"
         align="center"
         style="height: 50px"
         height="50" />
  </a>
</p>

</div>

<div align="center">
  <video src="https://github.com/user-attachments/assets/8b067635-196e-4c9c-ad26-92ca92fef327" width="60%" autoplay loop muted playsinline></video>
  
  <video src="https://github.com/user-attachments/assets/08e4f821-0b1c-44f9-af58-0b727bc2bd91" width="25%" autoplay loop muted playsinline></video>

  <p>
    <i>Arch Linux 与 Android 上的本地优先 GTD</i>
  </p>
</div>

## 为什么选择 Mindwtr（快速对比）

Mindwtr 面向想要完整 GTD 且不被平台锁定的用户。下面是与主流任务应用和 GTD 垂直应用的简短、尊重事实的对比。

| 能力 | Mindwtr | Todoist | TickTick | Everdo | NirvanaHQ |
|---|---|---|---|---|---|
| 开源 | ✅ | ❌ | ❌ | ❌ | ❌ |
| GTD 原生工作流 | ✅ | ⚠️ | ⚠️ | ✅ | ✅ |
| 全平台（桌面 + 移动 + Web，且含 Linux 桌面端） | ✅ | ✅ | ✅ | ⚠️ | ⚠️ |
| 本地优先 + 无需账号 | ✅ | ❌ | ❌ | ✅ | ❌ |
| AI 助手（BYOK + 本地 LLM） | ✅ | ❌ | ❌ | ❌ | ❌ |
| 灵活同步（WebDAV / Dropbox / 自托管 / 本地文件） | ✅ | ❌ | ❌ | ⚠️ | ❌ |
| 完全免费 | ✅ | ❌ | ❌ | ❌ | ❌ |

说明：`✅` = 支持，`❌` = 不支持，`⚠️` = 部分或受限支持。

*以上信息基于公开产品页面/文档整理。如有变更，欢迎附来源提交 issue/PR。*

## 理念

Mindwtr **默认简单，需要时也足够强大**。我们专注于降低认知负担、删繁就简，让你保持顺畅的工作流：

- **渐进式揭示**：高级选项在需要时才出现。
- **默认更少**：更少字段、更少按钮、更少干扰。
- **避免功能膨胀**：保持清爽与克制。

*我只是想骑车，不要给我驾驶舱。*

## 功能

- 覆盖完整 GTD 流程：收集、澄清、组织、回顾、执行。
- 聚焦视图整合时间日程与下一步行动。
- 本地优先数据模型；在受支持的 Apple 构建中提供原生 iCloud / CloudKit 同步，也支持文件同步、WebDAV、Dropbox 与自托管云方案。
- 项目支持分区与领域，适合更复杂的多步骤规划。
- 桌面端支持 Obsidian 仓库任务导入与笔记深度链接。
- 可选 AI Copilot（BYOK + 本地/自托管兼容模型）。
- 桌面端、移动端与 PWA 全平台可用。
- 内置 CLI、REST API 与 MCP 自动化能力。

<details>
<summary>查看完整功能列表</summary>

### GTD 工作流
- **收集** - 随时快速添加任务（全局快捷键、托盘、分享、语音）
- **澄清** - 2 分钟法则引导的收件箱处理
- **组织** - 项目、分区、情境与状态清单
- **回顾** - 带提醒的每周回顾向导
- **执行** - 基于情境筛选的下一步行动
- **AI 辅助（可选）** - 使用自带密钥的 AI 完成澄清、拆解与回顾（OpenAI、Gemini、Claude，或本地/自托管 OpenAI 兼容 LLM）

### 视图
- 📥 **收件箱** - 任务收集区与处理向导
- 🎯 **聚焦** - 日程（时间维度）+ 下一步行动合并视图
- 📁 **项目** - 支持分区与领域的多步骤成果
- 🏷️ **情境** - 支持父级匹配的斜杠式情境（@work/meetings）
- ⏳ **等待中** - 委派事项
- 💭 **将来/也许** - 延后想法
- 📅 **日历** - 基于时间的规划
- 📋 **看板** - 看板式拖拽
- 📝 **回顾** - 每日 + 每周回顾流程
- 📦 **归档** - 隐藏历史，按需搜索

### 生产力功能
- 🔍 **全局搜索** - 搜索操作符（status:, context:, due:<=7d）
- 📦 **批量操作** - 多选、批量移动/打标签/删除
- 📎 **附件** - 任务支持文件与链接
- ✏️ **Markdown 备注** - 富文本描述与预览
- 🗂️ **项目状态** - 进行中、等待中、将来/也许、归档
- ♾️ **流动重复** - 下次日期按完成时间计算
- ♻️ **可复用清单** - 复制任务或重置清单
- ✅ **清单模式** - 清单任务快速勾选
- ✅ **语音收集** - 语音快速记录、自动转写并创建任务
- 🧭 **Copilot 建议** - 可选的情境/标签/时间提示
- 🍅 **番茄专注（可选）** - 在聚焦视图使用 15/3、25/5、50/10 番茄钟面板
- 🔔 **通知** - 截止提醒与稍后提醒
- 📊 **每日摘要** - 早间简报 + 晚间回顾
- 📅 **每周回顾** - 可定制的每周提醒

### 数据与同步
- 🔄 **同步选项** - 支持后端与配置方式请见 [数据与同步 Wiki](https://github.com/dongdongbh/Mindwtr/wiki/Data-and-Sync)
- 🍎 **原生 iCloud / CloudKit 同步** - 在受支持的 iPhone、iPad 与 macOS 构建中提供 Apple 平台专属结构化同步
- ☁️ **Dropbox OAuth 同步（可选）** - 在支持的非 FOSS 构建中提供原生 Dropbox App Folder 同步
- 📤 **导出/备份** - 导出 JSON 数据
- ♻️ **从备份恢复** - 先创建恢复快照，再用已验证的 Mindwtr 备份替换本地数据
- 📥 **Todoist + DGT GTD 导入** - 将 Todoist CSV/ZIP 导出或 DGT GTD JSON/ZIP 导入到 Mindwtr
- 🔗 **Obsidian 集成** - 桌面端导入 Vault 中的任务，并可深度链接回源笔记
- 🗓️ **外部日历（系统日历 + ICS）** - 移动端读取系统日历；桌面端支持 ICS 订阅

### 自动化
- 🔌 **CLI** - 终端添加/列出/完成/搜索
- 🌐 **REST API** - 本地 API 便于脚本化
- 🌍 **Web 应用（PWA）** - 浏览器离线访问
- 🧠 **MCP 服务器** - 本地 Model Context Protocol 服务用于 LLM 自动化

### 跨平台
- 🖥️ **桌面端** - Tauri v2（macOS、Linux、Windows）
- 📱 **移动端** - React Native/Expo（iOS 通过 App Store/TestFlight、Android）
- 📲 **Android 小部件** - 桌面焦点/下一步小组件
- ⌨️ **键盘快捷键** - Vim 与 Emacs 预设
- 🎨 **主题** - 明/暗模式
- 🌍 **国际化** - 英文、简体中文、繁體中文、西班牙语、印地语、阿拉伯语、德语、俄语、日语、法语、葡萄牙语、波兰语、韩语、意大利语、土耳其语、荷兰语
- 🐳 **Docker** - 使用 Docker 运行 PWA + 自托管同步服务

</details>

## 安装

### 桌面端（Linux）

**Arch Linux（AUR，推荐预编译包）：**
<a href="https://aur.archlinux.org/packages/mindwtr-bin">
  <img src="https://img.shields.io/aur/version/mindwtr-bin?logo=arch-linux&logoColor=white&color=1793d1&label=mindwtr-bin" alt="AUR mindwtr-bin Version">
</a>

```bash
# 使用 yay
yay -S mindwtr-bin

# 使用 paru
paru -S mindwtr-bin
```

**Arch Linux（AUR，源码构建包）：**
<a href="https://aur.archlinux.org/packages/mindwtr">
  <img src="https://img.shields.io/aur/version/mindwtr?logo=arch-linux&logoColor=white&color=1793d1&label=mindwtr" alt="AUR mindwtr Version">
</a>

```bash
# 使用 yay
yay -S mindwtr

# 使用 paru
paru -S mindwtr
```

**Debian / Ubuntu（APT 仓库，推荐）：**
```bash
curl -fsSL https://dongdongbh.github.io/Mindwtr/mindwtr.gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/mindwtr-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/mindwtr-archive-keyring.gpg] https://dongdongbh.github.io/Mindwtr/deb ./" | sudo tee /etc/apt/sources.list.d/mindwtr.list
sudo apt update
sudo apt install mindwtr
```

**Fedora / RHEL / openSUSE（DNF/YUM 仓库，推荐）：**
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

**Flatpak（Flathub）：**
<a href="https://flathub.org/apps/tech.dongdongbh.mindwtr">
  <img src="https://img.shields.io/badge/Flathub-Install-000000?logo=flathub&logoColor=white" alt="在 Flathub 获取">
</a>
```bash
flatpak install flathub tech.dongdongbh.mindwtr
```

**其他方式：** 从 [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases) 获取 AppImage 或 `.deb` / `.rpm`。

### 桌面端（Windows）

**Microsoft Store（推荐）：**
<a href="https://apps.microsoft.com/detail/9n0v5b0b6frx?ocid=webpdpshare">
  <img src="https://img.shields.io/badge/Microsoft_Store-Install-0078D6?logo=microsoft&logoColor=white" alt="Microsoft Store">
</a>

**Winget：**
<a href="https://winstall.app/apps/dongdongbh.Mindwtr">
  <img src="https://img.shields.io/winget/v/dongdongbh.Mindwtr?label=Winget&logo=windows&logoColor=white&color=00D2FF" alt="Winget Version">
</a>
```powershell
winget install dongdongbh.Mindwtr
```

**Scoop：**
<a href="https://github.com/dongdongbh/homebrew-mindwtr">
  <img src="https://img.shields.io/scoop/v/mindwtr?bucket=https://github.com/dongdongbh/homebrew-mindwtr&label=Scoop&logo=scoop&logoColor=white&color=E6E6E6" alt="Scoop Version">
</a>
```powershell
scoop bucket add mindwtr https://github.com/dongdongbh/homebrew-mindwtr
scoop install mindwtr
```

**便携版 ZIP（无需管理员权限）：**

- 从 [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases) 下载 `mindwtr_<version>_windows_x64_portable.zip`。
- 解压到可写目录，并将 `portable.txt` 与 `mindwtr.exe` 放在同一目录。
- Mindwtr 会将数据保存在解压目录下的 `profile/` 中。

**其他方式：** 从 [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases) 获取 `.exe`。

### 桌面端（macOS）

**Mac App Store（推荐）：**
<a href="https://apps.apple.com/app/mindwtr/id6758597144">
  <img src="https://img.shields.io/badge/Mac_App_Store-Install-0A84FF?logo=apple&logoColor=white" alt="Mac App Store">
</a>

通过 Mac App Store 安装：[Mindwtr（Mac App Store）](https://apps.apple.com/app/mindwtr/id6758597144)。
TestFlight 测试版（macOS）：[加入测试版](https://testflight.apple.com/join/7SMJCTSR)。

**Homebrew：**
<a href="https://formulae.brew.sh/cask/mindwtr">
  <img src="https://img.shields.io/homebrew/cask/v/mindwtr?label=Homebrew&logo=homebrew&logoColor=white" alt="Homebrew Cask Version">
</a>
```bash
brew install --cask mindwtr
```

**其他方式：** 从 [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases) 获取 `.dmg`。

### 移动端

**Android：**
<a href="https://play.google.com/store/apps/details?id=tech.dongdongbh.mindwtr">
  <img src="https://img.shields.io/badge/Google_Play-Install-414141?logo=googleplay&logoColor=white" alt="Get it on Google Play">
</a>
<a href="https://apt.izzysoft.de/fdroid/index/apk/tech.dongdongbh.mindwtr">
  <img src="https://img.shields.io/endpoint?url=https://apt.izzysoft.de/fdroid/api/v1/shield/tech.dongdongbh.mindwtr&label=IzzyOnDroid" alt="IzzyOnDroid">
</a>

通过 IzzyOnDroid 安装：
1. 安装兼容 F-Droid 的客户端（Droid-ify、Neo Store 或 F-Droid）。
2. 添加 IzzyOnDroid 仓库：`https://apt.izzysoft.de/fdroid/repo`。
3. 打开 [Mindwtr（IzzyOnDroid）](https://apt.izzysoft.de/fdroid/index/apk/tech.dongdongbh.mindwtr) 并安装。

其他方式：从 [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases) 下载 APK。

**iOS：**
<a href="https://apps.apple.com/app/mindwtr/id6758597144">
  <img src="https://img.shields.io/badge/App_Store-iOS-0A84FF?logo=apple&logoColor=white" alt="App Store">
</a>

已上线 App Store：[Mindwtr for iOS](https://apps.apple.com/app/mindwtr/id6758597144)。
TestFlight 测试版：[加入测试版](https://testflight.apple.com/join/7SMJCTSR)。

不过，维护 iOS 版上架 App Store 需要支付较高的年费（参考 [Apple Developer Program](https://developer.apple.com/support/enrollment/)），目前由我自费承担。

为了让 Mindwtr 能持续发展和维护，非常感谢你的支持！如果你觉得这款应用有价值，欢迎通过 [GitHub Sponsors](https://github.com/sponsors/dongdongbh) 或 [Ko-fi](https://ko-fi.com/D1D01T20WK) 支持项目。

### Docker（PWA + 云同步）

使用 Docker 运行 Web 应用（PWA）和自托管同步服务：
- 指南：[`docker/README.md`](docker/README.md)

安装指南：🚀 [快速开始](https://github.com/dongdongbh/Mindwtr/wiki/Getting-Started)

## 社区

Mindwtr 的发展离不开用户与贡献者的支持，感谢大家一起把它变得更好。

### :hearts: 贡献与支持

如果你想参与进来，请先阅读 [CONTRIBUTING.md](docs/CONTRIBUTING.md)。

你可以通过以下方式帮助项目：

1. **帮忙传播：** 向朋友和社区推荐 Mindwtr，并在 [Product Hunt](https://www.producthunt.com/products/mindwtr) 与 [AlternativeTo](https://alternativeto.net/software/mindwtr/) 支持它。
2. **留下应用商店评价：** 在 [App Store](https://apps.apple.com/app/mindwtr/id6758597144)、[Google Play](https://play.google.com/store/apps/details?id=tech.dongdongbh.mindwtr) 或 [Microsoft Store](https://apps.microsoft.com/detail/9n0v5b0b6frx?ocid=webpdpshare) 的好评对项目帮助很大。
3. **Star 并分享：** 给仓库点个 Star，并在 [X](https://twitter.com/intent/tweet?text=I%20like%20Mindwtr%20https%3A%2F%2Fgithub.com%2Fdongdongbh%2FMindwtr)、[Reddit](https://www.reddit.com/submit?url=https%3A%2F%2Fgithub.com%2Fdongdongbh%2FMindwtr&title=I%20like%20Mindwtr)、[LinkedIn](https://www.linkedin.com/shareArticle?mini=true&url=https%3A%2F%2Fgithub.com%2Fdongdongbh%2FMindwtr&title=I%20like%20Mindwtr) 发布使用体验。
4. **报告问题与提出需求：** 在 [GitHub Issues](https://github.com/dongdongbh/Mindwtr/issues) 提交 Bug 和功能建议。
5. **加入社区讨论：** 欢迎加入 [Discord](https://discord.gg/ahhFxuDBb4)。
6. **参与翻译：** 在 [`packages/core/src/i18n/locales/`](packages/core/src/i18n/locales/) 提交语言翻译改进。
7. **贡献代码或文档：** 提交 PR，并遵循[贡献指南](docs/CONTRIBUTING.md)和提交规范。
8. **认领并实现：** 欢迎社区成员从[路线图](#路线图)或任何开放 issue 中认领条目并提交 PR。
9. **赞助项目：** 可通过 [GitHub Sponsors](https://github.com/sponsors/dongdongbh) 或 [Ko-fi](https://ko-fi.com/D1D01T20WK) 支持持续开发。

## 路线图

- 🤖 上架 F-Droid（[#219](https://github.com/dongdongbh/Mindwtr/issues/219)）
- 🗣️ iOS 提醒事项收件箱导入（Siri 收集 -> Mindwtr 收件箱）
- ✉️ 邮件添加到收件箱（[#35](https://github.com/dongdongbh/Mindwtr/issues/35)）
- 🗓️ Mindwtr 单向导出/同步到外部日历（[#361](https://github.com/dongdongbh/Mindwtr/issues/361)）

## 文档

- 📚 [Wiki](https://github.com/dongdongbh/Mindwtr/wiki) - 完整用户指南
- 🚀 [快速开始](https://github.com/dongdongbh/Mindwtr/wiki/Getting-Started)
- ❓ [FAQ](https://github.com/dongdongbh/Mindwtr/wiki/FAQ)
- 🔄 [数据与同步](https://github.com/dongdongbh/Mindwtr/wiki/Data-and-Sync)
- ☁️ [云同步](https://github.com/dongdongbh/Mindwtr/wiki/Cloud-Sync)
- 🛠️ [云端部署](https://github.com/dongdongbh/Mindwtr/wiki/Cloud-Deployment)
- 🧠 [MCP 服务器](https://github.com/dongdongbh/Mindwtr/wiki/MCP-Server)
- 📝 [版本说明索引](docs/release-notes/README.md)

## 赞助者

感谢这些按月赞助 Mindwtr 的朋友。

<p align="center">
  <a href="https://github.com/jarrydstan" title="@jarrydstan">
    <img src="docs/assets/sponsors/jarrydstan.png" width="60" height="60" alt="@jarrydstan" />
  </a>
  <a href="https://github.com/ronmolenda" title="@ronmolenda">
    <img src="docs/assets/sponsors/ronmolenda.png" width="60" height="60" alt="@ronmolenda" />
  </a>
  <a href="https://github.com/laripernu" title="@laripernu">
    <img src="docs/assets/sponsors/laripernu.png" width="60" height="60" alt="@laripernu" />
  </a>
  <a href="https://github.com/karl1990" title="@karl1990">
    <img src="docs/assets/sponsors/karl1990.png" width="60" height="60" alt="@karl1990" />
  </a>
</p>

<p align="center">
  <sub><a href="https://github.com/jarrydstan">@jarrydstan</a> · <a href="https://github.com/ronmolenda">@ronmolenda</a> · <a href="https://github.com/laripernu">@laripernu</a> · <a href="https://github.com/karl1990">@karl1990</a></sub>
</p>

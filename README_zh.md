<div align="center">

<img src="apps/mobile/assets/images/icon.png" width="120" alt="Mindwtr Logo">

# Mindwtr

中文 | [English](./README.md)

完整的 GTD（Getting Things Done）生产力系统，覆盖桌面与移动端。*Mind Like Water.*

*GTD 新手？可阅读 [15 分钟入门 GTD](https://hamberg.no/gtd)。*

[![CI](https://github.com/dongdongbh/Mindwtr/actions/workflows/ci.yml/badge.svg)](https://github.com/dongdongbh/Mindwtr/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/dongdongbh/Mindwtr?style=social)](https://github.com/dongdongbh/Mindwtr/stargazers)
[![GitHub license](https://img.shields.io/github/license/dongdongbh/Mindwtr)](LICENSE)
[![GitHub last commit](https://img.shields.io/github/last-commit/dongdongbh/Mindwtr)](https://github.com/dongdongbh/Mindwtr/commits/main)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/dongdongbh/Mindwtr/pulls)
[![Sponsor](https://img.shields.io/static/v1?label=Sponsor&message=%E2%9D%A4&logo=GitHub&color=%23fe8e86)](https://github.com/sponsors/dongdongbh)


</div>

<div align="center">
  <video src="https://github.com/user-attachments/assets/8b067635-196e-4c9c-ad26-92ca92fef327" width="60%" autoplay loop muted playsinline></video>
  
  <video src="https://github.com/user-attachments/assets/fe1ce194-fa5a-491a-a3b2-17c96b924219" width="25%" autoplay loop muted playsinline></video>

  <p>
    <i>Arch Linux 与 Android 上的本地优先 GTD</i>
  </p>
</div>

## 功能

### GTD 工作流
- **收集** - 随时快速添加任务（全局快捷键、托盘、分享）
- **澄清** - 2 分钟法则引导的收件箱处理
- **组织** - 项目、情境与状态清单
- **回顾** - 带提醒的每周回顾向导
- **执行** - 基于情境筛选的下一步行动
- **AI 辅助（可选）** - 使用自带密钥的 AI 完成澄清、拆解与回顾

### 视图
- 📥 **收件箱** - 任务收集区与处理向导
- ▶️ **下一步行动** - 基于情境过滤的可执行任务
- 🗓️ **日程** - 每日聚焦与时间概览
- 📁 **项目** - 多步骤结果与领域
- 🏷️ **情境** - 层级情境（@work/meetings）
- ⏳ **等待中** - 委派事项
- 💭 **将来/也许** - 延后想法
- 📅 **日历** - 基于时间的规划
- 📋 **看板** - 看板式拖拽
- 📝 **回顾** - 每日 + 每周回顾流程
- 📦 **归档** - 历史记录，按需搜索

### 生产力功能
- 🔍 **全局搜索** - 语法搜索（status:, context:, due:<=7d）
- 💾 **保存搜索** - 保存并复用搜索过滤器
- 📦 **批量操作** - 多选、批量移动/打标签/删除
- 🔗 **任务依赖** - 任务被前置事项阻塞
- 📎 **附件** - 任务支持文件与链接
- ✏️ **Markdown 备注** - 富文本描述 + 预览
- ♻️ **可复用清单** - 复制任务或重置清单
- ✅ **清单模式** - 清单类任务的快速勾选
- 🧭 **Copilot 建议** - 可选的情境/标签/时间提示
- 🔔 **通知** - 截止提醒与稍后提醒
- 📊 **每日摘要** - 早间简报 + 晚间回顾
- 📅 **每周回顾** - 可定制的每周提醒

### 数据与同步
- 📁 **文件同步** - Dropbox、Google Drive、Syncthing 等
- 🌐 **WebDAV 同步** - Nextcloud、ownCloud、自建
- ☁️ **云同步** - 自托管云后端
- 🔀 **智能合并** - 最后写入优先，防止数据丢失
- 📤 **导出/备份** - 导出 JSON 数据
- 🗓️ **外部日历（ICS）** - 只读日历叠加

### 自动化
- 🔌 **CLI** - 终端添加/完成/搜索
- 🌐 **REST API** - 本地 API 便于脚本化
- 🌍 **Web 应用（PWA）** - 浏览器离线访问

### 跨平台
- 🖥️ **桌面端** - Tauri v2（macOS、Linux、Windows）
- 📱 **移动端** - React Native/Expo（~iOS~、Android）
- 📲 **Android 小部件** - 桌面焦点/下一步小组件
- ⌨️ **键盘快捷键** - Vim 与 Emacs 预设
- 🎨 **主题** - 明/暗模式
- 🌍 **国际化** - 英文与中文

## 安装

### 桌面端（Linux）

**Arch Linux（AUR）：**
```bash
# 使用 yay
yay -S mindwtr-bin

# 使用 paru
paru -S mindwtr-bin
```
📦 [AUR 包](https://aur.archlinux.org/packages/mindwtr-bin)

**Debian/Ubuntu：**
从 [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases) 下载 `.deb` 并安装：
```bash
sudo dpkg -i mindwtr_*.deb
```

**AppImage（通用）：**
从 [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases) 下载 `.AppImage`：
```bash
chmod +x Mindwtr_*.AppImage
./Mindwtr_*.AppImage
```

**Fedora/RHEL/openSUSE：**
从 [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases) 下载 `.rpm` 并安装：
```bash
sudo rpm -i mindwtr-*.rpm
```

### 桌面端（Windows）
从 [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases) 下载安装包（`.msi` 或 `.exe`）并运行。

### 桌面端（macOS）
从 [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases) 下载 `.dmg`，打开后拖拽到“应用程序”文件夹。

> **注意：** 如果 macOS 提示应用“已损坏”或“来自未知开发者”，请执行：
> ```bash
> xattr -cr /Applications/Mindwtr.app
> ```
> 然后正常打开即可。该步骤是因为应用尚未进行苹果公证。

### 移动端

**Android：**
从 [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases) 下载 APK。

**iOS：**
iOS 构建需要 Apple Developer 账号（$99/年），目前仅提供模拟器构建。

## 数据存储

任务和项目保存在本地设备：
- **桌面端数据（Linux）**：`~/.local/share/mindwtr/data.json`
- **桌面端配置（Linux）**：`~/.config/mindwtr/config.toml`
- **移动端**：设备存储（AsyncStorage）

可在设置中选择文件同步（Dropbox 等）、WebDAV（Nextcloud 等）或云同步。

## 文档

- 📚 [Wiki](https://github.com/dongdongbh/Mindwtr/wiki) - 完整用户指南
- 🚀 [快速开始](https://github.com/dongdongbh/Mindwtr/wiki/Getting-Started)
- 💡 [GTD 最佳实践](https://github.com/dongdongbh/Mindwtr/wiki/GTD-Best-Practices)
- 🤖 [AI 助手](https://github.com/dongdongbh/Mindwtr/wiki/AI-Assistant)
- 🗓️ [日历集成](https://github.com/dongdongbh/Mindwtr/wiki/Calendar-Integration)
- ☁️ [云同步（自托管）](https://github.com/dongdongbh/Mindwtr/wiki/Cloud-Sync)
- 🔌 [本地 API 服务](https://github.com/dongdongbh/Mindwtr/wiki/Local-API)
- 🌐 [Web / PWA](https://github.com/dongdongbh/Mindwtr/wiki/Web-App-PWA)

## 开发

开发者请查看 [Development Guide](docs/development.md)。

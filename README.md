# 🌌 Antigravity Standalone

<p align="center">
  <strong>一款独立、优雅、强大的 Google Gemini 账号管理扩展。</strong>
</p>

<p align="center">
    <a href="#-特性">特性</a> • 
    <a href="#-安装">安装</a> • 
    <a href="#-使用指南">使用指南</a> • 
    <a href="#-深度切换原理">深度切换原理</a> • 
    <a href="#-开发构建">开发构建</a>
</p>

---

## 📖 简介

**Antigravity Standalone** 是专为编辑器打造的 Google Gemini 账号辅助工具。它允许您在侧边栏轻松管理多个 Google 账号，实时监控模型额度（Claude/Gemini Pro/Flash），并即时切换编辑器底层的登录状态，助您突破限制，流畅使用 AI 辅助编程。

无需运行额外的后台服务，所有逻辑均集成在扩展内部。

## ✨ 特性

-   **🎨 现代化 UI**：基于 Webview 构建的卡片式界面，支持深色模式，交互行云流水。
-   **🔄 深度账号切换**：不仅仅是表面的切换，支持直接修改编辑器底层数据库 (`state.vscdb`)，完美模拟原生登录状态。
-   **📊 实时配额监控**：直观展示各个模型（Claude 3.5 Sonnet, Gemini Pro/Flash 等）的剩余额度和重置时间。
-   **🔐 原生集成**：作为 VS Code 的 Authentication Provider，在左下角/右上角的“账户”菜单中同步显示当前身份。
-   **🚀 独立运行**：无需依赖这一版本之前的 Tauri 主程序，开箱即用。
-   **⚙️ 灵活配置**：支持自定义反代地址 (Base URL) 和刷新频率。

## 📥 安装

1.  从 Release 页面下载最新的 `.vsix` 文件（例如 `antigravity-vscode-standalone-1.2.2.vsix`）。
2.  打开 VS Code / Cursor。
3.  按 `Cmd+Shift+P` (Mac) 或 `Ctrl+Shift+P` (Win/Linux) 打开命令面板。
4.  输入并选择：**`Extensions: Install from VSIX...`**。
5.  选择下载的文件即可安装。

## 🎮 使用指南

### 1. 添加账号
1.  点击活动栏（Activity Bar）上的 **Antigravity** 图标（通常是字母 **A** 或火箭图标）。
2.  在右下角点击蓝色的 **+** 悬浮按钮。
3.  按照指引获取 Google 账号的 `Refresh Token`（通常需要您登录 Google 并授权）。
4.  输入 Token 后，账号即被添加并自动刷新配额。

### 2. 切换账号
1.  在账号列表中，点击任意非当前账号的**卡片**。
2.  扩展会请求确认进行“深度切换”。
3.  **注意**：为了确保切换在编辑器底层生效，确认后请点击 **“立即退出”**，然后重新打开软件。
    *   *原理：VS Code 只有在冷启动时才会重新读取身份认证数据库。*

### 3. 查看配额详情
*   **进度条**：卡片上醒目的进度条显示当前最紧张的模型的剩余百分比。
    *   🟢 绿色：额度充足 (>50%)
    *   🟡 黄色：额度一般 (30%-50%)
    *   🔴 红色：额度紧张 (<30%)
*   **详细列表**：卡片下方列出了各个具体模型的额度和预计重置时间（例如 `Claude 61% (15m)` 表示 15 分钟后重置）。

### 4. 状态栏
VS Code 底部状态栏右侧也会显示当前账号的关键信息，例如：
`🟢 Claude: 100% 🟢 G Pro: 100% 🟢 G Flash: 100%`
点击状态栏可快速打开侧边栏视图。

## ⚙️ 配置项

您可以在 VS Code 设置 (`Cmd+,`) 中搜索 `antigravity` 进行配置：

*   **`antigravity.baseUrl`**: 
    *   API 请求的基础地址。默认为官方或公共反代地址。如果您自建了 Gemini 代理，请修改此项。
    *   默认值: `https://generativelanguage.googleapis.com` (示例)
*   **`antigravity.refreshInterval`**:
    *   自动刷新配额的时间间隔（毫秒）。
    *   默认值: `180000` (3分钟)。设为 `0` 可禁用自动刷新。

## 🛠 深度切换原理

VS Code 和 Cursor 将登录状态（OAuth Token）存储在本地的 SQLite 数据库文件 `state.vscdb` 中。

普通的扩展无法修改这个受保护的状态，导致通常的“切换账号”只能在扩展内部生效，编辑器本身的 AI 功能（如 Cursor Tab）仍使用旧账号。

**Antigravity 的解决方案**：
1.  通过 `globalStorageUri` 精准定位当前编辑器实例的 `state.vscdb` 文件路径。
2.  使用系统内置的 `sqlite3` 工具，直接将目标账号的 OAuth Token 注入到数据库的 `jetskiStateSync.agentManagerInitState` 字段中（涉及 Protobuf 协议编解码）。
3.  引导用户重启编辑器，迫使编辑器核心重新加载数据库，从而实现“欺骗级”的完美切换。

## 🏗 开发构建

如果您想参与开发或自行构建：

```bash
# 1. 克隆项目
git clone https://github.com/Mac-XK/Antigravity-Standalone.git
cd Antigravity-Manager

# 2. 安装依赖
npm install

# 3. 调试运行
# 在 VS Code 中打开此目录，按 F5 进入调试模式

# 4. 打包发布
npm install -g @vscode/vsce
vsce package
```

## 📄 许可证

MIT License

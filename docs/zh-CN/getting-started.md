# 快速上手（简体中文）

本页是 [Getting Started](../getting-started.md) 中 **Quick Start** 一节（第 1 到第 4 步）的简体中文翻译。该页的其余部分（例如可选的模型路由详细设置）目前仍为英文，请参阅原文。命令、链接以及应用中的英文按钮和菜单名称保持原样，以便与界面一一对应。

## 快速上手

桌面应用需要 **macOS 13 Ventura 或更高版本**，或 Windows 10/11。CoWork OS `0.5.51` 是最后一个兼容 macOS 12 Monterey 的版本。

### 第 1 步：安装并打开桌面应用

**macOS**（Apple Silicon），在 Terminal 中运行。不会出现 Gatekeeper 弹窗：

```bash
curl -fsSL https://coworkosapp.com/install.sh | bash
```

**Windows**（64 位），在 PowerShell 中运行。不会出现 SmartScreen 提示：

```powershell
irm https://coworkosapp.com/install.ps1 | iex
```

**使用 Node.js 24** 可在任何受支持的系统上安装，包括 Intel Mac：`npm install -g cowork-os`，然后运行 `cowork-os`。

安装脚本会从 GitHub 获取最新版本、校验其校验和，然后打开应用。不需要 Git 检出，也不需要编译器。如果你更愿意在浏览器里下载 DMG 或 EXE，请按照 [macOS Installation](../macos-installation.md) 或 [Windows Installation](../windows-installation.md) 处理那一次性的安全提示。终端界面见 [CLI guide](../cli.md)；从源码构建见 [development guide](../development.md)。

首次启动会打开 **What would you like to get done?**。选择一条建议或写下你自己的需求，然后点击 **Start task**。CoWork 会复用已配置的模型接入，需要时会打开模型设置。**Personalize first** 会打开可选的引导设置；**Explore CoWork** 会直接打开应用，以便你按下面的步骤手动操作。参见 [First-result onboarding](../first-result-onboarding.md)。

### 第 2 步：接入并测试一个模型

打开 **Settings > AI & Models > Model Access**，选择账号、API key 或本地模型路由，然后选择一个模型并运行 **Test Connection**。第一个任务请使用私有的起始工作区，不需要选择项目文件夹。如需帮助选择路由，参见 [Model Providers](../providers.md)。

### 第 3 步：选择任务权限

先从 **Ask for approval** 开始，这样当某个操作需要批准时，CoWork 会暂停等待你审核。这与工作方式的选择是两回事（0.5.60 之前的版本把 **Ask** 标为 **Chat**，把 **Do** 标为 **Smart**）。权限决定允许哪些操作；工作方式决定是只提供对话式帮助还是执行任务。

### 第 4 步：创建并检查一个结果

选择 **Do**（0.5.60 之前的版本显示为 **Smart**），然后试试：

> Create a small spreadsheet with six columns and four example rows for a project tracker. Save it in this workspace.

任务完成后，打开它的输出卡片，检查内容，并要求修改一次。任务耗时取决于模型和所要求的工作，CoWork 会在任务时间线中显示进度。之后你可以再选择一个包含自己文件的文件夹。

收到回复后，空的输入框可能会建议下一条消息。按 **Tab** 接受，按需编辑后发送。预测功能使用你选择的 LLM 提供商，即使你忽略建议也会消耗 token；启用了配置文件路由时会使用配置的 Cheap 模型。可在 **Settings → Appearance → Composer → Enable composer predictions** 中开启或关闭。首次出现可用的预测时，还会打开一次性的侧边栏提示。参见 [Composer Predictions](../composer-predictions.md)。

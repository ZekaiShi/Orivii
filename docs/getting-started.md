# 01 · 从安装到第一条消息

[教程目录](README.md) · 下一篇：[日常使用](usage.md)

## 开始前

先确认 **DSH 自己可以正常聊天**。Orivii 使用 DSH 中已经配置的模型，不需要另建一个模型账号。

命令行安装需要 Node.js **24.2.0 或更高的兼容版本**，以及兼容的 DSH **0.2.1** 系列。未安装 DSH 时，先按 [DSH 官方说明](https://github.com/deepseek-ai/deepseek-harness) 完成安装和模型配置。

1.1.0 已提供 GitHub Release 安装包，npm 版本尚待发布验证。当前使用下方 Release 地址或离线安装包。

## 1. 选择你的安装方式

任选一种，不要同时启用多份 Orivii。

### DSH Desktop

打开应用内的插件管理，添加以下插件包地址：

```text
https://github.com/ZekaiShi/Orivii/releases/download/v1.1.0/dsh-orivii-1.1.0.tgz
```

按宿主提示完成安装并重新启动。Desktop 与 Web 使用各自的插件配置；在 Web 中安装，不代表 Desktop 也已安装。

### Windows PowerShell · DSH Web

在 **运行 DSH 后端的 Windows 电脑**上打开 PowerShell。下面全是 Windows 命令，不需要 WSL：

```powershell
node --version
dsh.cmd --version
dsh.cmd plugin --profile web add https://github.com/ZekaiShi/Orivii/releases/download/v1.1.0/dsh-orivii-1.1.0.tgz
```

如果提示找不到 `dsh.cmd`，先确认 DSH 已安装、命令所在目录在 PATH 中，再重新打开 PowerShell。仅安装了 Desktop 的用户可使用上面的应用内入口。

安装后按 DSH 提示重启 Web 后端，再刷新浏览器。不要在无关目录执行 `npm install dsh-orivii` 来替代插件安装；那只会安装 npm 依赖，不会替你启用 DSH 插件。

### Linux / macOS 终端 · DSH Web

```sh
node --version
dsh --version
dsh plugin --profile web add https://github.com/ZekaiShi/Orivii/releases/download/v1.1.0/dsh-orivii-1.1.0.tgz
```

在 DSH 后端所在的环境执行。例如 DSH 运行在 Linux 服务器上，就在该服务器安装；浏览器本身不负责安装插件。

### 从 DSH Market 安装（当前条目为 1.0.2）

市场目录已收录 **Orivii**，分类为 **AGI 探索**。在支持市场的 DSH 插件管理中搜索 `Orivii`，核对仓库是 **ZekaiShi/Orivii** 后安装。

截至 2026-11-12，市场条目的安装包地址仍固定为 **1.0.2**。要使用 **1.1.0**，请使用上面的指定版本包名或下方 Release 地址安装。[查看当前收录记录](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/data/plugins/ZekaiShi__Orivii.yml)。

<details>
<summary><strong>备选：GitHub Release 地址或本地安装包</strong></summary>

Web 安装 Release 地址：

```sh
dsh plugin --profile web add https://github.com/ZekaiShi/Orivii/releases/download/v1.1.0/dsh-orivii-1.1.0.tgz
```

Windows PowerShell 将命令开头的 `dsh` 改为 `dsh.cmd` 即可。

也可以在 [v1.1.0 Release](https://github.com/ZekaiShi/Orivii/releases/tag/v1.1.0) 下载 `dsh-orivii-1.1.0.tgz`，然后从保存文件的目录安装：

```powershell
dsh.cmd plugin --profile web add .\dsh-orivii-1.1.0.tgz
```

Desktop 可在插件管理中添加完整 Release 地址或选择下载的安装包。

本次 Release 附件为 `dsh-orivii-1.1.0.tgz`，来自 **ZekaiShi/Orivii**。npm 包必须使用 **`dsh-orivii`**，npm 上同名的 `dsh-companion` 属于另一个项目。

</details>

## 2. 给 Orivii 一个空间

1. 打开 DSH，点击左侧 **Orivii**。
2. 在 **工作空间** 中选择一个资料目录，或输入绝对路径。没有旧记忆库的目录会进入创建流程；已有记忆库则进入解锁流程。
3. 填写名字，以及希望它怎样称呼你。名字以后仍可修改。
4. 设置至少 **10 个字符**的密码，并再次输入确认；也可以主动选择明文保存。
5. 选择解锁期限，点击 **创建工作空间**。

路径指向 **DSH 后端所在的电脑**，不是打开网页的那台电脑。Windows 可用类似 `D:\Orivii` 的目录；Linux 可用你拥有写入权限的绝对路径。请不要选择代码仓库、公开共享目录或临时目录来保存私人聊天。

**保管好密码。** 加密资料没有“忘记密码”恢复入口。明文模式不提供密码保护。[数据与隐私说明](data-and-privacy.md)

## 3. 发出第一条消息

可以先发送：

> 你好，叫我小林就好。平时回答简短一点。

正常情况下，你会看到自己的消息气泡、回复时的角色反馈，以及 Orivii 的回答。**Enter** 发送，**Shift + Enter** 换行。

如果没有回复，打开 **右上角更多 → 设置 → 连接与模型**，确认使用 DSH 默认模型或选择一个已配置的模型，保存设置后重试。

## 第一次使用完成了吗？

- [ ] 左侧能看到 Orivii，打开后可以正常聊天。
- [ ] 你知道聊天资料保存在哪个目录，并妥善保管了密码。
- [ ] 刷新页面后，仍能看到刚才的聊天。

下一步：[调名字、改称呼、试一次提醒](usage.md)。遇到问题：[按现象排错](troubleshooting.md)。从旧版本迁移请先看 [升级说明](data-and-privacy.md#升级插件)。

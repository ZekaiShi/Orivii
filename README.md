# Orivii

**会记得你，也会替你办事。** A little personality. A lot of company.

[![Orivii — watch the 30-second film](media/preview.gif)](https://github.com/ZekaiShi/Orivii/blob/main/media/orivii-film.mp4)

[▶ 观看完整宣传片](https://github.com/ZekaiShi/Orivii/blob/main/media/orivii-film.mp4) · [下载 1.0.1](https://github.com/ZekaiShi/Orivii/releases/tag/v1.0.1) · [更新计划](UPDATES.md)

Orivii 是 DeepSeek Harness 中的个人助手。像私信一样聊天，用生动的眼睛回应你，在同一工作空间的新聊天中接续记忆，也能查询资料、设置提醒和委托后台工作。

![Orivii 的表情](media/expressions.png)

## 现在可以做什么

- **自然聊天**：独立聊天列表、富文本气泡、自定义名字与称呼，支持连续发送。
- **生动反馈**：表情、眨眼、待机和唤醒动作，支持系统减少动态效果设置。
- **共享记忆**：跨聊天接续话题，检索以前的对话，并允许修正记错的内容。
- **联网与后台工作**：查询公开资料，处理你明确委托的工作，再将结果带回聊天。
- **提醒与关心**：用自然语言约定提醒，支持取消和改期。
- **本地工作空间**：支持密码加密、锁定及重新解锁。
- **多个 Orivii**：在设置中创建和切换不同角色，分别保存聊天、记忆和相处方式。
- **解锁期限**：本次 DSH 运行、8 小时或 24 小时；期限内刷新页面或切换已解锁角色无需重复输入密码。

## 安装

需要 Node.js **>=24.2.0**、兼容的 DSH **0.2.1** 系列，以及已经配置好的模型。

Web 可从 npm 安装预构建包，无需本地编译：

```sh
dsh plugin --profile web add dsh-orivii@1.0.1
```

npm 包名为 **`dsh-orivii`**。npm 上的 `dsh-companion` 属于另一个项目，请勿用它安装 Orivii。

也可以安装 GitHub Release 中的预构建包：

```sh
dsh plugin --profile web add https://github.com/ZekaiShi/Orivii/releases/download/v1.0.1/dsh-companion-1.0.1.tgz
```

也可以从 [Releases](https://github.com/ZekaiShi/Orivii/releases/tag/v1.0.1) 下载安装包：

```sh
dsh plugin --profile web add ./dsh-companion-1.0.1.tgz
```

Desktop 请通过应用内插件管理添加 `dsh-orivii@1.0.1`、上述完整 Release 地址或下载的安装包。安装完成后按提示重新启动并刷新页面。

从旧 GitHub 安装包切换到 npm 包时，先备份各角色工作空间，在插件管理中停用旧 Orivii，再安装新版；避免同时启用两份 Orivii。既有资料位置和加密格式保持兼容。DSH 重启后需要重新解锁。

首次打开 Orivii 时，选择工作空间、设置名字并创建密码，然后开始聊天。路径指向 DSH 后端所在的电脑。

## 多个 Orivii 与解锁

打开“设置 → 我的 Orivii”，可以创建另一个角色并填写名字、最初的相处方式和密码。资料目录会自动分配，原角色的聊天和记忆不会复制过去。创建和切换无需重启 DSH。

- 每个加密角色有自己的密码。首次解锁后，期限内切换回来无需再次输入；明文模式不提供密码保护。
- 解锁期限可选“本次 DSH 运行”“每 8 小时验证”“每 24 小时验证”。刷新和切换不会延长期限；延长策略在下次输入密码后生效。
- 关闭页面不会锁定记忆库。手动“锁定”会锁住当前 Host 全部角色；DSH 退出或电脑重启后重新解锁。Web 与 Desktop 分别管理解锁状态。
- 后台文字任务继续留在原角色中处理。存在未发送草稿或未送达消息时，会先提示处理这些内容再切换。
- 密码、解密密钥和 Orivii 访问令牌不写入浏览器存储。角色选择列表保存名字、资料路径和验证策略；聊天与相处方式沿用各角色的加密选择。

## 使用须知

- 同一工作空间的聊天共享记忆，不同工作空间不会自动共享；记忆可能遗漏或出错。
- 模型与搜索使用 DSH 中配置的服务，相应服务可能收费。
- 本地保存不等于离线处理：模型会接收回答所需的上下文，联网时会发送查询词。
- 加密保护磁盘上的资料。请妥善保存密码；明文模式不提供密码保密。
- 后台工作需要 DSH Host 运行且工作空间已解锁。
- 升级前关闭或锁定访问该工作空间的 Host，并备份用户资料。
- 当前仍有未覆盖的宿主、模型和平台组合，欢迎反馈可复现的问题。

宣传视频使用原创演示对话与场景，不是真实用户聊天录屏。素材来源见 [media/README.md](media/README.md)。

## 参与

[更新记录](CHANGELOG.md) · [未来计划](UPDATES.md) · [贡献说明](CONTRIBUTING.md) · [安全反馈](SECURITY.md)

Issue 请提供版本、环境、最短复现和预期结果，优先使用虚构内容，不要提交密码、密钥或真实聊天资料。

## 许可

[MIT](LICENSE)。本项目是独立社区项目，不隶属于 DeepSeek、OpenAI 或 Apple。

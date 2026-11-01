# Orivii

**会记得你，也会替你办事。** A little personality. A lot of company.

[![Orivii — watch the 30-second film](media/preview.gif)](https://github.com/ZekaiShi/Orivii/blob/main/media/orivii-film.mp4)

[▶ 观看完整宣传片](https://github.com/ZekaiShi/Orivii/blob/main/media/orivii-film.mp4) · [下载 1.0.0](https://github.com/ZekaiShi/Orivii/releases/tag/v1.0.0) · [更新计划](UPDATES.md)

Orivii 是 DeepSeek Harness 中的个人助手。像私信一样聊天，用生动的眼睛回应你，在同一工作空间的新聊天中接续记忆，也能查询资料、设置提醒和委托后台工作。

![Orivii 的表情](media/expressions.png)

## 现在可以做什么

- **自然聊天**：独立聊天列表、富文本气泡、自定义名字与称呼，支持连续发送。
- **生动反馈**：表情、眨眼、待机和唤醒动作，支持系统减少动态效果设置。
- **共享记忆**：跨聊天接续话题，检索以前的对话，并允许修正记错的内容。
- **联网与后台工作**：查询公开资料，处理你明确委托的工作，再将结果带回聊天。
- **提醒与关心**：用自然语言约定提醒，支持取消和改期。
- **本地工作空间**：支持密码加密、锁定及重新解锁。

## 安装

需要 Node.js **>=24.2.0**、兼容的 DSH **0.2.1** 系列，以及已经配置好的模型。

Web：

```sh
dsh plugin --profile web add github:ZekaiShi/Orivii#v1.0.0
```

也可以从 [Releases](https://github.com/ZekaiShi/Orivii/releases/tag/v1.0.0) 下载安装包：

```sh
dsh plugin --profile web add ./dsh-companion-1.0.0.tgz
```

Desktop 请通过应用内插件管理添加 GitHub 来源或下载的安装包。安装完成后按提示重新启动并刷新页面。

首次打开 Orivii 时，选择工作空间、设置名字并创建密码，然后开始聊天。路径指向 DSH 后端所在的电脑。

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

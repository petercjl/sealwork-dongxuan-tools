# sealwork 东轩工具集

在 sealwork 的资料库 → 插件 → 工具插件中添加 `@petercjl/sealwork-dongxuan-tools`，然后启动。自动更新默认开启，可单独关闭。停止后工具、维护指令和维护限制一起退出；移除后不再安装或加载。

当前包含 `package_maintenance`，负责 npm 包和配套 Skill 的维护。后续工具按独立模块加入同一个包，通过清单的 `tools` 分别声明；集合统一安装、启停和更新，工具实现各自维护。

启动后可对当前使用的 Agent 说：“帮我更新 npm 包 @scope/package”。该工具检查实际运行入口及配套 Skill，通过包声明的维护合同执行必要更新，保留宿主原生权限与完成回执。无需加载伴随 Skill。

这是有原生工具和会话钩子权限的受信任代码扩展，在引擎进程内运行；清单验证不提供操作系统沙箱。安装插件本身不授予服务账号、付费调用或业务生成权限。

开发者：使用 pnpm build 独立构建。发布内容包含完整 ESM 产物；运行不依赖开发源码或额外 npm 依赖。合同为 sealwork Tool Plugin API v1。版本 0.1.x 自动更新保持在 0.1.x；新增能力需重新启动确认。兼容性与目标系统实跑证据分别记录。

源码以应用工程中的 `packages/sealwork-dongxuan-tools/` 为准；GitHub 仓库是生成的独立发布镜像。开发者提交源码后，使用 `node scripts/export-release.mjs --destination <发布仓库>` 导出；更新已验证的干净镜像时加 `--replace-generated`。镜像的 `.canonical-source.json` 保存来源提交与目录树，不在镜像中独立修改实现。

发布通过 npm-release-kit 调度 `publish-npm.yml`，精确发布已提交版本。三个系统的包构建、注册/释放和参数拒绝检查通过后，GitHub-hosted 发布任务才使用 OIDC 发布已校验的 tarball。Windows 包检查与 Windows sealwork 实际宿主测试分别记录。

开发扩展：`src/index.ts` 负责组合模块，`src/package-maintenance.ts` 负责现有维护工具及会话策略。新增模块同时更新清单、注册与释放检查；模块加载失败时释放已注册资源。

旧安装迁移：先准备新包，任务空闲时停止并移除旧包 `@petercjl/sealwork-package-maintenance`，再添加和启动本工具集。两者提供同名工具，宿主会拒绝同时安装；迁移保留包外的配置、Skill 与业务数据。旧包不会跨包名自动升级，新包后续沿用默认自动更新。

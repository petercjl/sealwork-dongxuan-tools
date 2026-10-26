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

## 包维护合同

维护工具兼容已有 `{ok:true,commands}` 结构化帮助，并识别 `capabilities.json`、`capabilities --json` 或声明的 `--help --json` 中的 `commandContracts` 与 `maintenanceContract` v1。按类型映射读取 source/status 回执，按声明区分精确 Skill 目录、Skill 父目录和宿主根目录；字段、目标和完整性证明冲突时停止。普通文本帮助不代表包没有机器合同。

多 Skill 包通过 `skills: string[]` 声明完整集合，并为 source/status/install/update 提供显式 `--skill`。默认处理当前 Agent 下该包声明的全部 Skill；调用者可用 `skillName` 选定成员，再以 `targetDirectory` 指定该成员的精确目标。开始写入前核对所有成员的编辑与所有权状态及写入参数；完成回执逐个返回 Skill 同步和宿主源校验，仅全部通过才报告 complete。部分失败保留已完成成员，未知结果先核对再按包声明恢复。

支持既有 `current`/`up_to_date` 和 runtimeEntry/runtime_entry 形式；新的 typed 合同要求身份、目标、所有权及 SHA-256 完整性证据一致。参数与副作用来自声明，缺少写入参数或不支持的合同返回具体差距与已知状态。包源码工作树不作为 npm 自动覆盖目标。

切换到目标自带运行时后重新发现其合同；当全局已安装请求版本、目标运行时较旧时，使用已验证的全局来源执行剩余 Skill 同步，保留目标版本与来源版本的独立证据，不重复获取包或修改 Git 源码。

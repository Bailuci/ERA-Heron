# 参与开发 ERA-Heron 的约定

本文件写给参与开发本仓库的贡献者和 AI 助手。要**用** ERA 制作角色卡，请看 [doc/给AI的制卡流程/SKILL.md](doc/给AI的制卡流程/SKILL.md) 和 [README](README.md)。

## 这是什么

ERA-Heron 是基于 ERA 变量框架（Efficient Rollback Architecture，原作者 世界的山田 / RockingSisyphus）二次开发、持续迭代的酒馆助手变量框架，作者 白鹭辞（Bailuci）。它是 SillyTavern 的酒馆助手（Tavern Helper）脚本：读取 AI 回复中的 `<VariableInsert>` 等指令块，更新聊天变量 `stat_data`，并按消息记录日志，使删除、滑动、编辑消息时变量能正确回滚和重算。

兼容原则：**能低成本兼容就兼容现有角色卡和聊天记录**。ERA-Heron 可以作为独立的新变量体系演进：有明确收益的优化可以改变旧卡、旧聊天的重算结果，但必须在 [更新日志.md](更新日志.md) 中写明升级须知。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/ERA变量框架/` | 源码（入口 `index.ts`） |
| `src/ERA变量框架/core/` | 同步、回滚、指令执行（`crud/`）、schema、工具调用、日志折叠与存档 |
| `src/ERA变量框架/extra/` | 分步更新（额外模型）、正文前规划、EJS 预处理与条目过滤器 |
| `src/ERA变量框架/events/` | 事件队列与 `era:*` 事件处理 |
| `src/ERA变量框架/api/` | 全局接口 `Era` 与各类注册表 |
| `src/ERA变量框架/initer/manual/` | 面板“快速初始化”写入的世界书条目、正则和规则提示词 |
| `src/ERA变量框架/ui/` | 悬浮球与面板（vue） |
| `tests/` | 在 Node 中直接运行真实源码的测试；`tests/bench/` 是性能基准 |
| `scripts/` | 开发脚本（含仓库作者同步母版用的 `sync-template.cjs`） |
| `doc/` | 使用文档，按编号阅读；`doc/示例/` 是可复制示例；`doc/images/` 是 README 截图 |
| `doc/架构与原理.md` | 面向开发者的内部架构、核心流程与源码索引 |
| `开发工具/` | 给角色卡前端用的 `era.ts` 与类型声明 `exported.era.d.ts` |
| `artifact/bundle.js` | 发布产物，用户导入的就是它（由 CI 自动构建，不要提交本地构建） |
| `dist/` | 开发构建产物（由 CI 自动构建，不要提交本地构建） |
| `@types/` | 酒馆助手的类型声明，不要手改 |

## 常用命令

```bash
pnpm install
pnpm check       # 提交前运行：格式检查 + lint + 类型检查 + 全部测试
pnpm test        # 全部测试（含随机操作对拍）
pnpm typecheck   # tsc --noEmit，含 开发工具/ 与 tests/types/（Era 声明与实现的一致性）
pnpm lint        # eslint
pnpm format      # 提交前格式化（src、tests、scripts、开发工具）；CI 只检查格式，不会替你改
pnpm bench       # 性能基准，与 tests/bench/ 下的基线对比（只警告，不阻断）
pnpm release     # 本地构建 artifact/bundle.js（仅用于本地实测，不要提交）
pnpm watch       # 开发时持续构建 dist/（不要提交）
```

pull request 只做检查，不提交产物。**`artifact/` 和 `dist/` 由 CI 生成，本地构建的结果（Windows 与 Linux 的模块编号不同）不要提交。**

## 改代码时必须做到

1. **许可证（AFPL 第 2(c)(i) 条）**：改过的源文件开头保留修改声明（修改人、日期、简短目的），每个文件每个版本补一行即可，不必逐次详写。不得收费分发；不要改 `LICENSE`。
2. **更新日志只记用户关心的变化**：[更新日志.md](更新日志.md) 只记录新功能、行为变化、问题修复和需要用户注意的升级须知；不要写入内部整理（例如文件改名、文档结构或措辞调整、去掉某些联系方式等）。`initer/manual/` 下规则条目、提示词和正则的改动会改变 AI 的行为，属于用户可见变化，发版时要写进更新日志；纯文档改动不用写。
3. **测试与实测**：改动核心逻辑要补测试，`pnpm check` 必须全部通过。涉及同步、回滚的改动，确认随机对拍测试（`tests/era_sync.test.cjs`）通过，并跑 `pnpm bench` 与基线对比。提 PR 前在自己的酒馆里实际测过改动涉及的功能，并在 PR 里说明测了什么。
4. **兼容**：指令解析、日志格式、`ERAMetaData` 的结构改变时，优先让旧数据仍按原来的含义解释（参考 `core/api_ops.ts` 中 `by` 字段的做法）；代价过大时可以不兼容，写明升级须知。
5. **提示词与正则**：`initer/manual/` 下的条目和正则只影响新建的卡。旧卡只能通过面板“更新旧卡的规则”（`initer/manual/update.ts`）拿到以下改动：
   - `era_var_operation_rule.txt` 的正文（整体覆盖，原内容备份）；
   - 数据、元数据、思考块三条隐藏正则的 `find_regex`（其余字段保留作者的设置）；
   - 缺少的元数据、思考块、状态栏占位符隐藏正则（补上）。

   `era_var_intent.txt`（意图说明由作者填写，只有从未改动过的最早版本会被补上变量宏）、状态栏模板 `status_bar.html` 以及正则的其他字段**不会**下发到旧卡。新增正则时，同时决定旧卡是否需要它，并在 `update.ts` 与 `tests/era_initer.test.cjs` 中体现。隐藏正则必须覆盖解析器支持的全部标签（`tests/era_docs.test.cjs` 会检查）。
6. **文档与类型同步**：新增或改变事件、`Era` 接口、脚本设置时，同步更新 `doc/05-接口与设置.md`、`开发工具/exported.era.d.ts` 以及 `doc/给AI的制卡流程/SKILL.md` 中受影响的步骤；涉及模块架构变化时同步更新 `doc/架构与原理.md`。

## 设计上的坑

- 不要在酒馆的 `GENERATION_STARTED` 里暂停生成：此时界面没有锁定，会造成重复生成、串聊天。需要等待时在点击发送前拦截（见 `extra/send_guard.ts`）。
- 钩子、schema、工具和条目过滤器必须是同步纯函数且幂等：历史消息会被反复重算。
- 消息正文是变量的事实来源；`ApiOps` 是正文之外的唯一源数据，其余（日志、存档）都是可以从正文重建的缓存。

## 发版（仅仓库作者）

普通贡献者提 PR **不需要**改版本号、不需要提交 `artifact/` 和 `dist/`、不需要同步制卡母版。以下流程仅仓库作者发版时执行：

1. **版本号五处一致**：发布新版本时同时更新 `package.json`、`src/ERA变量框架/utils/constants.ts` 的 `ERA_VERSION`、`更新日志.md` 最新一节的标题、`README.md`（当前版本、脚本名、导入地址）和 `doc/01-快速上手.md` 中的 `@vX.Y.Z`；`tests/era_version.test.cjs` 会检查它们一致。
2. **推送与构建**：推送前先执行 `git pull --ff-only`。推送到 `main` 后，GitHub Actions 会依次做格式检查、lint、类型检查、测试，再自动构建并提交 `[bot] bundle`。
3. **打标签**：等 CI 提交 `[bot] bundle` 后，执行 `git pull --ff-only`，再在这个 bot 提交上打 `vX.Y.Z` 标签并推送标签。用户通过 jsDelivr 的 `@vX.Y.Z` 导入，标签必须指向 CI 构建的 `artifact/bundle.js`；**已推送的标签不要移动或重打**（CDN 对版本标签的文件是永久缓存的）。
4. **同步制卡母版**：执行 `pnpm sync-template` 预览与母版 `tavern_era_template` 的差异（检查所有 `required` 改写规则和专有路径），确认无误后再加 `--write` 写入母版。

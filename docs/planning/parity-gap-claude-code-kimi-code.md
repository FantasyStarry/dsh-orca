# Orca 对标 Claude Code / Kimi Code：能力差距分析

> **口径与快照**
>
> - **Orca**：本仓库 `main` @ `0.6.0`。结论按源码核对（`src/app.ts` 3502 行、`src/adapter/channel.ts` 944 行、`src/tui/*`、`cordis.patch.yml`），不按 README 的自我描述。
> - **dsh 内核**：能力台账读自本机安装树（**开始盘点时 0.1.5-rc.1；2026-09-11 复核时安装已自动升到 0.1.5-rc.2**，plan-review 契约 / approval 词表 / preset roster / dsh-base 行清单逐条复核一致）。来源：各 `@deepseek-ai/dsh-*` 包 README + `dsh-base` / `dsh-web-app` 的 `cordis.patch.yml` 行清单 + `dsh --profile orca --dump-config`。
> - **Kimi Code**：`docs/research/kimi-code-research.md`（2026-09，MoonshotAI/kimi-code 公开文档）。
> - **Claude Code**：Anthropic 公开文档（2026-09-10 抓取）+ **本机安装 `claude` 2.1.260 的 `--help` 一手输出**（npm `latest` 同期为 2.1.267）。带 `?` 的格子表示未能一手确认，落地前需复核。
> - 本文只比较**用户可见能力**与**可扩展性**，不做"抄哪个实现"的评估；所有差距都标注了落点（自研 / 加 profile 行 / 需要上游）。

---

## 0. 结论（TL;DR）

1. **内核不欠账，欠账在外壳。** dsh 0.1.5-rc.1/rc.2 的插件树里已经有对标所需的大部分**能力件**：skills（`dsh-skill` + `dsh-skill-filesystem` + `dsh-tool-skill`）、子代理（`dsh-subagent` + spawn/fork provider + `send_message`/`interrupt_agent`/`list_agents` 续跑控制工具）、MCP 客户端（`dsh-mcp-client`）、**Claude Code / Codex hooks 桥**（`dsh-hooks-claude-code` / `dsh-hooks-codex`）、持久目标（`dsh-goal`）、后台任务（`dsh-jobs`）、工作流与 Ralph（`dsh-workflow` / `dsh-tool-ralph`）、plan mode（`dsh-plan-mode`）、权限档位（`dsh-permission-presets`）、AGENTS.md/CLAUDE.md 注入（`dsh-agent-instructions`）、会话查询/投影/导出、token 计量（`dsh-token-meter`）。其中大半**已在 `dsh-base` 里**（也就是 Orca profile 默认挂载的组合），只是 Orca 没有把它们呈现在界面上。
2. **Orca 真正缺的是三层外壳**：① **入口层** —— 自定义命令、skill 命令与目录、插件/设置/主题面板；② **管理层** —— 子代理/后台任务/目标/审批规则/导出/会话搜索；③ **打磨层** —— 状态栏、桌面通知、`!` shell、vim、i18n、窄屏。
3. **只有三个真正影响日常使用的内核缺口**（Orca 侧可用影子实现绕开，仍不需要改内核；完整清单含"可以明确不做"的那些，见 §7.1C）：① 审批只有一次性 `allowed-once`，没有会话级放行与持久规则；② MCP 是"一行一服务器"的静态配置，没有运行时配置面；③ 内核命令不接受 TUI 的附件（`CommandSubmitAttachment` 需要 staged receipt）。
4. **最大的结构性差距**：Orca 是单体 `app.ts`，**没有自己的扩展点**。Claude Code 有 plugins + marketplace，Kimi 有插件包 + `/plugins` 面板，dsh-TUI 生态有 scenes/dialogs/status/shortcuts/settings 的宿主 spec —— Orca 三者皆无，于是每个新功能只能靠自研堆在同一个文件里。
5. **建议顺序**：P0 = 命令/扩展入口（skill 命令、自定义命令、`/todo` 与 `/plan` 落回真源、`/permission` 不再影子遮蔽内核）→ P1 = 任务与会话管理（子代理面板、后台任务、审批规则、导出、`--doctor`）→ P2 = 终端打磨与扩展点（状态栏、通知、主题、`!` shell、vim、i18n、controller 拆分）。

### 差距分级（全文统一）

| 级别 | 含义 | 行动性质 |
| --- | --- | --- |
| **L0** | 已对齐，个别处领先 | 保持 |
| **L1** | 有入口但浅：能用，缺闭环/缺 UX | 打磨 |
| **L2** | 内核已有该能力，Orca 未接入 | Orca 自研（零内核改动） |
| **L3** | 内核有包但当前 profile 未挂载 | 加 profile/patch 行（或装可选包） |
| **L4** | 内核也没有 | 需上游；TUI 侧只能影子实现或明确不做 |

---

## 1. Orca 现状台账（源码核对）

| 领域 | 现状 | 位置 |
| --- | --- | --- |
| 插件契约 | `name` / `Config` / `apply` 三面，无默认导出；runtime 延迟加载；`ctx.effect` 统一 disposer | `src/index.ts` / `src/app.ts` |
| 装配 | TTY 门 → agent 工厂（create 或 `ORCA_RESUME_SESSION` resume）→ channel/renderer/keyboard → 统一卸载 | `src/app.ts` |
| 渲染 | 自研差量渲染器；流式增量上屏（`agent/assistant-stream`）；封存行滚入 scrollback；CSI 2026 同步输出；备用屏全屏模式 | `src/tui/renderer.ts` `src/tui/chat.ts` |
| 消息呈现 | Markdown、轻量代码高亮、工具卡（运行状态/结果/`tool/result.meta.diffs` 行级 diff）、思考折叠（`Ctrl+O`）、回合结算行 | `src/tui/markdown.ts` `src/tui/highlight.ts` `src/adapter/channel.ts` |
| 事件投影 | 已覆盖：turn/step 边界、user/assistant/system 消息、`request/header`、tool call/result、session/title、command/run·done、compaction/start·summary·end·prune、hook/invoked·result、approval/asked·decided、todo/write；未知事件宽容忽略 | `src/adapter/channel.ts` |
| 输入 | raw 模式键盘解析（bracketed paste / CSI / Kitty 协议）、多行编辑（`Alt+Enter`/`Shift+Enter`/`Ctrl+J`，cell 软换行，8 行窗口）、`↑↓` 行内光标、历史召回、`@path` 补全（`fileReferences` 软探测 + 本地回退）、`Ctrl+A/E/K/U/W` | `src/tui/input.ts` `src/tui/keys.ts` `src/app.ts` |
| 附件 | 剪贴板图片（Windows PowerShell / macOS pngpaste·pbpaste / Linux wl-paste·xclip，失败降级）、`/img` 附加本地文件（image/file 块）、内联 `[image #N]` 占位符、遵守部署的 `imageLimits.mediaTypes` 与 `maxMessageImageBytes` | `src/clipboard.ts` `src/app.ts` |
| 鼠标 | 仅备用屏接管（`?1002h`+`?1006h`）：拖拽选择（cell 精确）+ 松手 OSC 52 复制（80KB 上限）、滚轮窗口滚动；inline 模式不发送任何鼠标字节 | `src/tui/selection.ts` `src/tui/renderer.ts` |
| 命令 | 16 条本地命令 + 内核 `commands` 服务命令镜像（菜单与 `/help` 合并显示，跟随 `commands/change` 刷新，**同名只列一次**）；未知 `/x` 交给内核注册表，仍未命中才作为普通消息发给模型 | `src/app.ts` `SLASH_COMMANDS` |
| 审批 | `approval/request` waterfall → picker（**仅「放行单次 / 拒绝」**）；`/yolo` 本地自动放行；`/permission` = 本地策略解释 + **参数委托内核档位命令**（P0-1）；`/ask` 靠「先拒绝审批」实现 | `src/app.ts` §approval panel |
| 模型路由 | `/model` 三段式（provider → model → 思考强度）；以 `model/selection` 落 durable 记录 + 写全局默认；`system-prompt/assemble` 重写 `{{provider}}/{{model}}`；`agent/request` 用装配时快照路由 | `src/app.ts` |
| 会话 | `/new`、`/resume`（`sessionQuery` 列表 + 标题/时间/cwd）、`/title`、`/compact [hint]`（委托内核 `command-compact`）、双击 `Esc` rewind（`sessions.fork` 到上一轮边界）、durable `model/selection` 恢复 | `src/app.ts` |
| 预设 | `/preset` 列出/切换 agent preset（下个新会话生效）；`cordis.patch.yml` 插入 `agent-presets`（roster：standard/ptc/minimal/cordis + 用户根） | `src/app.ts` `cordis.patch.yml` |
| 工作区 | 会话自动登记进 cwd 对应工作区（`workspaceRegistry.attachSession`），写前过漂移守卫；不创建/改名/排序 | `src/app.ts` |
| 待办 | `todo/write` 投影到 `channel.todos`；`/todo` 只读展示，`add/set/done/undo/del/clear` 生成指令**交给模型改写**（P0-3；本地不再伪造真源） | `src/app.ts` `doTodo` |
| Plan | 委托内核 `dsh-plan-mode`（`/plan` / `/plan off` / 指令文本）；状态由 `plan/mode` 日志投影（`channel.planActive`，resume/fork 可恢复）；`exit_plan_mode` 评审走 userQuestions 并渲染成评审面板（P0-2） | `src/app.ts` `doPlan` / `showCurrentQuestion` |
| 自更新 | `/update` / `orca update`（npm 检查 + 安装） | `src/update.ts` |
| 工具链 | tsc strict（`noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` / `verbatimModuleSyntax`）、25 条单测、假内核 dev harness（12 phase）、真 PTY 探针（`--state` / `--features` / `--live` / `--fullscreen`）、CI ubuntu+windows | `scripts/` `.github/workflows/ci.yml` |

**一句话**：Orca 把"终端里跑一个 agent 回合"这条主链路做得很扎实（流式、diff、审批、多行编辑、选区复制、会话恢复、模型路由与 web 端一致），但**除主链路之外的产品面几乎空白**。

---

## 2. 十域差距矩阵

### 2.1 入口与命令层

| 能力 | Claude Code | Kimi Code | 内核现状 | Orca 现状 | 级别 |
| --- | --- | --- | --- | --- | --- |
| 内置 slash 命令 | **~150 条**（内置命令 + 捆绑 skills + 动态 workflows；官方"slash commands"文档页已并入 Skills） | ~35 条，含别名（`/h` `/resume` `/rename` `/clear` `/q`） | `commands` 服务 + 4 个内核命令（`/compact` `/feedback` `/goal` `/plan`） | 16 条本地 + 内核命令镜像；无别名参与菜单匹配之外的模糊搜索 | **L1** |
| 命令菜单体验 | 边输边过滤 | 别名参与过滤、分组（Account/Session/Mode/Info/Exit）、idle-only 标注、未匹配即普通消息 | `commands.list()` 带 `description`/`input.hint` | **已补（P0-6）**：四段固定分区（本地/自定义/内核/Skills）、子序列模糊匹配（`/modl` → `/model`）、内核 `input.hint` 作参数提示、忙时 idle-only 置灰并在回车时说明；分区固定顺序避免标题挤占窗口 | **L0/L1** |
| 自定义命令（Markdown → 命令） | `.claude/commands/*.md` **已并入 skills 体系**（frontmatter `description`/`argument-hint`/`allowed-tools`/`model`；`$ARGUMENTS`、`!`bash、`@`file、子目录命名空间） | 插件包 `commands`（注册为 `/pluginId:command`，`$ARGUMENTS` 替换） | 无（命令由插件用 `ctx.commands.register` 注册，纯代码） | **已实现（P0-5）**：`<cwd>/.orca/commands/**/*.md` + `$DSH_HOME/orca/commands`，`description`/`argument-hint` frontmatter、`db/migrate.md` → `/db:migrate`、`$ARGUMENTS` 展开、菜单「自定义」分区；展开后走普通消息路径（附件随行）。缺 `!`bash / `@`file / allowed-tools 预授权 | **L1** |
| Skill 即命令 | `/<skill-name>` | `/skill:<name> [extra]`、`/parent.sub`、忙时可排队 | `dsh-tool-skill` 已实现 `/name` **用户手势**（用户消息里出现的 skill 名会注入 `<skill_content>`）；`ctx.skills.list()` 供人侧目录 | **已实现（P0-4）**：菜单「Skills」分区只列 `userInvocable`，`/skills` 打印目录 + 来源 + 仅模型可用计数；调用走原文手势。缺 skill 参数占位符（`$ARGUMENTS` 类）与忙时排队 | **L1** |
| 忙时输入 | 排队（消息变为下一回合） | 排队 + `Ctrl-S` 把排队命令注入当前回合 | `agent.followup()` 排队；`agent.steer()` 可注入 | 只用 `followup` 排队；有队列样式但无"立即注入当前回合"入口 | **L1** |
| 命令附件 | 支持 | 支持（`/plan` 可带图） | `CommandSubmitAttachment` 需要 staged receipt | 明确不支持：内核命令收到附件时提示"未附带附件" | **L4**（Orca 已在代码里记录该接缝缺口） |
| 权限命令 | `/permissions` 面板 | `/permission` 选择模式 | `dsh-permission-presets` 注册 `/permission`（report/change 预设） | 无参 = 本地策略 + 内核档位报告；**带参已委托内核命令**（P0-1），档位可切换 | **L0/L1** |

### 2.2 记忆与上下文

| 能力 | Claude Code | Kimi Code | 内核现状 | Orca 现状 | 级别 |
| --- | --- | --- | --- | --- | --- |
| 项目指令文件 | `CLAUDE.md`（企业/用户/项目/本地四级 + `@import`）+ `.claude/rules/`（带 `paths:` frontmatter 的规则文件）+ **auto memory**（`~/.claude/projects/<proj>/memory/MEMORY.md`，载入上限 200 行/25KB）。**官方确认不读 `AGENTS.md`**（需 `@AGENTS.md` 或软链） | `AGENTS.md`（`${agents_md}` 注入） | `dsh-agent-instructions` 已在 base：`$DSH_HOME/AGENTS.md` + 项目链（`AGENTS.md`/`CLAUDE.md`/`*.local.md`），64KiB 预算，随文件操作增量刷新 | 内核已注入（含 `CLAUDE.md`，**这点比 Claude Code 宽**），但 Orca 界面不提示加载了哪些指令文件 | **L1** |
| 生成/编辑记忆 | `/init`（分析仓库生成）、`#` 快捷追加、`/memory` 编辑 | `/init` 生成 AGENTS.md | 无对应命令；但可直接发一条 prompt 完成 | 无 | **L2** |
| 上下文用量 | `/context`、`/cost`、状态行 | `/usage`（token/上下文/配额）+ footer `context:N%` | `dsh-token-meter` 提供 `tokenUsage`/`contextPressure`/`contextBreakdown` 投影 | `/usage` 只打印原始 token 数（输入/输出/推理/缓存）；footer 无百分比/阈值配色 | **L2** |
| 自动压缩与提示 | 自动 compact + 提示 | 接近窗口自动压缩、`/compact [hint]`、`PreCompact/PostCompact`、压缩摘要 `Ctrl-O`、**缓存过期提示弹窗** | `dsh-compaction-basic` + `dsh-command-compact` + `tool-result-pruner` 均在 base | `/compact [hint]` 已委托内核；压缩行有投影；**无用量阈值预警、无缓存过期提示** | **L1** |
| 会话标题 | 自动生成 | `/title`（持久化 `state.json`） | `dsh-session-title` + `dsh-session-title-first-prompt-llm` 在 base（LLM 生成） | `/title` 查看/设置；footer 显示标题 | **L0** |

### 2.3 权限、审批与沙箱

| 能力 | Claude Code | Kimi Code | 内核现状 | Orca 现状 | 级别 |
| --- | --- | --- | --- | --- | --- |
| 权限档位 | `--permission-mode acceptEdits\|auto\|bypassPermissions\|manual\|dontAsk\|plan` + `Shift+Tab` 循环 + `--permission-prompts host\|none` | `manual` / `yolo` / `auto` | `dsh-permission-presets`：`read-only` / `workspace-write` / `danger-full-access`（沙箱模式 + 审批策略绑定） | 无档位概念；`/yolo` 是本地自动放行，`/permission` 只读 | **L2** |
| 规则（allow/deny/ask） | `settings.json` 的 `permissions.allow/deny/ask`（`Bash(npm run test:*)` 等模式）+ 启动参数 `--allowedTools`/`--disallowedTools` + `.claude/rules/` | `[[permission.rules]]`：`decision`/`scope`/`pattern`/`reason`，MCP 通配 `mcp__server__*` | **无**：`dsh-user-approval` 明确只有一次性 `allowed-once`，没有 allow-always、规则存储或撤销 | 无 | **L4 → TUI 影子实现可行** |
| 会话级放行 | "Yes, allow all edits during this session" | "Approve for this session" | 无（同上） | 无（只有"放行单次 / 拒绝"两项） | **L4 → TUI 影子实现可行** |
| 只读免问 | 只读工具默认不问 | Read/Grep/Glob 默认放行 | 由 sandbox policy + approval 组合决定 | 依赖部署默认，Orca 无本地规则层 | **L2** |
| 审批面板交互 | 多项 + diff 预览 | `↑↓`/`1`/`2`/`3` 直选、`Ctrl-E` 展开 diff/文件预览、Esc 拒绝 | `approval/request` 携带 `callId`；Orca 可用 `toolPreviewFor(callId)` 取参数 | 两项选择 + 单行参数预览（无编号键、无 diff 展开、无多选项结构） | **L1** |
| 沙箱 | `--restricted` 受限模式、网络域名允许列表、`--safe-mode`（关掉所有定制化排查配置）、`--bare`（跳过 hooks/插件/auto-memory 等） | 见 permission 模式 | `dsh-sandbox-local` + `sandbox-policy`（`workspaceRoot`）+ bash/pwsh sandbox；部署默认由 `DSH_PERMISSION_MODE` 控制 | 完全依赖部署；TUI 不展示当前沙箱档位/根目录 | **L2** |
| 不可信仓库信任门 | hooks/MCP 首次运行提示；项目级 `.mcp.json` 服务器标记 "⏸ Pending approval"、`claude mcp reset-project-choices`；`-p` 非交互模式**跳过信任对话框**（官方警告只在信任目录用） | 工作区信任门（项目 MCP/agent/skill 默认不信任） | 无统一信任门；`agent-instructions` 只是注入 | 无 | **L4**（安全上值得自建"首次加载项目指令/脚本类扩展时提示"） |

### 2.4 扩展生态

| 能力 | Claude Code | Kimi Code | 内核现状 | Orca 现状 | 级别 |
| --- | --- | --- | --- | --- | --- |
| Skills | `.claude/skills/<name>/SKILL.md`，三级渐进披露，个人/项目/插件作用域（**内部自定义命令体系已并入 skills**） | `.kimi-code/skills/`、`~/.agents/skills/`、`extra_skill_dirs`；`prompt`/`inline`/`flow` 三类；最多 3 层嵌套 | **已在 base**：`dsh-skill`（`ctx.skills` 注册表：合并目录、`list`/`snapshot`、`skills/change` 事件）+ `dsh-skill-filesystem`（项目/自定义/用户根，热刷新）+ `dsh-tool-skill`（目录注入 + `skill` 工具 + `/name` 手势） | **已实现（P0-4）**：启动/`skills/change` 刷新用户可调用目录 → 菜单分区 + `/skills` 目录；仍缺来源开关、渐进披露预览与 skill 内参数 | **L1** |
| 子代理 | `.claude/agents/*.md`、`--agents <json>`、Task 工具、并行/后台、**agent teams**（`/list-agents`、`TeammateIdle` hook）、`claude agents` 后台代理视图、每个会话可 `-w` 起独立 git worktree | 内置 `coder`/`explore`/`plan`，`Agent`/`AgentSwarm`，后台自动回传、可回叫、递归保护、secondary model 池、`/btw` 旁路问答 | **已在 base**：`dsh-subagent` + spawn/fork provider + `tool-subagent`（continuable 后台）+ `send_message`/`interrupt_agent`/`list_agents` + 会话投影里的 subagent 目录 | 子代理调用只表现为一张普通工具卡；无列表、无状态、无中断/续跑入口 | **L2** |
| Hooks | **40+ 事件、5 种 handler 类型**（`command`/`http`/`mcp_tool`/`prompt`/`agent`），exit code 2 拦截、JSON 决策 | `[[hooks]]`（event/matcher/command/timeout），stdin JSON，0 放行 / 2 拦截 / fail-open，3 个可拦截事件，插件可声明 | **已装未挂**：`dsh-hooks-claude-code` / `dsh-hooks-codex` 把 Claude Code / Codex 的 hook 配置映射到 dsh 拦截缝（`tools/pre-execute` 等），产出 `hook/invoked`·`hook/result` 事件 | 投影层**已经会渲染 hook 运行/结果行**，但 profile 没有挂桥接插件 → 实际永远是空的 | **L3**（接线即得大半） |
| MCP | `claude mcp` 子命令集（`add` / `add-json` / `add-from-claude-desktop` / `get` / `list` / `login` / `logout` / `remove` / `serve` / `reset-project-choices`）、`.mcp.json` 三作用域、stdio/SSE/HTTP/**WebSocket**、OAuth、待批准服务器、`/mcp`、resources/prompts 消费 | `mcp.json` 两级、stdio/HTTP/SSE、`/mcp-config` AI 原生编辑、`/mcp` 状态、OAuth 登录、命名 `mcp__server__tool` | **已装未挂**：`dsh-mcp-client`（一行一服务器，stdio / streamable-http，工具注册为 `mcp__<server>__<tool>`）；**不支持 MCP resources/prompts** | 无 | **L3**（挂行即得工具；配置 UX 需自建） |
| 插件 / 市场 | `claude plugin` 子命令集（`list`/`install`/`uninstall`/`enable`/`disable`/`update`/`details`/`eval`/`tag`/`validate`/`init`/`prune`）+ `marketplace` 子命令 + `--plugin-dir`/`--plugin-url`；插件可带 commands/agents/skills/hooks/MCP | `kimi.plugin.json` manifest 可带 skills/agents/mcpServers/hooks/commands/systemPrompt；`/plugins` 四 Tab + 信任分级 + marketplace | dsh：`dsh plugin --profile <p> add <pkg>`（转发 pnpm）；`dsh-host-plugin-inventory` 只读投影（web 行）；无 TUI 侧面板 | 无面板；只能命令行装插件并重启 profile | **L3**（可做只读 inventory 面板 + 文档指引） |
| 运行时自扩展 | — | — | `dsh-tool-cordis`：模型可检查活运行时并挂载临时插件（已装未挂） | 无 | **L3** |
| TUI 自身扩展点 | — | — | dsh-TUI 生态 spec（scenes/dialogs/status/shortcuts/renderers/settings-sections）在**宿主**侧，不在内核 | **无**：Orca 没有对外注册面，第三方无法给它加面板/命令/状态槽 | **L4（结构性）** |

### 2.5 会话与工作管理

| 能力 | Claude Code | Kimi Code | 内核现状 | Orca 现状 | 级别 |
| --- | --- | --- | --- | --- | --- |
| 新建/恢复/继续 | `/clear`、`-c/--continue`、`-r/--resume [搜索]`、`--fork-session`、`--session-id`、`--from-pr`、`--teleport`、`-n/--name` | `/new`、`/sessions`、`--continue`、`--session` | `ctx.agents.create/resume`、`sessionQuery` 列表、`session-projection-cache` 检查点 | `/new`、`/resume`（游标列表，含标题/时间/cwd）、`--resume <id>` | **L0/L1**（可以更聪明：搜索、分组） |
| 回退/撤销 | `Esc Esc` / `/rewind`：**checkpointing + 5 动作回滚菜单**（对话与文件）。官方限制：Bash 造成的文件改动、子代理编辑、外部编辑、符号链接路径**不追踪** | `/undo [n]`（prompt/todo/plan 状态；不改代码） | `sessions.fork(source, boundary, childId)`；`session-checkpoint-policy` 保证请求/工具结果可恢复；无"撤销文件改动"能力 | 双击 `Esc` = fork 到上一轮边界（仅对话，不改代码，仅 idle、需 ≥2 轮） | **L1** |
| 后台会话 / 远程 | `--bg` 后台起会话 + `claude attach\|logs\|stop\|rm\|respawn` + `claude agents` 代理视图（`--json` 可脚本化）；`--remote-control`（从 claude.ai 驱动本地会话）；`--cloud`/`--environment` 云端执行；`-w/--worktree` + `--tmux` | 无同名产品面（后台子代理自动回传近似） | `dsh-jobs-local`（进程内后台任务）+ `dsh-webhook`（外部事件起会话）；无"会话级后台/attach"概念 | 无 | **L4**（dsh 侧形态不同，不建议照搬） |
| Fork | `/branch`（分叉对话、保留原会话）、`/fork`（复制成新的后台会话）、`/subtask`（分叉子代理回传）、`--fork-session` | `/fork`（保留历史复制新会话，打印 `--resume` 命令） | `sessions.fork` | 仅作为 rewind 的内部实现；无显式 `/fork` | **L2** |
| 会话间协作 | 同机会话可互相发消息、`@` 提及另一个活会话、`/list-agents` | 无同等 | 无（内核有 `send_message`，但只面向**子代理**） | 无 | **L4** |
| 导出 | `/export`（转录）、`/copy` | `/export-md`、`/export-debug-zip`、`kimi export` | `dsh-session-log-export`（web 行；依赖 `ctx.webServer` 与浏览器下载） | 无（只有探针脚本 `scripts/inspect-session.mjs` 能读日志） | **L2**（TUI 侧读 JSONL 自渲染 Markdown 最省） |
| 转录搜索/导航 | 转录内搜索、`/context` | turn 列表、`/tasks` | `session-query-sqlite`（base 中 `openAt: never`，全文搜索默认关闭）；`session-stats`/`session-turn-outline` 投影在 web 行 | 无搜索；无回合导航 | **L2/L3** |
| 后台任务 | `Ctrl-B` 后台运行、任务面板 | `/tasks`、后台子代理自动回传 | **已在 base**：`dsh-jobs-local` + `tool-jobs`（`job_output`/`job_list`/`job_kill`） | 无面板（模型侧可用工具，人侧看不到） | **L2** |
| 多目录 | `--add-dir`、`/add-dir` | `/add-dir` | 单 workspace 根（`sandbox-policy.workspaceRoot`）；无附加目录概念 | 无 | **L4** |
| 会话级工作区归属 | 项目目录即工作区 | 同 | `workspaceRegistry.attachSession`（Orca 已用，且与 web 侧栏共享） | 已实现并带漂移守卫 | **L0（领先：TUI/web 共享归属）** |

### 2.6 任务与自主性

| 能力 | Claude Code | Kimi Code | 内核现状 | Orca 现状 | 级别 |
| --- | --- | --- | --- | --- | --- |
| 待办清单 | `Ctrl+T` 任务清单；`TaskCreated`/`TaskCompleted` hooks；可用 `--tools` 指定任务工具启用 | `/tasks` 面板 | **已在 base**：`dsh-tool-todo`（`todo_write` 工具，`todo/write` 事件；invariant 只允许回合内写入） | 模型侧可见；人侧 `/todo` 只读 + 编辑指令交给模型（P0-3）；仍缺结构化任务面板 | **L1** |
| Plan mode | `Shift+Tab` 循环 + plan 审批 | `/plan [on\|off]`、`/plan clear` | **已在 base**：`dsh-plan-mode`（`/plan` 命令 + `plan:policy` 段 + `exit_plan_mode` 工具；评审经 `userQuestions`，带 `intent: {kind:'plan-review', approve}`，`detail` = 计划 Markdown） | **已接内核（P0-2）**：委托命令、评审面板（Approve / Keep planning / 反馈）、`Esc` = 插话语义、footer 跟随 `plan/mode`；仍缺「pending（已请求未生效）」展示 | **L1** |
| 持久目标 | 无直接对应（靠 CLAUDE.md/SDK） | `/goal`（status/pause/resume/cancel/replace/next；非交互退出码 0/3/6） | **已在 base**：`dsh-goal` + `goal-round-driver` + `command-goal` + `tool-goal` | 命令镜像可能已可用（内核命令进菜单），但**无目标状态展示**、无 pause/resume 面板、footer 无 goal 槽 | **L2** |
| 工作流 / Ralph | Agent SDK 编排；无同名命令 | `/swarm` | **已在 base**：`dsh-workflow` + `dsh-tool-workflow`、`dsh-tool-ralph`（fresh-agent 迭代，最大 64 轮） | 无进度可视化（模型侧可用） | **L2** |
| 定时/提醒 | 无 | 无（计划任务靠外部） | `dsh-schedule`（after/at/fixed-rate，已装未挂）+ `dsh-webhook` / `dsh-webhook-github` | 无 | **L3**（可选） |
| 模型主动提问 | `AskUserQuestion` 工具 + 面板 | 提问弹窗（单选/多选/自定义） | `dsh-user-questions`（缝）+ **`standard`/`ptc`/`cordis` preset 自带 `tool-ask-user`**（`minimal` 不带） | 面板已实现，模型可发起 | **L0**（README 里「需手动装插件」的说明已过期，2026-09 修正） |
| 完成通知 | 桌面通知 + hooks `Notification` | hooks `Notification(task.completed)` | `hook/invoked`·`hook/result` 事件 + hooks 桥 | 投影可渲染，但无 OS 通知；终端 title/bell/OSC 9 全未使用 | **L2** |

### 2.7 终端交互与视觉

| 能力 | Claude Code | Kimi Code | 内核现状 | Orca 现状 | 级别 |
| --- | --- | --- | --- | --- | --- |
| 状态栏 | `/statusline` + `statusLine` 命令（stdin JSON 快照） | `tui.toml` `[status_line] items` 槽位顺序 + 自定义 `command`（300ms 上限、1s 节流、失败回退） | 无（UI 层职责） | 固定两行页脚：徽标/模型/预设/标题/模式/cwd/git + 提示 + 原始 token 数 | **L2** |
| 主题 | 内置主题 | `/theme`、`/custom-theme` | 无（TUI 层） | `src/tui/theme.ts` token 体系（kimi 色板对齐）+ `NO_COLOR`/256 降级；**无运行时切换** | **L2** |
| 编辑器 | 多行、`/vim`、图片粘贴、`@` 引用、可配置 keybindings、prompt suggestions（`--prompt-suggestions`） | 多行、粘贴图片/视频、`/editor` 配置、可编辑占位符 | 无 | 多行 + 图片粘贴 + `@` 补全已对齐；**无 vim 模式、无外部编辑器接管、无输入建议** | **L1** |
| `!` shell 模式 | `!cmd` 直接执行并把输出带入上下文 | shell 模式（`!` 提示符） | `ctx.shell` 后端存在（bash/pwsh），但直连是 UI 行为 | 无 | **L2** |
| 转录内操作 | `/export`、`/copy [N]`、`Ctrl+O` 转录查看器（含每个 assistant 消息的模型与折叠的 MCP 调用）、`Ctrl+R` 历史搜索、`[` 把对话灌进终端 scrollback 供原生搜索、`/recap` | `/copy`、`Ctrl-S` 注入、`Ctrl-O` 展开 | 无 | 全屏滚轮滚动 + 鼠标选区复制已有；**无搜索、无 `/copy`、无 `/export`、无转录查看器** | **L1** |
| 通知 | 系统通知 | hooks 通知 | 无 | 无（无 OSC 9 / OSC 777 / BEL / title 更新） | **L2** |
| i18n | 有 | 有（中英双语文档 + locale） | `dsh-client-locale`（web 侧） | **UI 文案硬编码中文**，无 locale 文件 | **L2** |
| 窄终端适配 | 有 | 有 | — | README 自述未完成（< 40 列） | **L2** |
| 无障碍/降级 | `--ax-screen-reader`（扁平文本、去装饰边框与动画） | 对比度 guard 测试 | — | `NO_COLOR` 已做；无对比度守卫测试、无屏幕阅读器模式 | **L1** |

### 2.8 非交互与集成面

| 能力 | Claude Code | Kimi Code | 内核现状 | Orca 现状 | 级别 |
| --- | --- | --- | --- | --- | --- |
| 无交互单次执行 | `-p` + `--output-format text\|json\|stream-json` + `--input-format stream-json` + `--json-schema` + `--max-budget-usd` + `--include-partial-messages`/`--include-hook-events`（本机 2.1.260 **无 `--max-turns`**） | `kimi -p`、`--output-format stream-json` | `dsh --profile headless "job"`（随包模板） | Orca 是纯 TUI；headless 走 dsh 自己的 profile（不算 Orca 的能力） | **N/A（产品分工）** |
| SDK | TypeScript / Python SDK，含 streaming、hooks、subagents、permission 回调 | klient / kap-server / protocol | `dsh --profile sdk` / `sdk-minimal`（JSON-RPC）、`dsh-sdk-protocol` | 无（Orca 既不是 SDK 也不是 server） | **N/A** |
| ACP | — | `kimi acp` | `dsh --profile acp`（完整 ACP 服务器） | 明确放弃 ACP（历史 Rust 客户端已废弃） | **N/A（有意）** |
| Web 端 | Claude Code on the web | `kimi web`（本地 REST/WS + 浏览器 UI） | `dsh web`（完整 Web 应用，Orca 已与其共享工作区账本与模型记录） | 无自有 web 端，但与 web 端**数据打通**（工作区归属、`model/selection`） | **L0（差异化优势）** |
| IDE 集成 | VS Code / JetBrains 扩展、`/ide`、`--ide` | VS Code 插件（壳） | `dsh-host-open-in-app`（web 行） | 无 | **L4** |
| CI / GitHub | GitHub Actions、GitLab CI/CD、`/install-github-app`、`claude ultrareview`（云端多智能体评审）、`/review`、`/security-review` | 无同等产品面 | `dsh-webhook` + `dsh-webhook-github`（可选 overlay） | 无 | **L3** |
| 消息平台 | Slack? / Desktop / Chrome 扩展（`--chrome`）/ mobile | — | 无 | 无 | **L4** |

### 2.9 运维与企业

| 能力 | Claude Code | Kimi Code | 内核现状 | Orca 现状 | 级别 |
| --- | --- | --- | --- | --- | --- |
| 登录/凭据 | `claude auth`、`/login`（订阅/API key）、`setup-token`、企业 `gateway` | `/login`（OAuth device-code 或 API key）、`/logout`、`/provider` | `dsh-credentials-local`（env → `$DSH_HOME/.credentials.yaml` → `.env`）+ settings 文档；`dsh-llm-deepseek`/`llm-pi-ai` 多 provider | 无登录/凭据 UI；无 provider 配置面板（依赖 settings.yaml / 环境变量） | **L2/L4**（OAuth 面内核没有） |
| 设置面板 | `/config`（分页设置） | `/settings`、`/experiments`、`/update-config` | `dsh-settings-file`（`$DSH_HOME/settings.yaml` 热重载）+ `dsh-api-settings-controller`（web） | `~/.dsh/orca-settings.json` 只存 TUI 自己的开关；无设置面板 | **L2** |
| 自检 | `claude doctor` + `/doctor`（可修复）；`--safe-mode`（关掉所有定制化）、`--bare`（最小模式） | `kimi doctor` | 无 doctor 命令；组合树可用 `dsh --dump-config` 查看 | README 自述 `--doctor` 未完成 | **L2**（roadmap 已有） |
| 更新 | `claude update\|upgrade`、`claude install stable\|latest\|<version>`、`respawn --all`（让后台会话升到当前版本） | `kimi upgrade` | `dsh` 由 npm 管理 | `/update` + `orca update` 已实现 | **L0**（可补：插件行/内核版本一并体检） |
| 遥测/隐私 | OTel metrics/logs、`monitoring-usage`/`analytics`/`data-usage` 文档、企业 `gateway` | telemetry 包 | `dsh-session-telemetry-otel` 在 base（`FEEDBACK_ONLY` 模式、`DSH_TELEMETRY_DISABLED` 环境变量退出、仅反馈后释放日志前缀） | 无展示；用户不知道何时会上报、如何关闭 | **L2/L3** |
| 反馈 | `/bug` 等 | `/feedback`、`/export-debug-zip` | `dsh-command-feedback` 在 base（`/feedback`）+ `dsh-message-feedback`（web 行，消息级评分） | `/feedback` 可能已随命令镜像可用；**无消息级点赞/点踩 UI** | **L1/L3** |
| 企业托管策略 | `managed-settings` 强制下发 + `--setting-sources user,project,local` 控制来源 | 无同等 | settings 分层 + `sandbox-policy` 部署默认；无"托管强制"文档 | 无 | **L4** |
| 成本 | `/cost`、预算上限 | `/usage` 含配额 | `dsh-token-meter` 估算 + `dsh-usage`（本机目录） | 仅原始 token 统计 | **L2** |

### 2.10 工程与架构

| 维度 | Claude Code | Kimi Code | Orca 现状 | 级别 |
| --- | --- | --- | --- | --- |
| 模块化 | 独立包 + 扩展生态 | `controllers/` + `components/` + `commands/`，组件不得直接碰 SDK | 单体 `src/app.ts`（3502 行，命令/审批/会话/输入/附件/鼠标/更新全在同一文件） | **L2（结构性）** |
| 对外扩展点 | plugins + marketplace | plugins + marketplace + 插件可带 hooks/MCP/skills | 无（dsh-TUI 生态 spec 的宿主面未实现） | **L4（结构性）** |
| 测试 | 官方一致性测试 | vitest 全套 + 主题守卫 + PR 检查 | 25 条断言 + 假内核 harness + 真 PTY 探针（**探针质量高于多数同类项目**） | **L0/L1（单测面偏窄）** |
| CI | 全套 | 全套 + 静态守卫 | ubuntu + windows 矩阵跑 build/test/dev；PTY 探针只在本地 | **L1** |
| 发布 | 多通道自动更新 | 单二进制 + npm + Nix | npm 全局包；`orca` 只是启动器（等于 `dsh --profile orca`） | **L1** |
| 文档 | 完备 | VitePress 双语文档站 | README/AGENTS.md/ADR/调研齐全，**但无用户级文档站** | **L1** |

---

## 3. 结构性差距（深水区）

### 3.1 没有"往内核之外长东西"的机制

Orca 的所有 UI 能力都写在 `app.ts` 的闭包里。对比：

- Kimi：`src/tui/commands/`（声明/解析/排序）、`src/tui/controllers/`（会话事件路由、流式 UI、回放）、`src/tui/components/`（chrome/dialogs/editor/media/messages/panes）——**新功能有默认落点**。
- Claude Code：命令、skills、agents、hooks、MCP、插件全部由**文件/清单**驱动的扩展面承载。
- dsh-TUI 生态 spec：宿主提供 scenes/dialogs/status/shortcuts/renderers/settings-sections 注册面，第三方插件可挂。

Orca 目前的"扩展"只有一条：**内核命令镜像**（`ctx.commands`）。这意味着每个新面板都要改核心文件，无法被外部插件复用，也无法被用户按需开关。

**建议**：M7 做一次"壳层拆分 + 最小注册面"：把 `app.ts` 拆成 `controllers/`（事件路由、会话生命周期、审批、命令分发）与 `components/`（frame 构建、picker、审批面板、状态栏槽），并暴露一个 Orca 自己的 `ctx.orca`（或 Cordis 事件）注册表，至少支持：命令、状态栏槽、设置分区、picker 页。**注意**：这一步必须在功能开发之前或同步进行，否则越晚拆成本越高。

### 3.2 会话/任务的"人侧可见性"缺失

内核把"agent 能做的"做齐了（子代理、后台任务、目标、工作流、钩子），但 Orca 只呈现**主会话的线性转录**。Kimi/Claude Code 都把"并行工作"做成了可观察、可介入的 UI（任务面板、子代理块、后台任务列表、`Ctrl-S` 注入）。缺这一层，用户对 agent 的自主行为**既看不见也管不住**，这是"像 Claude Code"最核心的体验差。

**建议**：把 `ctx.subagents`（列表/续跑/中断）、`ctx.jobs`（列表/输出/取消）、`goal` 投影（状态/pending）、`workflow/*` 事件做成一个统一的**侧栏/面板**，并在转录区给子代理单独的行类型（而不是一张工具卡）。

### 3.3 真源与影子实现的错位

Orca 曾在三处**影子实现**内核已有的能力（**2026-09-11 已全部改为委托内核**；下表保留作反面教材与回归依据）：

| 影子 | 内核真源 | 后果 |
| --- | --- | --- |
| `/plan`（本地布尔量） | `dsh-plan-mode`（log-only `plan/mode` 状态 + `exit_plan_mode` 评审） | 内核的评审闭环用不上；`/plan` 状态不落日志、resume/fork 会丢；用户拿不到"计划已提交待批准"的状态 |
| `/todo`（改内存投影） | `dsh-tool-todo` 的 `todo/write` 事件（且内核 invariant 要求它只能出现在**开启的回合内**） | 用户编辑**不会被模型看到**，下一轮模型写入即覆盖；而"直接 append 回去"在回合外会被内核拒绝 —— 所以只能改成"只读展示 + 让模型改" |
| `/permission`（只读展示） | `dsh-permission-presets` 的 `/permission` 命令 | 丢掉了档位切换能力，而这正是 Claude Code/Kimi 权限 UX 的入口 |

**结论**：三处已改为「本地只做呈现 / 委托，真源在内核」——`/plan` → `ctx.commands.execute('/plan …')` + `plan/mode` 投影；`/todo` → 只读 + 把指令作为消息交给模型（内核 invariant 只允许回合内写 `todo/write`）；`/permission` → 参数委托内核档位命令。这条原则已写进 `AGENTS.md`：**不得再留影子实现**。

### 3.4 两个"形态"差异（比功能条数更致命）

**① 命令面已经不是一张扁平列表。** Claude Code 的 slash 命令页已整页并入 Skills：当前约 150 个顶层命令分成三种物种 —— **内置命令**（固定代码逻辑）、**捆绑 skill**（本质是一段提示词，如 `/code-review`、`/debug`、`/verify`、`/batch`）、**捆绑 workflow**（运行时执行的编排脚本，如 `/deep-research`），再加**插件命名空间命令**（`/plugin:skill`）与 **MCP prompts 转成的命令**。匹配规则也讲究（忽略 `: _ -` 的子串高亮、隐藏命令、部分命令回合中可执行、最多 6 个 skill 串联）。Orca 现在是一张 17 项的静态表 + 内核命令 + **用户 Markdown 命令**（P0-5）+ **skill 目录**（P0-4）拼接，并已分区显示（P0-6）；仍**没有**：命名空间化的插件命令、隐藏/高级命令分层、`!`bash与 `@`file 内联执行、参数补全。

**② 并行工作是一个独立轴，不是几个工具。** Claude Code 把"同时开很多活"做成了完整体系：后台会话（`--bg` + `attach`/`logs`/`stop`/`rm`/`respawn` + `claude agents` 代理视图）、每会话独立 git worktree（`-w`）、后台子代理（默认后台、`Ctrl+B`、`Ctrl+X Ctrl+K` 全停）、`/subtask` 分叉子代理、`/fork` 整会话后台副本、`/batch` 一条改造拆成 5–30 个 worktree+PR、**agent teams**（实验开关 + 共享任务列表 + `/list-agents`）、**动态 workflows**（JS 编排脚本 + 进度视图）。Orca 目前是"一次一个会话、一条时间线"，内核虽有 subagent/jobs/workflow，但没有对应的**人侧工作台**。

> 结论：把这两个轴当成两个独立里程碑（命令面扩展性 / 并行工作台），不要拆成零散功能点塞进现有菜单。

---

## 4. 优先级路线图（建议）

> 估时按"熟练贡献者 + 单人"计；每项都给出验证方式（仓库既有工具即可覆盖）。

### P0 — 入口层（先让"看得见的入口"对齐）

| # | 事项 | 做法（落点） | 依赖 | 估时 | 验证 |
| --- | --- | --- | --- | --- | --- |
| P0-1 ✅ | `/permission` 改为档位切换（**2026-09-11 已实现**：带参委托内核 `dsh-permission-presets`，无参 = 本地策略解释 + 内核档位报告） | 不再影子遮蔽：菜单里让内核 `/permission` 优先；本地 `/permission` 降级为"展示 + 转发内核命令"；footer 显示档位 | `dsh-permission-presets`（已在 base） | S | `probe-pty --state` 断档位记录；假内核补断言 |
| P0-2 ✅ | `/plan` 接内核 plan mode（**2026-09-11 已实现**：委托命令 + 评审面板 + `Esc` 插话语义 + `plan/mode` 投影进 footer） | 删除本地布尔量；改为调用内核命令 + 渲染 `exit_plan_mode` 的 review。**接缝已知**：评审走 `ctx.userQuestions`，请求带 `intent: { kind: 'plan-review', approve }`，`detail` 就是计划 Markdown，`approve` 是批准选项的 label；Orca 现有 question picker 只需识别该 intent → 用 markdown 渲染 `detail` + 选项（Approve / Keep planning，后者带自由文本）。footer 显示 active/pending（`plan` 投影） | `dsh-plan-mode` + `dsh-user-questions`（均在 base） | M | 真机跑一轮 plan → 评审 → approve；日志含 `plan/mode` |
| P0-3 ✅ | `/todo` 与真源对齐（**2026-09-11 已实现**：只读展示 + 编辑作为指令交给模型；本地不再改投影） | **先纠正 §3.3 的预期**：内核 invariant 拒绝"回合外写入的 `todo/write`"，所以 UI 侧直接编辑列表并 append 是行不通的。正确做法：`/todo` 变成**只读展示**（读 `todos` 投影），并提供显式动作 `/todo set …` → 作为一条普通 prompt 交给模型改（"请把待办替换为：…"），由模型调用 `todo_write` | `dsh-tool-todo` | S | 假内核断言事件被 append；`inspect-session` 看 `todo/write` |
| P0-4 ✅ | Skills 进菜单（**2026-09-11 已实现**：`ctx.skills` 目录 → 菜单「Skills」分区 + `/skills`；只列 `userInvocable`，调用走内核 `/name` 手势） | 软探测 `ctx.skills`（**API：`list()`/`snapshot()` 得到按名排序的合并目录，条目带 `userInvocable`/`modelInvocable` 与 provider 来源；`skills/change` 事件可实时刷新**）→ 把 `userInvocable` 的 skill 做成菜单项；选中后按"用户消息里带 `/name`"路径提交，复用 `dsh-tool-skill` 的 gesture。缺服务时整块消失 | `dsh-skill`（base） | M | 真机放一个 skill 进 `.agents/skills`，菜单出现并调用成功 |
| P0-5 ✅ | 自定义命令（Markdown）（**2026-09-11 已实现**：`src/custom-commands.ts` + 项目/用户两级根 + `$ARGUMENTS` + 命名空间；单测 `scripts/commands.test.ts`） | `~/.dsh/orca/commands/*.md` + 项目 `.orca/commands/*.md`：frontmatter `description`/`argument-hint`/`allowed-tools`(?)、`$ARGUMENTS` 展开、子目录命名空间；命中即作为普通 prompt 提交（保持"命令=提示词模板"的语义） | 无（纯 TUI） | M | 单测 + 假内核；`--features` 探针 |
| P0-6 ✅ | 命令菜单分区与观感（**2026-09-11 已实现**：四段固定分区、子序列模糊、`input.hint`、忙时置灰、完整命令名回车即分发） | **承认"命令分三种物种"**：本地内置 / 内核命令 / 用户命令与 skill 分节显示；子序列模糊匹配 + 别名参与；展示 `input.hint` 作参数提示；隐藏/高级命令只在全名匹配时出现；忙时置灰 + 说明 | 无 | S–M | 渲染回归断言 |
| P0-7 ✅ | ~~补挂 `dsh-tool-ask-user`~~ **结论：不用加行**（2026-09-11 核对）——`standard`/`ptc`/`cordis` preset 的 agent-plane 组合里已经带了这个工具，再加一行会造成重复注册；真正过期的是 README 的安装说明，已改 | — | S | README 修正 + preset 文件核对 |

### P1 — 任务、权限与会话管理

| # | 事项 | 做法 | 依赖 | 估时 | 验证 |
| --- | --- | --- | --- | --- | --- |
| P1-1 ✅ | 审批规则层（**2026-09-11 已实现**：`src/permission-rules.ts` 纯函数层 + `/perms` 命令） | 落点与预期一致，但拆成两级文件：用户 `$DSH_HOME/orca/permissions.json`（`--user`）+ 项目 `<cwd>/.orca/permissions.json`（默认，可提交）；条目 `{decision: allow\|deny\|ask, scope, pattern: 工具名(参数模式), reason}`；命中 allow/deny 直接替内核应答 `allowed-once`/`rejected`，未命中或 `ask` 才弹面板；会话级放行 = scope: session 的内存条目（面板按 `2`，或 `--session`）。判定恒定 `deny > ask > allow`，同档比 scope（builtin < user < project < session）；`allow *` 明确拒绝（整机放行走 `/yolo`）。坏文件**报错而不是静默忽略** | 内核无规则能力（L4），纯 TUI 实现 | M | ✅ 单测 `scripts/permissions.test.ts`（38 条全仓测试的一部分）+ 假内核 phase13 断言；`pnpm mutation` 8 条变异全红 |
| P1-2 ✅ | 审批面板增强（**2026-09-11 已实现**） | 面板四项：`1` 放行单次 / `2` 本会话放行该工具 / `3` 总是放行**窄规则**（如 `bash(npm ci:*)`，写入项目规则文件）/ `4`·`Esc` 拒绝；`Ctrl-E` 展开完整参数（一行预览不足以批准一次写入）；只读工具默认免问（8 条内置 allow，`/perms reads off` 关，显式 deny 仍压过它）；命中 `ask` 规则时**面板内**写明「命中规则：…（来源）」，解释它为何压过了 allow | P1-1 | S–M | ✅ 假内核 phase13 断言（Ctrl-E 展开、编号直选、免问开关、面板文案）；`pnpm mutation` 覆盖 |
| P1-3 | 并行工作台（**独立里程碑**） | 软探测 `ctx.subagents`（**可用 API：列直接子代理与整棵后代树，含 mode/activity/lineage；对续跑子代理 `sendMessage`（Queue/Steer 二选）；`interrupt` 运行中的后代**）+ `ctx.jobs` + workflow 事件，合成一个"工作台"面板：运行中/已完成的子代理与后台任务、可中断、可续跑、可跳看输出；转录里给子代理单独行类型而不是一张工具卡 | `dsh-subagent` / `tool-subagent-control` / `dsh-jobs-local` / `dsh-workflow`（base） | L | 真机：让模型开一个后台子代理 + 一个后台命令，面板可见并能中断/续跑 |
| P1-4 | 后台任务面板 | `/jobs` 面板：`ctx.jobs.list/get` 快照、`read` 增量输出、`kill` 取消、`wait` 阻塞等待 | `dsh-jobs-local` + `tool-jobs`（base） | M | 真机跑一个长命令后台化 |
| P1-5 | 会话导出与复制 | `/export` 读会话 JSONL（复用 `scripts/session-log.mjs` 的 zstd 多帧读取）生成 Markdown/JSON；`/copy` 复制上一条回复（OSC 52 或本地） | 无（自研；避开 web 依赖的 `session-log-export`） | M | 单测（读取器已有测试基础）+ 真机 |
| P1-6 | 会话搜索与导航 | resume picker 支持标题/内容搜索（把 `session-query-sqlite` 的 `openAt` 改 `first-search`）+ 回合列表跳转（`session-turn-outline` 投影） | L3（加行）/ L2 | M–L | `--state` 探针 + 真机 |
| P1-7 | Goal / Workflow 状态 | `/goal` 状态行 + pause/resume；workflow 运行时显示轮次/步骤 | `dsh-goal` / `dsh-workflow`（base） | M | 真机 + 事件投影单测 |
| P1-8 | `--doctor` | 打印：dsh 版本、软探测接缝在位情况、profile 行清单（对比 expectations）、工作区漂移、附件/剪贴板能力、node/终端能力（Kitty/鼠标/OSC52） | 无 | M | 快照测试 + CI |
| P1-9 | Hooks 接线 | profile 加 `dsh-hooks-claude-code` 行（`configPath` 默认指向 `.claude/settings.json`，可配）；`/hooks` 只读面板展示事件/最近结果；首次发现项目 hooks 时提示"将执行本地脚本" | L3（加行） | M | `--state` 探针看 `hook/invoked` |
| P1-10 | MCP 接线 | profile 加 `dsh-mcp-client` 行（默认零服务器）；`/mcp` 展示连接与工具；`/mcp-config` 走"AI 原生编辑"：把配置文件路径给模型，由模型改 YAML/JSON 并提示重启 | L3 | M–L | 真机接一个 stdio server |

### P2 — 终端打磨与扩展点

| # | 事项 | 做法 | 估时 |
| --- | --- | --- | --- |
| P2-1 | 状态栏槽位 | items 顺序 + 自定义 `command`（stdin JSON 快照、300ms 上限、1s 节流、失败回退）；槽位含 mode/goal/model/git/context%/session | M |
| P2-2 | 通知 | 回合结束/需要审批时 OSC 9 / OSC 777 / BEL；可选"仅终端失焦时"；写入会话日志便于审计 | S–M |
| P2-3 | 主题与设置面板 | `/theme`（内置暗/亮 + 用户主题文件，沿用 theme token）、`/settings`（Orca 自身 + 只读展示 `$DSH_HOME/settings.yaml` 关键段） | M |
| P2-4 | 编辑器增强 | vim 模式（可选）、`!` shell 模式（子进程执行，输出以显式动作带入上下文）、`Ctrl+R` 转录搜索、外部编辑器接管 | M–L |
| P2-5 | i18n | 文案抽取成 locale 文件（zh 默认 + en），跟随 `LANG`/`ORCA_LOCALE` | M |
| P2-6 | 壳层拆分 + 扩展点 | `controllers/` + `components/` + Orca 注册面（命令/状态槽/设置分区/picker） | L |
| P2-7 | 窄终端与对比度 | < 40 列布局取舍；对比度守卫测试（对齐 kimi 的 CI guard 思路） | S–M |
| P2-8 | 用量与成本 | 用 `ctx.tokenMeter` 的 `contextPressure` 把 footer 换成百分比 + 阈值色，接压缩预警/缓存过期提示 | S |
| P2-9 | 多会话并行（可选） | 内核允许一个进程里多个 agent；Orca 目前一次一个。可做会话切换器 + 并行会话列表（对齐 Claude Code 的后台会话思路，但形态是"进程内多会话"而非 attach 子进程） | L |

---

## 5. 明确不做 / 不要照抄

### 5.1 边界（Orca 的架构纪律）

- **不 fork/补丁内核**、不引入私有 `_meta`、不注册进 `KNOWN_SESSION_EVENT_TYPES`（0.1.5 起已死）。
- **不复活 ACP / 子进程模式**：Orca 的定位是 in-process TUI；headless/SDK/ACP 由 dsh 自己的 profile 承担。
- **不实现自己的沙箱**：沙箱与审批执行归内核（`dsh-sandbox-*` / `dsh-user-approval`）；Orca 只做规则层与呈现。
- **不自造会话事件类型**：只在语义完全一致时复用内核已知 log-only 类型（现有唯一：`model/selection`）。
- **不在 TUI 里存会话真相**：新增面板必须是 `session/event` 的可重建投影（含子代理、jobs、goal）。
- **不把密钥写进 Orca 配置**：凭据走 `dsh-credentials-local`；Orca 只读"是否存在"。

### 5.2 Claude Code 自己的坑（不要整段照抄）

对标时容易"看到什么抄什么"，但 Claude Code 官方文档明确记录了这些**它刻意不保证**的地方，抄过来只会复制问题：

| Claude Code 的做法 | 官方口径 | 对 Orca 的启示 |
| --- | --- | --- |
| 只读 `CLAUDE.md`，**不读 `AGENTS.md`** | 文档写明；变通是 `@AGENTS.md` 或软链 | dsh 的 `agent-instructions` **两个都读**，这是 Orca 的优势，别为了"对齐"砍掉 |
| 记忆是"上下文"不是"强制" | "instructions shape behavior but are not a hard enforcement layer" | 把"必须发生的事"放在 hooks / 权限规则 / 内核策略里，别指望指令文件 |
| checkpointing 只覆盖一部分改动 | 不覆盖 Bash 改的文件、子代理编辑、外部编辑、符号链接路径；"不是版本控制替代品" | 本地规则/回退功能要把"不覆盖什么"写进 UI，不能承诺"完整回滚" |
| 权限规则有盲区 | `Bash(rm *)` 挡不住 `sh -c`；参数规则不能匹配工具主内容字段；deny 只覆盖内置文件工具 | 本地规则层的 pattern 必须声明匹配范围与已知盲区，并在命中 deny 时仍保留内核沙箱为兜底 |
| 命令面越来越大比例是"提示词"而非代码 | 捆绑 skill = 一段提示词，行为受模型判断影响 | 少抄"把功能做成提示词"这条捷径；Orca 的内核侧能力（jobs/goal/plan）都是真状态 |
| 系统提示词不公开、只可替换/追加 | 官方设置文档明说 | 别设计"编辑系统提示词"的面板；走 preset（内核已有） |
| 大量能力在实验开关/平台门后 | agent teams / computer use / Dispatch / artifacts 各有条件 | 复盘时区分"旗舰能力"与"默认可用能力"，别把实验品当基线 |
| 版本化删除而不留兼容层 | `/vim`、`/output-style`、`/pr-comments`、`/agents` 向导都被移除或搬家 | Orca 的 `/plan` `/todo` `/permission` 改接内核时，要给出**迁移提示**而不是静默改行为 |

---

## 6. 结论性判断

| 问题 | 判断 |
| --- | --- |
| Orca 现在是"像 Claude Code/Kimi Code 的产品"吗？ | **主链路像，产品面不像**：单会话终端体验已经同级（流式、diff、审批、多行、选区复制、模型路由、工作区归属），但扩展生态、任务管理、状态可见性三层落后一整个版本。 |
| 最大收益的一次投入是什么？ | **把内核已有的能力接出来**（skills 菜单、plan mode 闭环、permission 档位、子代理/jobs 面板、hooks/MCP 接线）。这些是"接线 + 呈现"，不是"发明"。|
| 最难的一件事？ | **壳层拆分与扩展点**（§3.1）。它不产出即时功能，但决定 Orca 能否从"一个人的 TUI"变成"有生态的 TUI"。建议在 P1 中期同步启动，而不是等 P2。 |
| 有没有该坚持的差异化？ | 有：① **in-process 零内核改动**（无需守护子进程、无协议损耗）；② **TUI ↔ Web 数据打通**（工作区归属、模型选型记录）；③ **探针驱动的验证纪律**（真 PTY + 会话日志取证 + 变异验证），这三条是同类的多数 TUI 没有的。 |

---

## 7. 附录

### 7.1 内核能力台账（dsh 0.1.5-rc.1/rc.2，按「是否已在 Orca profile 生效」分组）

**A. 已生效（`dsh-base` / Orca patch 行）**

| 能力 | 包 |
| --- | --- |
| 会话与持久化 | `dsh-session`、`dsh-session-persistence-jsonl`、`dsh-session-log-deepseek`、`dsh-session-checkpoint-policy`、`dsh-session-projection`(+`-cache`)、`dsh-session-query-sqlite`（`openAt: never`，全文搜索默认关）、`dsh-session-title`(+`-first-prompt-llm`) |
| 附件 | `dsh-attachment-local`（**注意：Orca profile 未挂 `dsh-file-reference`/`-local`**，`@` 补全走 Orca 自己的本地实现） |
| Agent 与提示词 | `dsh-agent`、`dsh-agent-loop`、`dsh-agent-instructions`（AGENTS.md/CLAUDE.md）、`dsh-system-prompt`、`dsh-agent-presets`（Orca 插入）、`dsh-persona` |
| 工具 | `dsh-tools`、`dsh-tool-fs`、`dsh-tool-fs-search`、`dsh-tool-bash`/`dsh-tool-pwsh`、`dsh-tool-str-replace-editor`、`dsh-tool-todo`、`dsh-tool-goal`、`dsh-tool-workflow`、`dsh-tool-ralph`、`dsh-tool-web`、`dsh-tool-jobs`、`dsh-tool-subagent`、`dsh-tool-subagent-control`(+`list-agents`)、`dsh-tool-call-timeout-policy` |
| 技能 | `dsh-skill`、`dsh-skill-filesystem`、`dsh-tool-skill`（+ `dsh-skill-badge` 默认关） |
| 命令 | `dsh-commands`、`dsh-command-compact`、`dsh-command-feedback`、`dsh-command-goal` |
| 计划/目标/编排 | `dsh-plan-mode`、`dsh-goal`、`dsh-goal-round-driver`、`dsh-subagent`(+spawn/fork provider)、`dsh-workflow`(+`-worker-thread`)、`dsh-jobs`(+`-local`)、`dsh-compaction`(+`-basic`、`-tool-result-pruner`) |
| 安全 | `dsh-sandbox`(+`-local`、`-policy`、`-windows-acl`)、`dsh-bash-sandbox`、`dsh-pwsh-sandbox`、`dsh-fs-sandbox`、`dsh-user-approval`、`dsh-permission-presets` |
| 计量/遥测 | `dsh-token-meter`、`dsh-session-telemetry-otel`、`dsh-plugin-package-inventory-deepseek` |
| 其它 | `dsh-spill`(+`-local`、`-policy`)、`dsh-repeat-tool-reminder`、`dsh-time-context`、`dsh-storage*`、`dsh-typert*`、`dsh-workspace`（Orca 插入） |

**B. 已安装但未挂载（Orca 可直接加行/加包）**

| 包 | 用途 | 备注 |
| --- | --- | --- |
| `dsh-hooks-claude-code` / `dsh-hooks-codex` / `dsh-hook-protocol` | Claude Code / Codex hooks 桥 | 需要 `configPath` 指向用户的 hooks 配置 |
| `dsh-mcp-client` | MCP 客户端 | 一行一服务器；不支持 resources/prompts |
| `dsh-tool-ask-user` | **模型主动提问工具** | **缺它模型就不能 `ask_user_question`**；`ctx.userQuestions` 缝已在 base，Orca 的面板已实现，只差这一行 |
| `dsh-terminal` + `dsh-terminal-bash` + `dsh-tool-bash-persistent` / `dsh-tool-pwsh-persistent` | 持久终端会话工具 | 状态跨工具调用保留 |
| `dsh-file-reference-local` | 内核级 `@file` 引用 | 当前 Orca 用本地补全替代 |
| `dsh-schedule` | 会话内定时提醒 | 可选 overlay |
| `dsh-webhook` + `dsh-webhook-github` | GitHub 事件 → 新会话 | 可选 overlay |
| `dsh-session-log-export` | `/export` + 浏览器下载 | 依赖 `ctx.webServer`，TUI 不宜直接用 |
| `dsh-session-stats` / `dsh-session-turn-outline` | 会话统计与回合大纲投影 | web 行；TUI 可加行复用 |
| `dsh-message-feedback` | 消息级点赞/点踩（log-only） | web 行；TUI 可加行做快捷键评分 |
| `dsh-tool-cordis` / `dsh-tool-present` / `dsh-agent-tool-presentation` | 运行时自扩展 / 交付物声明 / 工具呈现 | 按需 |

> **复现命令**：`dsh --profile orca --dump-config` 可直接列出上面 A 组——本文 A/B 分组即据此核对，不是推测。**注意 preset 的 agent-plane 行不在 `--dump-config` 里**（它在 `dsh-agent-presets/presets/<name>/agent.cordis.yml`），所以「提问工具是否可用」这类问题要看 preset 文件而不是 host 行清单。

**C. 内核确实没有（需上游或 TUI 影子）**

| 缺口 | 影响 | Orca 影子方案 |
| --- | --- | --- |
| 审批的会话级/持久规则（只有 `allowed-once`） | 长会话反复弹窗；无法表达"只读免问""永远允许 npm test" | 本地规则层（P1-1） |
| MCP 运行时配置面（一行一服务器） | 加服务器要改 YAML + 重启；无 OAuth 登录 UX | `/mcp-config` 式"让模型改配置 + 提示重启" |
| 内核命令收附件（需要 staged receipt） | `/plan` 带图等能力用不了 | 附件改走普通 prompt（现状） |
| 附加目录 / 多 workspace | 跨目录任务 | 不做（记为上游缺口） |
| 托管/企业强制策略、OAuth 登录 | 企业部署与订阅登录 | 不做（记为上游缺口） |
| 会话级"撤销文件改动" | 与 Claude Code `/rewind` 的差距 | 不做（内核只有对话级 fork） |

### 7.2 来源

- 本仓库：`README.md`、`AGENTS.md`、`docs/research/*.md`、`src/**`、`cordis.patch.yml`、`scripts/**`。
- 内核：本机 `@deepseek-ai/dsh` 安装树（盘点时 0.1.5-rc.1，复核时 0.1.5-rc.2）：各 `dsh-*` 包 README、`dsh-base` / `dsh-web-app` 的 `cordis.patch.yml`、`dsh-agent-presets/presets/*/agent.cordis.yml`。
- Kimi Code：`docs/research/kimi-code-research.md` 与其引用链接（MoonshotAI/kimi-code 公开文档）。
- Claude Code：`docs.claude.com/en/docs/claude-code/*`（2026-09-10 抓取：overview / cli-reference / commands→skills / skills / memory / settings / permissions / sandboxing / hooks / mcp / plugins(-reference) / sub-agents / agent-teams / workflows / worktrees / checkpointing / interactive-mode / statusline / output-styles / headless / costs / monitoring-usage / managed-settings / iam / github-actions / ide-integrations / desktop / claude-code-on-the-web / mobile / chrome / sdk-overview 等），加 `CHANGELOG.md` 与**本机 `claude` 2.1.260 的一手 `--help` 输出**（`claude --help` / `claude plugin|mcp|agents|doctor --help`）。

### 7.3 如何使用这份文档

1. **先看 §3.3**：三处影子实现是最该立刻修的"认知错位"。
2. **再按 §4 的 P0 逐项做**：每项都能独立验证、独立提交，且不触碰内核。
3. **P1 中期同步启动 §3.1 的壳层拆分**：越晚成本越高。
4. 每次改动后回来更新 §2 矩阵的「Orca 现状」列与级别，保持本文是**活的对照表**，而不是一次性报告。

> **变更记录**：2026-09-11 完成 P0-1 / P0-2 / P0-3（三处影子实现改为委托内核，`exit_plan_mode` 评审面板落地），并修正 P0-7 的结论（preset 已自带提问工具，README 说明过期）。同日完成 P0-4 / P0-5 / P0-6（Skills 进菜单 + `/skills`、自定义 Markdown 命令、菜单分区/子序列模糊/`input.hint`/忙时置灰，并修掉「完整命令名永远无法回车分发」的菜单缺陷）。对应改动：`src/app.ts`、`src/adapter/channel.ts`、`src/custom-commands.ts`（新）、`src/tui/picker.ts`（分节渲染）、`src/kernel/types.ts`（skills 接缝镜像 + `input.hint`）、`scripts/dev.ts`（phase3/phase4 断言 + 变异验证）、`scripts/commands.test.ts`（新）、`scripts/probe-pty.mjs`（真机步骤）、`README.md` / `AGENTS.md`。

### 7.4 证据复现清单（想自己核对时跑这些）

```sh
# 1) 本 profile 实际挂载了哪些内核行（本文 A/B 分组的口径）
dsh --profile orca --dump-config | grep "name: '@deepseek-ai"

# 2) 内核装了什么（含"已装未挂"的包）
ls "$(dirname "$(readlink -f "$(command -v dsh)")")/../node_modules/@deepseek-ai" | sort
#   或直接看任意包的说明，例如：
#   node -e "console.log(require('@deepseek-ai/dsh-plan-mode/package.json').version)"

# 3) Orca 自己的主链路是否健康（零 API 调用）
pnpm build && pnpm test && pnpm dev
pnpm mutation   # 审批规则层的变异验证：把实现逐条改坏，对应断言必须变红（跑完/被杀都会还原源码）
node scripts/probe-pty.mjs --state

# 4) 会话日志取证（看 plan/mode、todo/write、model/selection、hook/* 是否落盘）
node scripts/inspect-session.mjs <session-id>
```

> 提示：`--dump-config` 是只读的；不要用探针去写用户真实的工作区账本或 `settings.yaml`（仓库约定：探针必须无副作用，见 `AGENTS.md`）。

### 7.5 命令对照表（把 Claude Code ~150 条 / Kimi ~35 条收敛成动作）

显然不会逐条复刻；下面按"**Already（已有等价）/ Wire（接线即得）/ Build（要自研）/ Skip（不做）**"归档最重要的一批。

| 对标命令 | 语义 | Orca 现状 | 动作 |
| --- | --- | --- | --- |
| `/help` `/exit` `/clear` `/title`\|`/rename` `/compact` `/usage` `/model` `/resume` | 基础会话与信息 | **已具备** | Already（可补 `/context` 式占用可视化） |
| `/init` | 分析仓库生成指令文件 | 无 | **Build**（P0：模板 prompt + 提示重启/新会话） |
| `/memory` | 浏览/编辑记忆文件 | 无 | **Build**（P0 后半：只读展示内核加载了哪些 `AGENTS.md`/`CLAUDE.md`，编辑交给编辑器） |
| `/skills` `/reload-skills` `/skill-doctor`、`/name` | skill 目录与调用 | 手势可用、菜单不可见 | **Wire**（P0-4） |
| `/permissions`、`/yolo`、`/auto`、`/sandbox` | 权限档位与规则 | 档位已 Wire（P0-1）；规则层已 Build（P1-1：`/perms` + 面板增强 P1-2） | **Wire ✅（P0-1 已实现）** + **Build ✅（P1-1/P1-2 已实现，2026-09-11）**；`/auto`、`/sandbox` 仍 Skip（内核档位 + `danger-full-access` 已覆盖） |
| `/plan` | plan mode + 评审 | 影子实现 | **Wire ✅（P0-2 已实现）** |
| `/tasks`、`Ctrl+T`、`/todo` | 任务清单 | 本地投影 | **Wire ✅（P0-3 已实现）**；结构化任务面板仍是 P1 |
| `/agents` `/list-agents` `/subtask` `/btw` `/fork` `/branch`、`Ctrl+B` | 子代理与并行 | 无 | **Wire**（P1-3 并行工作台；`/fork` 走 `sessions.fork`） |
| `/background` `/tasks`(后台) `claude agents/attach/logs` | 后台会话 | 无 | **Skip**（形态不同，dsh 用 jobs + 进程内多会话，见 P2-9） |
| `/hooks` | 查看 hooks 状态 | 无（且未挂桥） | **Wire**（P1-9，先挂 `dsh-hooks-claude-code`） |
| `/mcp`、`claude mcp add/login/serve` | MCP 管理 | 无 | **Wire**（P1-10：挂行 + `/mcp` 面板；`serve` Skip） |
| `/plugin`、`marketplace`、`/reload-plugins` | 插件管理 | 无 | **Build**（P2：只读 inventory + `dsh plugin` 指引；marketplace Skip） |
| `/config` `/theme` `/keybindings` `/statusline` `/tui` | 设置/主题/键位/状态栏 | 只有 nerdfont 开关 | **Build**（P2-1/P2-3；`/tui` 等价于 Orca 的 `--fullscreen`） |
| `/vim`（已移除→`/config`）、`Ctrl+G` 外部编辑器 | 编辑器模式 | 无 | **Build**（P2-4，可选） |
| `!cmd` shell 模式 | 直接执行 shell | 无 | **Build**（P2-4） |
| `/copy` `/export` `/recap`、`Ctrl+O` 转录查看器、`Ctrl+R` 搜索、`[` 灌 scrollback | 转录操作 | 部分（滚动/选区） | **Build**（P1-5 + P2-4 搜索） |
| `/rewind` `/checkpoint` `/undo` | 回退 | 双击 Esc（对话级 fork） | **Wire/Build**（P1-6；文件级回退 Skip，内核没有） |
| `/export` `kimi export` `/export-debug-zip` | 导出 | 无 | **Build**（P1-5，自读 JSONL） |
| `/goal` | 持久目标 | 内核命令可能已进菜单 | **Wire**（P1-7 状态展示） |
| `/workflows` `/deep-research` `/batch`、`/swarm` | 编排 | 内核有 workflow/ralph | **Wire**（P1-7 进度视图） |
| `/doctor` `/checkup` | 自检 | 无 | **Build**（P1-8，roadmap 已列） |
| `/login` `/logout` `/provider` `/settings` | 账号与设置 | 无 | **Skip/Build**（凭据只读展示；OAuth 内核没有） |
| `/schedule` `/routines` | 定时 | 内核有 `dsh-schedule`（未挂） | **Skip**（可选 overlay） |
| `/cd` `/add-dir` | 多目录 | 无 | **Skip**（内核单 workspace 根） |
| `/ide` `/chrome` `/desktop` `/mobile` `/install-github-app` `/install-slack-app` `/artifacts` `/voice` | 平台集成 | 无 | **Skip**（不属于 TUI 职责；CI 侧可考虑 webhook overlay） |
| `/feedback` `/bug` `/privacy-settings` `/release-notes` `/upgrade` | 运维 | `/update` 已有 | **Wire**（`/feedback` 随命令镜像；其余按需） |

> 读法：**Wire 项**几乎都是"内核已有、只差呈现"，应当先做；**Build 项**是纯 TUI 工作量；**Skip 项**要么形态不同、要么上游没有，写进文档避免反复讨论。

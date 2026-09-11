# Orca 🐋

[![CI](https://github.com/FantasyStarry/dsh-orca/actions/workflows/ci.yml/badge.svg)](https://github.com/FantasyStarry/dsh-orca/actions/workflows/ci.yml)

**Orca** 是一个运行在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 内核内的终端前端（TUI），以 Cordis 插件形式挂载。零内核改动，卸载无残留。

```sh
orca / dsh-orca   # 均等价于 dsh --profile orca
```

## 特性

- 流式渲染：真实增量上屏，历史自动沉淀进终端 scrollback
- Markdown 渲染 + 轻量代码高亮
- 工具调用卡片：运行状态、结果、diff 高亮
- 审批面板：逐次确认 / yolo 自动放行；`Ctrl-E` 展开完整参数，`1`/`2`/`3`/`4` 编号直选
- 本地审批规则层（`/perms`，别名 `/rules`）：命中 `allow`/`deny` 的调用由规则**直接替内核应答**（`allowed-once` / `rejected`），不再弹窗；只有未命中或命中 `ask` 才打扰你。规则分四级——内置（8 条只读工具免问，`/perms reads off` 可关）、用户（`$DSH_HOME/orca/permissions.json`）、项目（`<cwd>/.orca/permissions.json`，可提交进仓库）、会话（面板里按 `2` 临时放行）。判定恒定优先级 `deny` > `ask` > `allow`，同档时范围更靠后的赢（builtin < user < project < session）；`allow *` 会被明确拒绝（整机放行请用 `/yolo`）。落盘的是可读、可评审的 JSON，面板还会给出「总是放行 bash(npm ci:*)」这类窄规则供复核。**内核仍然拥有 ask、审计与沙箱，Orca 只决定答案**
- `/model` 三段式切换 provider / model / 思考强度；选型会以**内核持久事件** `model/selection` 落进会话日志（与 web 端 `session.selectModel` 同一种记录），并**同时写入 `agent-default-model` 全局默认**——所以 TUI 里换一次模型，之后所有新会话（含 web 端新建的）都从它开始；这是有意的：web 端的「会话内选型」只改本会话，TUI 的 `/model` 两者都改，确认行会写明「已同步为新会话默认」。恢复会话时按内核的读法取值：未生效的 `model/selection` → 会话最后一次 `request/header` → composition 默认，所以「这个会话用哪个模型」在 TUI 与 web 之间一致。
  切换同时按内核 `installModelSelection` 的三条缝生效：**系统提示词里的 `{{provider}}`/`{{model}}` 跟着切换**（否则预设 persona 会一直说「powered by 旧模型」）、请求按装配时的快照路由（一次步骤内不会一半旧一半新）、并给模型一条 durable 告知（「上文这些回合是 X 生成的，本会话改用 Y」）
- 会话自动登记进它 cwd 对应的**工作区**（`@deepseek-ai/dsh-workspace` 的 `attachSession`），web 侧栏因此能把 TUI 会话归到对应工作区分组，而不是留在「未分组」；只登记已存在的工作区，不创建/改名/排序。
  注意这是**跨进程共享的单文档账本**：写入是整份覆盖，而 web 进程只在启动时读一次。所以（1）TUI 登记后需要**重启一次 web 服务**才能在侧栏看到归属；（2）若 web 在本 TUI 启动后写过账本，TUI 会**拒绝登记**（漂移守卫，避免用旧快照覆盖你在 web 里做的改动），此时改天重开 TUI 即可重试
- `/preset` 切换 Agent 预设
- 附件输入：`/img`（`/attach`）附加本地文件——图片走 `image` 块、其他文件走 `file` 块；`Ctrl+V` / `Alt+V` 粘贴图片，输入框内联 `[image #N]` / `[file #N]`，支持删除。剪贴板读取按平台走现成工具（Windows PowerShell、macOS `pngpaste`/`pbpaste`、Linux `wl-paste`/`xclip`），缺工具时降级为一句提示，绝不阻塞 TUI
- `@` 文件补全
- 多行输入：`Alt+Enter`（`Shift+Enter` / `Ctrl+J` 同义）换行，长行按 cell 软换行，编辑框随内容长高（上限 8 行，超出时底边提示 `↑/↓ N 行`）；`↑`/`↓` 在文本内移动光标，只在首/末行才召回历史；`Home/End`/`Ctrl+A`/`Ctrl+E`/`Ctrl+U`/`Ctrl+K` 都是行内语义
- 待办列表：`/todo`（只读展示模型持有的 `todo_write` 列表；编辑指令交给模型，本地不伪造真源）
- Skills：启动即读内核 `ctx.skills` 的用户可调用目录，`/` 菜单按「Skills」分组列出（输入 `/名字` 直接调用，内核 `/name` 手势负责注入正文），`/skills` 打印完整目录与来源
- 自定义命令：`<cwd>/.orca/commands/**/*.md`（项目）与 `$DSH_HOME/orca/commands`（用户）里的 Markdown 提示词模板——`db/migrate.md` → `/db:migrate`，支持 `description` / `argument-hint` frontmatter 与 `$ARGUMENTS` 展开；菜单里按「自定义」分组，命中后展开成一条普通消息（附件照常随行）
- 内核命令自动并入 `/` 菜单（真实 profile 里的 `/goal`、`/feedback` 等），并跟随 `commands/change` 实时刷新；与本地同名时只显示一次，本地处理器负责把参数**委托**给内核命令
- Agent 提问：支持官方 `ctx.userQuestions`，picker 单选/多选/自定义回答（`standard` preset 自带 `ask_user_question`）
- Plan 模式：`/plan` 走**内核** `dsh-plan-mode`（状态落 `plan/mode` 日志），计划由 `exit_plan_mode` 提交后进入评审面板：Approve / Keep planning / 直接反馈；`Esc` = 插话（模型的 `exit_plan_mode` 调用会带着"用户想插话"的理由失败，模型留在 plan 模式）
- 自更新：`orca update` / `/update`
- 页脚 Nerd Font 分支图标：`/nerdfont`
- 全屏备用屏模式（`--fullscreen`）：转录区成滑动窗口，**鼠标拖拽选择 + 释放即复制**（OSC 52），滚轮上下滚动；inline 模式不接管鼠标，终端原生选择照旧可用（全屏下要原生选择请按住 Shift 拖拽）
- 流式渲染、会话恢复、回退、压缩等

## 环境要求

- Node.js `^22.19 || >=24`
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) CLI（`@deepseek-ai/dsh`）`0.1.5-rc.1`（接缝按此版本核对；更早/更新版本未验证）
- pnpm（开发时）

## 安装

### 1. 安装 dsh

```sh
npm install -g @deepseek-ai/dsh
```

### 2. 安装 Orca

```sh
npm install -g dsh-orca
```

### 3. 挂载到 profile

```sh
dsh plugin --profile orca add dsh-orca
```

### 关于 agent 主动提问

不需要额外装插件：Orca 默认挂载的 `standard`（以及 `ptc`、`cordis`）preset 自带 `tool-ask-user`，所以模型可以 `ask_user_question`，Orca 会把它渲染成可选项 + 自定义回答的面板（`minimal` preset 是固定的两工具训练配置，不带提问工具；`/preset` 可切换）。

## 使用

```sh
orca
# 或
dsh-orca
```

### CLI 命令

| 命令 | 说明 |
| --- | --- |
| `orca` / `dsh-orca` | 启动 Orca TUI |
| `orca --help` / `-h` | 显示帮助 |
| `orca --version` / `-v` | 显示版本号 |
| `orca update` | 检查并更新 dsh-orca |
| `orca --profile <name>` | 指定 dsh profile（默认 `orca`） |
| `orca --fullscreen` | 以全屏备用屏模式启动 |
| `orca --resume <id>` | 恢复指定会话 |
| `orca --debug` | 开启诊断日志 |
| `orca --nerd-font` | 开启 Nerd Font 分支图标 |

### TUI 命令

在输入框输入 `/` 可打开命令菜单，常用命令：

| 命令 | 说明 |
| --- | --- |
| `/help` | 显示帮助 |
| `/model` | 切换 provider / model / 思考强度 |
| `/preset` | 切换 Agent 预设 |
| `/new` | 开新会话 |
| `/resume` | 浏览并恢复历史会话 |
| `/title` | 查看/设置会话标题 |
| `/compact [hint]` | 压缩上下文 |
| `/usage` | 查看 token 用量 |
| `/yolo [on|off]` | 工具审批自动放行 |
| `/permission [档位]` | 无参 = 本地审批策略 + 内核档位报告；带参 = 委托内核 `dsh-permission-presets` 切换档位（`read-only` / `workspace-write` / `danger-full-access`） |
| `/perms [list\|allow\|deny\|ask\|rm\|reads\|reload]` | **本地审批规则层**（别名 `/rules`）。无参 = 列表（编号、来源、判定优先级说明）；`/perms allow bash(npm test:*) --reason 常用测试` 写入**项目**规则文件（`--user` 写用户级、`--session` 只在本会话生效）；`/perms rm <编号>` 删除（内置规则不可单删，用 `reads off`）；`/perms reads on\|off` 切换只读免问；`/perms reload` 重读文件。`allow *` 会被拒绝——整机放行请用 `/yolo` |
| `/img <路径>` | 附加本地图片 |
| `/todo` | 查看待办（真源是模型的 `todo_write`）；`add/set/done/undo/del/clear` 会把指令作为消息交给模型改写，Orca 不在本地伪造列表 |
| `/ask <问题>` | 向 agent 提问，本轮只回答不执行工具 |
| `/plan [on\|off\|toggle\|<指令>]` | 切换**内核** plan 模式（状态落在会话日志 `plan/mode`，resume/fork 可恢复）；模型完成任务后会用 `exit_plan_mode` 提交计划，Orca 渲染成评审面板（Approve / Keep planning / 反馈）。工具边界由审批与沙箱负责，不在客户端拦截 |
| `/nerdfont [on|off]` | 切换 Nerd Font 分支图标 |
| `/skills` | 列出可用 skill（用户可调用目录 + 来源；另有 N 个仅模型可用） |
| `/update` | 检查并更新 dsh-orca |

### 快捷键

| 快捷键 | 说明 |
| --- | --- |
| `Enter` | 发送 |
| `Alt+Enter` | 换行（`Shift+Enter` / `Ctrl+J` 同义；多行输入） |
| `Ctrl+V` / `Alt+V` | 粘贴剪贴板图片 |
| `@路径` | 文件补全 |
| `↑` / `↓` | 多行文本内移动光标；在首/末行时才召回历史 |
| `Shift+Tab` | 切换 yolo |
| `Ctrl+O` | 展开/折叠思考过程 |
| `Esc` | 打断 / 取消 |
| `Ctrl+C` | 打断 / 双击退出 |
| `Ctrl+A/E/K/U/W` | readline 编辑（行内语义：Home/End、删到本行首/尾、删词） |
| 鼠标拖拽（全屏） | 选择文本，松开即复制到剪贴板（OSC 52） |
| 滚轮（全屏） | 上下滚动转录窗口 |

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `ORCA_PROFILE` | dsh profile 名，默认 `orca` |
| `ORCA_RESUME_SESSION` | 启动时恢复指定会话 |
| `ORCA_PROVIDER` / `ORCA_MODEL` | 覆盖模型路由 |
| `ORCA_FULLSCREEN` | `1` 时使用全屏备用屏模式 |
| `ORCA_NERD_FONT` | `1` 时启用 Nerd Font 分支图标 |
| `ORCA_DEBUG` | `1` 时输出诊断日志到 stderr |
| `ORCA_LOG` | 记录 stdout 字节流到指定文件 |
| `ORCA_LAST_SESSION_FILE` | 覆盖 last-session 标记文件路径 |
| `ORCA_WORKSPACE_FILE` | 覆盖工作区账本路径（漂移守卫读它；测试用） |
| `ORCA_SETTINGS_FILE` | 覆盖本地设置文件路径 |
| `ORCA_COMMANDS_DIR` | 覆盖自定义命令目录（默认 `<cwd>/.orca/commands`；用户级固定为 `$DSH_HOME/orca/commands`） |
| `ORCA_PERMISSIONS_FILE` | 覆盖**项目**审批规则文件（默认 `<cwd>/.orca/permissions.json`） |
| `ORCA_PERMISSIONS_USER_FILE` | 覆盖**用户**审批规则文件（默认 `$DSH_HOME/orca/permissions.json`）；测试/探针靠这两个变量把规则写到临时目录，绝不碰你真实的规则 |
| `ORCA_DSH_PKG` | 探针用：显式指定 `@deepseek-ai/dsh` 的 `package.json`（默认按 PATH 上的 `dsh` 定位，避免命中陈旧的 hoisted 副本） |
| `ORCA_PROBE_DIR` | 探针产物目录，默认 `<仓库>/.probe` |
| `ORCA_E2E_CWD` | 探针的工作目录，默认取工作区账本里第一个已登记路径 |
| `DSH_HOME` | dsh 家目录，默认 `~/.dsh`（探针读会话日志/设置用） |

## 开发

```sh
pnpm install
pnpm build        # tsc → lib/
pnpm test         # 生命周期 + 渲染回归 + 事件投影 + 选区/剪贴板 + 自定义命令（30 条）
pnpm dev          # 假内核冒烟测试（12 个 phase）
```

真实内核验证（在 `orca` profile 内，驱动真 PTY；`--features` / `--live` 各花一次最小 API 调用，`--state` 零调用）：

```sh
node scripts/probe-pty.mjs             # 启动 / 输入框 / 双图层几何
node scripts/probe-pty.mjs --state     # 工作区归属 + 会话日志里的模型记录与恢复沿用
node scripts/probe-pty.mjs --features  # 文件附件通路 + 模型切换告知 + 提示词跟随切换 + 附件跨命令存活
node scripts/inspect-session.mjs <session-id>   # 会话日志取证（压缩帧感知）
```

探针不写死任何本机路径：dsh 安装位置按 PATH 上的 `dsh` 定位（`ORCA_DSH_PKG` 可覆盖），产物落在 `.probe/`，工作目录取已登记工作区。探针里的 `/model` 流程是**真实选择**（会写全局默认 `agent-default-model`），所以脚本启动时快照 `settings.yaml`，无论成功、失败还是超时都会**原样还原**——跑探针不会改掉你记住的模型。CI（`.github/workflows/ci.yml`）在 ubuntu + windows 上跑 `build` / `test` / `dev`；PTY 探针需要真实内核与 node-pty，只在本地跑。

本地挂载：

```sh
dsh plugin --profile orca add <本仓库路径>
dsh --profile orca
```

`cordis.patch.yml` 会插入内核的 `workspace` 行（`@deepseek-ai/dsh-workspace`）——`dsh-base` 不含它，只有 web-app bundle 才挂。它随 dsh 安装一起落盘，正常安装无需额外操作；若某次安装里确实缺这个包，删掉该 `- id: workspace` 行即可恢复（会话不再自动归组，其余功能不受影响）。

## 状态与路线图

已完成：骨架与生命周期 → 真实内核闭环（流式增量、工具卡片、审批配对）→ 视觉层（主题 token、markdown、代码高亮、diff）→ 会话层（`/resume` 浏览、标题、`/compact`、双击 Esc 回退、durable 模型选择、工作区归属）→ 壳层（状态槽、附件通路、多行输入、跨平台剪贴板、全屏备用屏 + 鼠标选择/OSC 52 复制、Kitty 键盘协议、封存行滚入 scrollback）→ 内核真源对齐（三处影子实现改为委托：`/plan` 走 `dsh-plan-mode` + `exit_plan_mode` 评审面板、`/todo` 只读 + 指令交给模型、`/permission` 参数委托内核档位；`/` 菜单同名去重）→ 扩展入口（Skills 进菜单 + `/skills`、自定义 Markdown 命令与 `$ARGUMENTS`、菜单分区/子序列模糊匹配/内核 `input.hint`/忙时置灰）→ 审批规则层（P1-1/P1-2：`/perms` 规则文件 + 面板编号直选/`Ctrl-E` 展开/只读免问；命中规则直接替内核应答，`deny` 恒定优先；8 条变异验证全红）。

未完成：

- `--doctor` 自检：一键打印内核版本、各软探测接缝的在位情况、工作区漂移状态（现在只能翻日志）
- 极窄终端（< 40 列）下的布局取舍

对标 Claude Code / Kimi Code 的完整差距盘点（十域矩阵 + 差距分级 + 优先级路线图 + 证据复现命令）见 [`docs/planning/parity-gap-claude-code-kimi-code.md`](docs/planning/parity-gap-claude-code-kimi-code.md)——上面这份"未完成"清单是它的子集。

## 项目结构

```text
src/
  app.ts              # 装配：TTY、agent、channel、renderer、keyboard
  clipboard.ts        # 跨平台剪贴板读取（Windows/macOS/Linux，失败即降级）
  adapter/channel.ts  # session/event → 转录行投影
  kernel/types.ts     # 内核接缝类型镜像
  tui/                # 渲染、输入、主题、picker、markdown、备用屏选区等
  update.ts           # 自更新逻辑
bin/
  orca.js             # CLI 启动器
scripts/
  paths.mjs           # 探针共用路径解析（dsh 安装 / 产物目录 / 工作目录）
  dev.ts              # 假内核冒烟 harness
  lifecycle.test.ts   # 插件生命周期（装配/dispose/竞态）
  render-regressions.ts # 帧构建回归（净化/宽字符/多行编辑/全屏滚动）
  channel.test.ts     # session/event → 转录行投影
  commands.test.ts    # 自定义命令：frontmatter / 命名空间 / 扫描优先级 / $ARGUMENTS
  selection.test.ts   # 备用屏选区几何 + 剪贴板降级 + file:// 解析
  probe-pty.mjs       # 真 PTY 探针（--state / --features / --live）
  session-log.mjs     # 会话日志读取（zstd 多帧）
  inspect-session.mjs # 会话日志取证 CLI
cordis.patch.yml      # Cordis 插件挂载配置
```

## License

[MIT](LICENSE)

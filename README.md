# Orca 🐋

**Orca** 是一个运行在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 内核内的终端前端（TUI），以 Cordis 插件形式挂载。零内核改动，卸载无残留。

```sh
orca / dsh-orca   # 均等价于 dsh --profile orca
```

## 特性

- 流式渲染：真实增量上屏，历史自动沉淀进终端 scrollback
- Markdown 渲染 + 轻量代码高亮
- 工具调用卡片：运行状态、结果、diff 高亮
- 审批面板：逐次确认 / yolo 自动放行
- `/model` 三段式切换 provider / model / 思考强度；选型会以**内核持久事件** `model/selection` 落进会话日志（与 web 端 `session.selectModel` 同一种记录），并写入 `agent-default-model` 默认值。恢复会话时按内核的读法取值：未生效的 `model/selection` → 会话最后一次 `request/header` → composition 默认，所以「这个会话用哪个模型」在 TUI 与 web 之间一致
- 会话自动登记进它 cwd 对应的**工作区**（`@deepseek-ai/dsh-workspace` 的 `attachSession`），web 侧栏因此能把 TUI 会话归到对应工作区分组，而不是留在「未分组」；只登记已存在的工作区，不创建/改名/排序。
  注意这是**跨进程共享的单文档账本**：写入是整份覆盖，而 web 进程只在启动时读一次。所以（1）TUI 登记后需要**重启一次 web 服务**才能在侧栏看到归属；（2）若 web 在本 TUI 启动后写过账本，TUI 会**拒绝登记**（漂移守卫，避免用旧快照覆盖你在 web 里做的改动），此时改天重开 TUI 即可重试
- `/preset` 切换 Agent 预设
- 附件输入：`/img`（`/attach`）附加本地文件——图片走 `image` 块、其他文件走 `file` 块；`Ctrl+V` / `Alt+V` 粘贴图片，输入框内联 `[image #N]` / `[file #N]`，支持删除
- `@` 文件补全
- 待办列表：`/todo`
- 内核命令自动并入 `/` 菜单（真实 profile 里的 `/goal`、`/feedback` 等），并跟随 `commands/change` 实时刷新
- Agent 提问：支持官方 `ctx.userQuestions`，picker 单选/多选/自定义回答
- Plan 模式：`/plan` 只规划不执行
- 自更新：`orca update` / `/update`
- 页脚 Nerd Font 分支图标：`/nerdfont`
- 全屏备用屏模式、滚动缓冲、会话恢复、回退、压缩等

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

如果希望 agent 能主动提问，还需要挂载官方提问工具：

```sh
dsh plugin --profile orca add @deepseek-ai/dsh-tool-ask-user
```

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
| `/permission` | 查看审批策略 |
| `/img <路径>` | 附加本地图片 |
| `/todo` | 查看/编辑待办（list/add/done/undo/del/clear） |
| `/ask <问题>` | 向 agent 提问，本轮只回答不执行工具 |
| `/plan [on|off]` | 切换 Plan 模式 |
| `/nerdfont [on|off]` | 切换 Nerd Font 分支图标 |
| `/update` | 检查并更新 dsh-orca |

### 快捷键

| 快捷键 | 说明 |
| --- | --- |
| `Enter` | 发送 |
| `Ctrl+V` / `Alt+V` | 粘贴剪贴板图片 |
| `@路径` | 文件补全 |
| `↑` / `↓` | 历史召回 / 返回 |
| `Shift+Tab` | 切换 yolo |
| `Ctrl+O` | 展开/折叠思考过程 |
| `Esc` | 打断 / 取消 |
| `Ctrl+C` | 打断 / 双击退出 |
| `Ctrl+A/E/K/U/W` | readline 编辑 |

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

## 开发

```sh
pnpm install
pnpm build        # tsc → lib/
pnpm test         # 生命周期 + 渲染回归测试
pnpm dev          # 假内核冒烟测试
```

真实内核验证（在 `orca` profile 内，驱动真 PTY；`--features` / `--live` 各花一次最小 API 调用，`--state` 零调用）：

```sh
node scripts/probe-pty.mjs             # 启动 / 输入框 / 双图层几何
node scripts/probe-pty.mjs --state     # 工作区归属 + 会话日志里的模型记录与恢复沿用
node scripts/probe-pty.mjs --features  # 文件附件通路 + 模型切换告知 + 附件跨命令存活
node scripts/inspect-session.mjs <session-id>   # 会话日志取证（压缩帧感知）
```

本地挂载：

```sh
dsh plugin --profile orca add <本仓库路径>
dsh --profile orca
```

`cordis.patch.yml` 会插入内核的 `workspace` 行（`@deepseek-ai/dsh-workspace`）——`dsh-base` 不含它，只有 web-app bundle 才挂。它随 dsh 安装一起落盘，正常安装无需额外操作；若某次安装里确实缺这个包，删掉该 `- id: workspace` 行即可恢复（会话不再自动归组，其余功能不受影响）。

## 项目结构

```text
src/
  app.ts              # 装配：TTY、agent、channel、renderer、keyboard
  adapter/channel.ts  # session/event → 转录行投影
  kernel/types.ts     # 内核接缝类型镜像
  tui/                # 渲染、输入、主题、picker、markdown 等
  update.ts           # 自更新逻辑
bin/
  orca.js             # CLI 启动器
scripts/
  dev.ts              # 假内核冒烟 harness
  probe-pty.mjs       # 真 PTY 探针（--state / --features / --live）
  session-log.mjs     # 会话日志读取（zstd 多帧）
  inspect-session.mjs # 会话日志取证 CLI
cordis.patch.yml      # Cordis 插件挂载配置
```

## License

[MIT](LICENSE)

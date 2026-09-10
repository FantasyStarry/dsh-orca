# AGENTS.md — Orca 仓库协作规范

面向在本仓库工作的 agent 与贡献者。以代码为准；动手前先读相关源码与本文。

## 项目身份

- **Orca**：DeepSeek Harness 的 in-process TUI 前端（TypeScript Cordis 插件）。
- 参考系：ccch1mneyyy/dsh-TUI（挂载形态）、earendil-works/pi（渲染与 UX）、MoonshotAI/kimi-code（壳层职责）。深度调研在 `docs/research/`。
- 仓库前身是 Rust ACP 客户端，历史保留在 git 里；**不要**把 ACP/子进程模式的假设带回来。

## 铁律

1. **零内核改动**：不 fork 内核、不加私有方法、不碰 `_meta`。一切经由 in-process Cordis 接缝（`agents`、`session/event`、`ctx.get(name, false)` 软探测）。
2. **插件契约三面**：`name` / `Config` / `apply`，无默认导出；所有配置键必须有默认值，插件缺失 = 什么都没发生，绝不让启动失败。
3. **#183 纪律**：代码级 inject 为空；可选接缝全部软探测 + 静默降级（见 `src/app.ts` 的 `agents` 处理范例）。
4. **Session 是真源**：UI 不持有会话真相；一切投影可从 `session/event` 重建（见 `src/adapter/channel.ts`）。注意 0.1.5 起日志里**没有 chunk 事件**：实时增量走 agent 作用域的 `agent/assistant-stream`，回放靠 `assistant/message` 的 message.content / stream。**模型路由也是会话真相**：唯一取法是内核那套顺序——最后一条未生效的 `model/selection` → 会话最后一次 `request/header`（`Session.requestHeader()`，`adapterDefaults.reasoningEffort` 的适配器默认值要丢掉）→ composition 默认（`agentDefaultModel`）；不要用「本进程上次选了什么」当答案（见 `src/app.ts` 的 `durableSelection`）。
5. **TUI 活动期间 stdout 安静**：诊断走 stderr（`ORCA_DEBUG=1`），绝不 `console.log` 到 stdout。
6. **事件落地规则**：Orca 目前只 append 一种 session 事件——`model/selection`（内核已知的 log-only 类型，形状与 web 端 `session.selectModel` 完全一致），不带 surface 元数据；不存在自造事件类型。将来若要新增，必须是 log-only 且能被安全跳过（优先复用内核已知类型；真正自造的类型要带 `ignorable: true`，0.1.5 起内核用事件自带的 `ignorable` 声明"跳过是否安全"而不是事件名注册）。
7. **清理挂 `ctx.effect`**：每个 disposer 都要能在插件卸载时恢复终端/释放句柄。
8. **写内核状态要"只加自己的"**：Orca 会写的工作区状态仅限于「把自己刚创建的会话 `attachSession` 到已存在的工作区」（`~/.dsh/storages/workspace.json` 与 web 进程共享）。不得创建/改名/删除/排序工作区，不得为别的会话登记；被拒/缺服务一律静默降级。

## 工程约定

- Node `^22.19 || >=24`，纯 ESM；**相对导入必须带 `.js` 后缀**（TS 源码同样如此）。
- `pnpm build`（tsc → `lib/`）必须零错误；strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` 已开，新代码不得用 `any` 逃逸（防御性解析用 `unknown` + 收窄）。
- 内核接缝类型是**镜像**（`src/kernel/types.ts`）：与真实 `@deepseek-ai/*` 面不一致时改镜像并注明核对过的内核版本；镜像上必须有 doc 注明对应接缝。
- 未知事件类型/字段一律宽容忽略（内核是 developer preview，破坏性变更是预期）。
- 文案中文优先；宽度计算永远按 terminal cell，不按 `string.length`。
- 提交信息：**Conventional Commits**（`feat:` / `fix:` / `refactor:` / `docs:` / `chore:`），主题行中文写清做了什么——新增了什么、修复了什么、删除了什么；可附英文摘要。（2026-08 起，历史提交不改写。）

## 验证（提交前必跑）

```sh
pnpm build
pnpm dev   # 假内核冒烟：TTTY 渲染循环、键盘、降级启动
pnpm test  # 生命周期 + 渲染回归
```

涉及真实内核的改动，需在 profile 内实测：`dsh plugin --profile orca add .` → `dsh --profile orca`；能自动化的一律写进 `scripts/probe-pty.mjs`（真 ConPTY 驱动，`--state` 零 API 调用；`--features` / `--live` 各花一次最小调用），会话日志用 `scripts/inspect-session.mjs <session-id>` 取证。

## 目录地图

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | 插件契约（保持轻量，延迟加载 runtime） |
| `src/app.ts` | 装配：TTY 门 → agent 工厂 → channel/renderer/keyboard → 统一 disposer；agent 作用域监听（`agent/request`、`agent/assistant-stream`、`approval/request`、`user-questions/request`）；`durableSelection`（会话记录的路由）+ `attachSessionToWorkspace`（工作区登记） |
| `src/adapter/channel.ts` | session/event + `agent/assistant-stream` → 转录行投影 + 行级连续封存；submit/steer/cancel 动作入口 |
| `src/tui/renderer.ts` | 流式追加渲染 + CUP 绝对寻址 + CSI 2026；封存行自然滚入 scrollback，帧输出唯一出口 |
| `src/tui/chat.ts` | 纯函数帧构建（channel + editor + width → lines） |
| `src/tui/input.ts` | raw 模式键盘解析 |
| `src/tui/width.ts` | 显示宽度（占位实现，生产换 get-east-asian-width） |
| `src/kernel/types.ts` | 内核接缝类型镜像（唯一允许"像内核"的地方） |
| `cordis.patch.yml` | Orca bundle patch：除自身行外还插入内核 `workspace` 行（`@deepseek-ai/dsh-workspace`，dsh-base 不含）与预设 roster |
| `scripts/dev.ts` | 假内核冒烟 harness |
| `scripts/probe-pty.mjs` | 真 profile PTY 探针（`--state` / `--features` / `--live` / `--fullscreen`） |
| `scripts/session-log.mjs` | 会话日志读取（`.jsonl.zstd` 多 zstd 帧） |
| `scripts/inspect-session.mjs` | 会话日志取证 CLI（落盘的模型记录 / 附件 / 事件词表） |
| `bin/orca.js` | 启动器：`orca` ≡ `dsh --profile orca` |
| `docs/research/` | 三份上游调研报告（动手借鉴前必读对应篇） |
| `docs/adr/` | 架构决策记录 |

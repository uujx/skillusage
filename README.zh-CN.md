# skillusage

[![npm 版本](https://img.shields.io/npm/v/@uujx/skillusage.svg)](https://www.npmjs.com/package/@uujx/skillusage) [![npm 下载量](https://img.shields.io/npm/dt/@uujx/skillusage.svg)](https://www.npmjs.com/package/@uujx/skillusage) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

[English](./README.md) · 简体中文

查看你最常使用哪些 Codex Skill，以及哪些已安装 Skill 没有使用记录。

从本地 Codex 历史生成排行榜，支持按日期和项目筛选。无需账户、API key 或后台服务。

## 开始试用

需要 **Node.js 22+** 和本地 Codex 会话记录。

```bash
npx @uujx/skillusage@latest
```

默认统计本地时区的今天及此前 29 天。交互式终端会显示扫描进度。

## 效果预览

以下为示例数据，并非真实用户历史：

```text
skillusage · codex · Loaded
2026-08-01 – 2026-08-31 · All projects
78 loads · 23 sessions · 5 skills with loads
Trend ▁▂▃▅▄▆█▅▆▇▅▆ · 31 days
Last 7 complete days: 14 → 21 (+7) · 08-18–08-24 → 08-25–08-31

#  Skill                           Loads  Sess  Last date   Trend
1  brainstorming                     31    12  2026-08-31  ▁▂▃▄▆█▅▆▇▅▆█
2  test-driven-development           24    10  2026-08-30  ·▁▂▃▅█▆▄▅▃▆▇
3  verification-before-completion    12     8  2026-08-31  ··▁▂▄▆█▅▄▃▆█
4  diagnose                           7     4  2026-08-29  ···▁▃█▄▂▁··▃
5  openai-docs                        4     3  2026-08-28  ····▁··█·▁··

8 current skills: no load detected in range · --show-zero
Trend: daily average / bucket; each row scaled independently.
Explicit requests: skillusage --requested
```

- **使用次数：** 按下文统计口径检测到的确认加载次数。
- **Sessions：** 使用过该 Skill 的会话数。一个会话可以使用多个 Skill，因此各行会话数不能直接相加得到总会话数。
- **最近使用：** 所选时区内最近一次记录到使用的日期。

默认报告显示所有检测到加载的 Skill。用 `--limit N` 主动缩短榜单，`--limit 0` 明确请求完整榜单，`--show-zero` 展开当前可用、但所选范围内未检测到加载的字母序清单。交互式终端会把该清单排成最多三列，管道输出仍保持一项一行。零记录不代表无价值，也不是删除建议。

## 筛选日期或项目

```bash
npx @uujx/skillusage@latest --days 7
npx @uujx/skillusage@latest --days 90
npx @uujx/skillusage@latest --from 2026-08-01 --until 2026-08-31
npx @uujx/skillusage@latest --days 30 --project my-project
npx @uujx/skillusage@latest --all
npx @uujx/skillusage@latest --days 30 --json > skillusage.json
npx @uujx/skillusage@latest --requested
npx @uujx/skillusage@latest --requested --limit 10
npx @uujx/skillusage@latest --show-zero
npx @uujx/skillusage@latest --help
```

将 `my-project` 换成仓库名称。指定的起止日期均包含当天。三种日期模式互斥：`--days`、成对的 `--from` 与 `--until`、`--all`。

其他选项：`--timezone Asia/Shanghai` 指定日历时区；`--codex-home PATH` 指定数据目录（默认为 `~/.codex`）；`--jobs 1..4` 设置文件并发数（默认为 4）。

`--requested` 将终端榜单替换为用户新发且直接显式点名已知 `$skill` 的记录；它会排除 fork 复制的上下文、子 Agent 任务上下文、自动 goal 与注入的 Skill 正文。Requested 与 Loaded 是两组独立事件，不是漏斗关系：显式请求不证明发生过可确认的入口文件读取，Load 也可以没有显式请求。`--show-zero` 只适用于 Loaded。`--json` 始终输出完整的 1.1.0 报告，不能和 `--requested`、`--limit` 或 `--show-zero` 合用。

未筛选项目时，零记录列表只检查当前全局 Skill；指定项目后，还会包含该项目当前可用的 Skill。历史上使用过、如今已卸载的 Skill 仍会出现在排行榜中。顶部 Skill 总数是“排行榜条目 + 零记录条目”，并非当前安装数量。

## 如何统计

skillusage 扫描本地 `sessions/`、`archived_sessions/`、可选的本地 `history.jsonl`，并读取当前 Skill 配置。**Loaded** 表示受支持的工具记录确认某个 `SKILL.md` 入口被成功读取。**Requested** 只统计用户新发且直接显式点名的已知 `$skill`；系统/开发者内容、fork 继承上下文、子 Agent 任务上下文、自动 goal、Skill 注入、工具输出、普通名称和未知 token 都不计入。

- 识别受支持的 `cat`、`sed`、`head`、`tail` 读取，包括复合命令中可识别的读取动作；不会执行历史命令。
- 兼容 `CommandExecution`、旧版 `exec_command` 调用与结果记录，以及 custom `exec` 记录。
- 结合会话当时声明的 Skill、当前安装和已知 Codex Skill 目录识别入口。规范化后同名的 Skill 合并统计，包括移动或更新后的安装，无需匹配当前文件正文。
- 按相同调用 ID 消除 fork 复制的历史。没有 ID 时，只有父子来源的显式轮次或 `turn_context` 身份相同才合并；存在歧义的记录保留在 Load coverage 中，不会被静默删掉。每轮、每个 Skill 最多计一次；不同轮次分别计数。
- 不计入路径提及、搜索、写入、失败读取，以及无法确认的读取。
- rollout 与 `history.jsonl` 的重复显式消息会配对。已证明父子关系时，按原始消息 occurrence 合并，因此即使副本改写了时间戳也不会变成新请求；用户再次发送相同文本仍会计数。原始消息、fingerprint、Session ID、lineage 和路径不会进入公共报告。

这些数字都是检测事实，不代表工作流完成次数或 Skill 效果。未支持、缺失、冲突或无法判定的记录都可能导致漏计或 coverage 不完整。JSON 的 `coverage` 分别保留 Load/Requested 的扫描质量和当前 Skill 清单的可用情况，默认终端不展示这些诊断。JSON 还区分“所选范围内未检测到”与“完整可用历史中未检测到”。

## 趋势

终端趋势最多显示 12 个点，每一点都是近似等长日期 bucket 的每日平均值；`--all` 会用最多 12 个等时长桶覆盖完整历史，并标注近似每桶日数。排行旁的绝对次数才可跨行比较，每条 sparkline 都只按该行归一化。查询至少有 14 个完整本地日时，整体趋势还会以原始次数比较最近两个 7 日窗口，并排除未结束的当天。JSON 保留完整的每日事实。

版本变更记录见 [Release Notes](./RELEASE_NOTES.md)。

## 隐私与范围

分析完全在本地运行，不联网、不上传、不写遥测。报告保留 Skill 和项目名称，不包含对话正文、原始工具输出、会话 ID、绝对用户路径、凭据或 URL 查询参数。进度写入 stderr，`--json` 输出可直接供脚本读取。分享报告前，请检查其中的真实名称。

当前**只支持 Codex**，提供终端和 JSON 报告。其他 Agent 平台和 Web 界面是未来可能的方向，尚未实现。

## 参与改进

欢迎[反馈问题](https://github.com/uujx/skillusage/issues)或通过 Pull Request 贡献改进。

从源码运行时，在仓库目录执行：

```bash
npm ci
npm run build
node dist/cli/main.js
```

反馈计数问题时，请提供工具版本（`--version`）、Node.js 版本、查询选项，以及预期与实际次数。只分享最小化的脱敏样例，不上传完整会话日志。

修改源码后，运行 `npm run typecheck`、`npm run lint` 和 `npm test`。`npm pack --dry-run` 会构建并列出发布包内容，不会发布。

## 许可

[MIT](./LICENSE)

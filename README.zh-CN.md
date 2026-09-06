# skillusage

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
Skill usage · codex

2026-08-01 – 2026-08-31 · All projects
28 loads · 12 sessions · 2 / 3 skills loaded

Loaded skills · 2
#  Skill                    Loads  Sessions  Last load
1  brainstorming               16         9  2026-08-30
2  test-driven-development     12         8  2026-08-30

Not loaded in this range · 1
review
```

- **使用次数：** 按下文统计口径记录的 Skill 使用次数。
- **Sessions：** 使用过该 Skill 的会话数。一个会话可以使用多个 Skill，因此各行会话数不能直接相加得到总会话数。
- **最近使用：** 所选时区内最近一次记录到使用的日期。

排行榜完整显示所有有记录的 Skill，依次按使用次数、会话数、最近使用日期降序排列，同分按名称排序。独立的字母序列表展示当前可用、但所选范围内没有使用记录的 Skill。零记录不代表无价值，也不是删除建议。

## 筛选日期或项目

```bash
npx @uujx/skillusage@latest --days 7
npx @uujx/skillusage@latest --days 90
npx @uujx/skillusage@latest --from 2026-08-01 --until 2026-08-31
npx @uujx/skillusage@latest --days 30 --project my-project
npx @uujx/skillusage@latest --all
npx @uujx/skillusage@latest --days 30 --json > skillusage.json
npx @uujx/skillusage@latest --help
```

将 `my-project` 换成仓库名称。指定的起止日期均包含当天。三种日期模式互斥：`--days`、成对的 `--from` 与 `--until`、`--all`。

其他选项：`--timezone Asia/Shanghai` 指定日历时区；`--codex-home PATH` 指定数据目录（默认为 `~/.codex`）；`--jobs 1..4` 设置文件并发数（默认为 4）。

未筛选项目时，零记录列表只检查当前全局 Skill；指定项目后，还会包含该项目当前可用的 Skill。历史上使用过、如今已卸载的 Skill 仍会出现在排行榜中。顶部 Skill 总数是“排行榜条目 + 零记录条目”，并非当前安装数量。

## 如何统计

skillusage 扫描本地 `sessions/`、`archived_sessions/` 日志，并读取当前 Skill 配置。我们以检测到的**加载（Load）**作为“使用”的统计依据：受支持的工具记录能确认某个 Skill 的入口文件 `SKILL.md` 被成功读取。当前 CLI 将对应次数标为 `Loads`，最近日期标为 `Last load`。

- 识别受支持的 `cat`、`sed`、`head`、`tail` 读取，包括复合命令中可识别的读取动作；不会执行历史命令。
- 兼容 `CommandExecution`、旧版 `exec_command` 调用与结果记录，以及 custom `exec` 记录。
- 结合会话当时声明的 Skill、当前安装和已知 Codex Skill 目录识别入口。规范化后同名的 Skill 合并统计，包括移动或更新后的安装，无需匹配当前文件正文。
- 在日期筛选出的候选文件内，按相同调用 ID 消除 fork 复制的历史，再按每轮、每个 Skill 去重；不同轮次分别计数。
- 不计入路径提及、搜索、写入、失败读取，以及无法确认的读取。

这些数字表示检测到的入口读取，不代表工作流完成次数或 Skill 效果。未支持或缺失的日志记录可能导致漏计。JSON 的 `coverage` 保留扫描质量和当前 Skill 清单的可用情况，默认终端不展示这些诊断。JSON 还区分“所选范围内未检测到”与“完整可用历史中未检测到”。

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

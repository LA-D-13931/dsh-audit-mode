# dsh-audit-mode

> 给个人开发者和学习者用的 **DeepSeek Harness 审核模式**：一个只读、可审计的「监督 agent」预设。
> 它审别的 agent 的活（而不是教人），用宿主级强制层保证写不进被审库，并把「要求 → 纪律 → 行为 → 证据」串成可复核的链。

**English**: A read-only, auditable agent preset for DeepSeek Harness. It supervises *other agents'* work (not teaching): a host-level enforcement plugin keeps writes out of the audited repo, and a companion toolkit provides session auditing, requirement ledger, eval set, patrol, and agent-to-agent handoff generation.

---

## 它解决什么

- **只读不是口号**：预设只读 + 宿主级 `audit-mode-enforce`（`tools.restrict` + `tools.guard`）双层保证；非白名单工具被隐藏，写类工具的目标路径必须在审核方工作区，shell 的系统变更/写区外直接拒绝，每次 allow/deny 写 JSONL。
- **不采信自报**：`tools/会话审计.mjs` 直接读 DSH 会话日志（harness 自己写的），看“要求 / 调用 / 写盘 / 声明”四类痕迹。
- **要求入册**：`tools/检查要求台账.mjs` 核「对话里的持久性要求有没有写进纪律」，缺落点/欠账分层退出码。
- **可交接**：`tools/生成转交.mjs` 把 findings 生成给「修的人（agent）」的提示词——可执行、可复现、不含补丁。
- **可回归**：`tools/跑评测.mjs` 用已知红/绿用例记分（假红率/漏检率），`tools/巡检.mjs` 只读巡检被审库与状态源漂移。

## 安装

本仓库是一个 DSH bundle（`package.json` + `cordis.patch.yml` + `enforce.js`）。

**本地安装（推荐，当前可用）**：在 DSH 里用插件管理器安装本目录（`plugin_manager install_bundle`，target = 本仓库绝对路径）；或把它 link 进 profile。

> 仓库发布后也可以尝试 `dsh plugin --profile web add github:LA-D-13931/dsh-audit-mode`（版本与 DSH 兼容性以实际为准）。

安装后：新建会话 → 预设选择器出现 **「审核模式」**（id `audit`）→ **工作目录必须选审核方工作区**（不是被审库）。

## 初始化审核工作区

```bash
# 把 tools/ 复制到你的审核方工作区，命名为 审核工具/（预设里的命令按这个名字写）
cp -R tools /path/to/audit-workspace/审核工具
cp 审核工具/巡检配置.example.json 审核工具/巡检配置.json   # 改成你的被审库/状态源
```

## 三档用法（个人成本优先）

| 档 | 什么时候用 | 跑什么 |
|---|---|---|
| **快检** | 开工前 / 日常 | `node 审核工具/巡检.mjs` + `node 审核工具/跑评测.mjs` |
| **标准** | 一轮完整审核 | 读状态源/契约 → 会话审计自查 → 产物层检查 → findings → 报告 + `生成转交.mjs` |
| **深审** | 高风险（判据/答案键/CI/发布） | 标准 + `subagent` 并行独立复核 + 第二上下文交叉验证；Blocker/Major 必须复核过 |

成本调优已内置：`tool-fs` 单次读 1000 行/600 字符/40KB；`tool-fs-search` glob 50 / grep 50 / 行宽 500。

## 安全模型（务必读）

1. **审核会话必须开在审核方工作区**：enforce 允许写的根 = 会话工作目录；开在被审库目录里等于把被审库当可写区。
2. **bash 静态检查不是沙箱**：脚本内部用绝对路径写盘它看不见；最终边界仍是会话 sandbox 模式 + 被审库在工作区之外。
3. **只对 durable `agentPreset = audit` 生效**；别的预设会话完全不受影响；会话中途不能换预设。
4. **Team spawn 被拒绝**（会生成不受约束的会话）；分派请用 `subagent` / `subagent_fork`（子会话继承 audit 预设并同样被接管）。
5. 强制层日志：`~/.dsh/audit-mode/enforce.jsonl`（只写 DSH home，不写被审库）。

## 目录

```
audit-mode-preset 内容在本仓库根：
  cordis.patch.yml   预设声明 + 宿主 enforce 行
  enforce.js         宿主级强制层
  tools/             审核工具（复制到审核工作区做 审核工具/）
    ├─ 会话审计.mjs / 检查要求台账.mjs / 生成转交.mjs
    ├─ 跑评测.mjs + 评测集/   （已知红/绿用例）
    ├─ 巡检.mjs + 巡检配置.example.json
    ├─ 审核报告模板.md / 转交模板.md / REVIEW模板.md / 预审模板.md
    └─ 检查审核欠账.py（finding 口径的欠账台账校验）
```

## 自证

```bash
node enforce.js --self-test        # 23 个策略样本
node tools/跑评测.mjs              # 11 条已知用例
node tools/巡检.mjs --self-test
node tools/生成转交.mjs --self-test
```

## 本地自检

```bash
bash 自检.sh
```

## 归因

- `enforce.js` 的宿主级 restrict/guard 结构参考 [dsh-qa-preset](https://github.com/taoggt/dsh-qa-preset)（MIT）——见 `NOTICE`。
- 审核流程（风险分级/human approval/finding 复核/收敛/事故→评测集）参考 Anthropic Claude Code 团队的 [How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/)（2026-10-15）。
- 本仓库代码：MIT（见 `LICENSE`）。

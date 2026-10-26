# Security

## 这个预设是什么

`dsh-audit-mode` 是一个 **DeepSeek Harness Agent Preset**（含一个宿主级 enforce 插件）。Preset 是代码：安装即在 Host 进程里执行，信任等级等同于 shell 访问。只在你信任本仓库内容时安装。

## 它试图保证什么

对 `agentPreset = audit` 的会话：

1. 非白名单工具从模型请求中隐藏（`tools.restrict`），漏网执行由 `tools.guard` 拒绝；
2. 写类工具（write/edit）的目标路径必须位于**会话工作目录**（审核方工作区）内；
3. shell 命令中明显的“写工作区外 / 系统级变更（sudo/安装/服务）/ 写 DSH 状态目录”会被拒绝；
4. 每次 allow/deny 写 `~/.dsh/audit-mode/enforce.jsonl`，可回放。

## 它**不**保证什么

- **不是沙箱**：bash 静态检查只看命令字符串，脚本内部用绝对路径写盘它看不见。真正的写边界仍由会话的 sandbox 权限模式（read-only / workspace-write）与被审对象的位置决定。
- **不保证会话工作目录一定正确**：如果审核会话开在被审库目录里，允许写的根就是被审库。**必须把审核会话开在审核方工作区。**
- **不保证子会话**：`subagent` / `subagent_fork` 默认继承 audit 预设并同样被接管；`spawn_teammate` 被拒绝，因为 Team 可能生成不受本预设约束的会话。
- **不判断内容对错**：它只做程序性/证据性审查；内容正确性需要人。

## 报告漏洞

请开 GitHub Issue（或私信仓库维护者）。请不要在公开 Issue 里粘贴敏感路径、会话日志或凭据。

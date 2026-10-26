# Changelog

## 0.1.0 — 2026-10-26

首个可运行版本：

- **预设** `audit`（显示名「审核模式」）：persona（只读监督 / 读者分层 / 转交 / 不教学）、读写工具、搜索、后台任务、skill、subagent 委派、plan、压缩；成本调优（readLimit 1000 / 600 字符 / 40KB；glob 50 / grep 50 / 行宽 500）。
- **宿主级 enforce**（`enforce.js`）：只对 `agentPreset = audit` 生效；工具白名单 + `tools.guard` + 写路径检查 + bash 静态检查 + JSONL 审计日志；Team spawn 拒绝。
- **工具**：会话审计、要求台账校验、欠账校验（finding 口径）、评测集（11 条已知红/绿用例）、巡检、转交件生成、报告/REVIEW/预审/转交模板。
- **文档**：README、SECURITY、NOTICE（dsh-qa-preset 与 Anthropic 文章归因）、MIT LICENSE。

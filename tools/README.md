# 审核工具（只读）

> 配合 `dsh-audit-mode` 预设使用。原则：**可以读被审对象的一切（工作区/仓库/git 历史/产物/DSH 会话日志），但不能写它**；写只限审核方自己的工作区。
>
> 本目录在仓库里叫 `tools/`；复制到你的审核方工作区后建议命名为 **`审核工具/`**（预设 persona 里的命令按这个名字写）。仓库内自测时命令前缀用 `tools/`，工作区里换成 `审核工具/`。

## 0. 宿主级强制层（预设自带，已启用）

预设的 `enforce.js` 在宿主层对 `agentPreset = audit` 的会话做：非白名单工具隐藏/拒绝、写类工具路径必须在审核工作区、shell 静态检查、JSONL 日志（`~/.dsh/audit-mode/enforce.jsonl`）、Team spawn 拒绝。**审核会话必须开在审核方工作区。**

## 1. 会话审计（`会话审计.mjs`）

```bash
node tools/会话审计.mjs --cwd /被审/工作区 --limit 3
node tools/会话审计.mjs --cwd /被审/工作区 \
  --forbid '/审核工作区|10_审计方的要求' \
  --must-read '10_审计方的要求|01_轮次' \
  --must-run '审核自检|检查交接通道'
node tools/会话审计.mjs --list
node tools/会话审计.mjs --self-test
```

输出：cwd/preset/permission、要求候选、写动作、命令、红线（`FORBIDDEN_WRITE`/`MISSING_READ`/`MISSING_RUN`）与提醒（`CLAIM_NO_TOOL`）。
退出码：0 无红线 / 1 有红线 / 2 没验成 / 3 崩。**这是线索生成器，不是判决器。**

## 2. 要求台账（`检查要求台账.mjs` + `要求台账.template.json`）

```bash
cp tools/要求台账.template.json 要求台账.json
node tools/检查要求台账.mjs --ledger 要求台账.json --root .
```

核「对话里的要求→纪律落点→版本」；退出码 0 全入册 / 4 只有计划内缺口 / 1 不合格 / 2 找不到 / 3 崩。

## 3. 转交件生成（`生成转交.mjs` + `findings.example.json`）

```bash
node tools/生成转交.mjs --findings findings.json \
  --out ../要求/00_给开发agent的转述提示词_<轮次>.md
```

每条 finding：`file:line` / 现象 / 复现命令 / 期望 vs 实际 / 修法方向（不给补丁）/ 验证命令 / 禁止事项。`--out` 只允许写审核方工作区或临时目录。

## 4. 评测集（`跑评测.mjs` + `评测集/`）

```bash
node tools/跑评测.mjs          # 11 条已知用例；0 / 1 / 2 / 3
node tools/跑评测.mjs --list
```

`kind=clean` 红了=假红；`kind=defect` 绿了=漏检。新缺陷/漏检确认后**长成一条用例**。

## 5. 巡检（`巡检.mjs` + `巡检配置.example.json`）

```bash
cp tools/巡检配置.example.json tools/巡检配置.json   # 改成你的被审库/状态源
node tools/巡检.mjs
node tools/巡检.mjs --update-baseline   # “已看过”，不代表已修
node tools/巡检.mjs --self-test
```

巡检：被审库自上次以来的提交（敏感路径=判据/生成器/答案键/CI/纪律）、状态源是否落后 HEAD、欠账是否增加、新会话。0 无红线 / 1 有红线 / 2 没验成。

## 6. 模板

- `审核报告模板.md`：读者分层（修的人 vs 决策的人）、finding 表、转交件指针、决策页、没查什么必填。
- `转交模板.md`：给修的人的交接件格式。
- `REVIEW模板.md`：项目侧审核标准卡（失败长什么样/必查/可跳过/nit 上限/证据格式/敏感路径）。
- `预审模板.md`：干活方交付前自检表。

## 7. 自证

```bash
node enforce.js --self-test        # 仓库根（强制层策略）
node tools/跑评测.mjs
node tools/巡检.mjs --self-test
node tools/生成转交.mjs --self-test
```

## 8. 已知边界

- 只能看有日志的会话；别的机器 / 别的 profile / 手工操作看不到。
- 会话日志敏感：先限定项目/时间/session，报告只引最小片段。
- 语义等价（“记进去了”是不是那条要求）机器不判，第二模型或人判。
- 目的对齐需要可执行验收；没有验收线只能报 2。
- 巡检的“敏感路径”是启发式：命中只代表值得人看一眼，不是缺陷。

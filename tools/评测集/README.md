# 审核评测集

> 来源：Claude Code 团队把“事故、回退、用户反馈”变成每天跑的评测集；**审核方自己的判据也要被同一套方式考核**。

## 一条用例是什么

```json
{
  "id": "ledger-missing-discipline-fixture",
  "kind": "defect",
  "title": "持久性要求只在对话里、没进纪律（应 4，不能绿）",
  "command": "node tools/检查要求台账.mjs --ledger tools/评测集/fixtures/ledger-missing-discipline.json --root .",
  "expect_exit": 4,
  "source": "P1 夹具（历史形态：要求只在对话里）",
  "note": "对应『对话中的要求没记入纪律』"
}
```

| kind | 期望 | 不符合时叫什么 |
|---|---|---|
| `clean` | 退 0 | **假红**（误报） |
| `defect` | 退非 0 | 退 0 = **漏检**；其它码 = 口径漂移 |
| `known-debt` | 退 4 | 欠账口径漂移 |
| `env-limit` | 退 2 | 没验成口径漂移 |

## 怎么跑

```bash
node tools/跑评测.mjs
node tools/跑评测.mjs --list
node tools/跑评测.mjs --json
node tools/跑评测.mjs --case debt-ledger-ignored-is-debt
```

退出码：`0` 全部符合期望 ／ `1` 有不符合 ／ `2` 找不到评测集 ／ `3` 崩。

## 怎么长

1. **每发现一个新缺陷/新漏检**：把它的最小形态做成夹具，加一条 `defect` 用例（必须红）。
2. **每修一个假红**：把“已知该绿”的形态做成夹具，加一条 `clean` 用例（必须绿）。
3. 用户反馈、事故、回退之后：确认一条 → 长一条用例。
4. 改判据/改提示词/改阈值后：**重跑全量**；记下假红率、漏检率、轮次。

## 指标怎么读

- **假红率** = clean 用例失败数 / clean 用例数（越高越吵，会让人不信任审核）。
- **漏检率** = defect 用例退 0 数 / defect 用例数（越高说明判据越像橡皮图章）。
- **轮次**（rounds-to-pass）不在本评测集统计：它记在 [审核报告模板.md](../审核报告模板.md) §6。
- 本评测集通过 **≠ 没有漏检**：它只覆盖“已知失败形态”。

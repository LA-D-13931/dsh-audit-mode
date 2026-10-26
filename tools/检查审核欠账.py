#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""审核欠账校验（r18）—— 让「我说要核/要修但没核没修」机器可见。

**口径**（与开发方 r17 那条同源，我这边加了分层）：

- `candidate` ⇒ **报欠账**（欠账不是状态，是失败）；
- `candidate` 必须带**可执行 plan**（不许"待排期"这种挂账）；
- `done` 必须带 `landed_at`；
- `skip` 必须带**可核理由**（指到具体内容/命令/路径，不许空话）；
- **退出码分层**：`0` 无欠账 ／ **`4` 只有计划内欠账** ／ `1` 台账不合格 ／ `3` 脚本崩。
  ⇒ 把 1/3 留给**计划外失败**，避免"红与红长得一样"（一条永远红的段落盖住新的红）。

用法：`python3 检查审核欠账.py [--ledger 路径]`
"""
import argparse
import json
import os
import re
import sys

DEFAULT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "审核欠账.json")
CONCRETE = re.compile(r"`[^`]+`|L\d\d-S\d+|r\d\d|\.py|\.json|\.sh|\.md|\d")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ledger", default=DEFAULT)
    a = ap.parse_args()
    if not os.path.exists(a.ledger):
        print("找不到台账：%s" % a.ledger)
        return 3
    d = json.load(open(a.ledger, encoding="utf-8"))
    items = d.get("items", [])
    if not items:
        print("台账是空的 —— 那要么真没欠账，要么没人填（自己判）")
        return 4
    bad, debt = [], []
    st = {}
    for it in items:
        st[it.get("status")] = st.get(it.get("status"), 0) + 1
        i = it.get("id", "?")
        stx = it.get("status")
        if stx == "candidate":
            if not (it.get("plan") or "").strip():
                bad.append("%s：candidate 但没有 plan（挂账不许不带排期）" % i)
            else:
                debt.append("%s：%s" % (i, it["plan"]))
        elif stx == "done":
            if not (it.get("landed_at") or "").strip():
                bad.append("%s：done 但没有 landed_at" % i)
        elif stx == "skip":
            r = it.get("skip_reason") or ""
            if not CONCRETE.search(r):
                bad.append("%s：skip 理由不达标（必须指到具体内容/命令/路径）→ %r" % (i, r[:40]))
        elif stx == "wrong":
            # 审核方判错、已撤回：必须留撤回时间 + 可核理由/引文
            if not (it.get("retracted_at") or "").strip():
                bad.append("%s：wrong 但没有 retracted_at" % i)
            r = it.get("retract_reason") or it.get("reason") or ""
            if not CONCRETE.search(r):
                bad.append("%s：wrong 的撤回理由不达标（指到具体证据/命令）→ %r" % (i, r[:40]))
        elif stx == "intentional":
            # 对方有意为之、审核方接受：必须给可核理由 + 由谁确认
            r = it.get("reason") or it.get("skip_reason") or ""
            if not CONCRETE.search(r):
                bad.append("%s：intentional 理由不达标（指到具体内容/命令）→ %r" % (i, r[:40]))
            if not (it.get("by") or it.get("accepted_by") or "").strip():
                bad.append("%s：intentional 但没有 by/accepted_by（谁确认的）" % i)
        elif stx == "ignored":
            # 对方未回应/未修：仍开放，计入欠账
            if not isinstance(it.get("age_rounds"), int) or it["age_rounds"] < 1:
                bad.append("%s：ignored 但没有 age_rounds（挂了几轮，必须≥1）" % i)
            else:
                debt.append("%s：ignored %d 轮未回应" % (i, it["age_rounds"]))
        else:
            bad.append("%s：status 只能是 candidate/done/skip/wrong/intentional/ignored（现在是 %r）" % (i, stx))
        # 可选字段：严重度/标签（给了就校验）
        if "severity" in it and it["severity"] not in ("Blocker", "Major", "Minor", "Nit"):
            bad.append("%s：severity 只能是 Blocker/Major/Minor/Nit" % i)
        if "tag" in it and it["tag"] not in ("Introduced", "Pre-existing", "Nit"):
            bad.append("%s：tag 只能是 Introduced/Pre-existing/Nit" % i)
    print("=== 审核欠账台账 ===")
    print("条目 %d ｜ 关闭 done %d / wrong %d / intentional %d / skip %d ｜ 开放 candidate %d / ignored %d"
          % (len(items), st.get("done", 0), st.get("wrong", 0), st.get("intentional", 0),
             st.get("skip", 0), st.get("candidate", 0), st.get("ignored", 0)))
    if bad:
        print("\n── 台账不合格 %d 条 ──" % len(bad))
        for b in bad:
            print("  ✗ " + b)
        return 1
    if debt:
        print("\n── **欠账 %d 条**（这不是状态，是失败）──" % len(debt))
        for x in debt:
            print("  ✗ " + x)
        print("\n退出码 4 = 只有计划内欠账（1/3 留给计划外失败）")
        return 4
    print("\n✓ 没有欠账")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print("检查器崩了：%r" % (e,))
        sys.exit(3)

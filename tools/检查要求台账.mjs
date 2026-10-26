#!/usr/bin/env node
/**
 * 要求台账校验（只读）—— 核「对话里说过的要求，有没有真的记进纪律」。
 *
 * 台账是人工/agent 填的，本脚本只做结构 + 落点 + 缺口核验，不判断语义等价
 * （语义核对由第二个模型或人做，写进 checked_by）。
 *
 * 用法：
 *   node tools/检查要求台账.mjs [--ledger 要求台账.json] [--root .]
 *   node tools/检查要求台账.mjs --self-test
 *
 * 退出码：0 全部入册 ／ 4 只有计划内缺口（未入册/矛盾，结构合格）／ 1 台账不合格 ／ 2 找不到台账 ／ 3 崩
 *
 * 规则：
 *   - 每条：id 唯一、requirement 非空、source.kind ∈ conversation|document|user_decision、source.quote 非空；
 *   - source.kind=conversation ⇒ 必须有 source.session + source.time；
 *   - status ∈ landed|partial|missing|contradicted；
 *   - landed/partial ⇒ landing.file 必填且文件存在，landing.version 或 landing.section 必填；
 *   - 持久性要求（以后/每轮/必须/不许/禁止/一律…）⇒ 不许停在 missing/contradicted，必须有 landing；
 *   - missing/contradicted 计入欠账（退出码 4，不是 1）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PERSIST_RE = /(以后|今后|每轮|每次|必须|务必|不许|禁止|不能|一律|纪律|铁律|长期)/;
const SOURCE_KINDS = new Set(["conversation", "document", "user_decision"]);
const STATUSES = new Set(["landed", "partial", "missing", "contradicted"]);

function parseArgs(argv) {
  const o = { ledger: "要求台账.json", root: ".", json: false, selfTest: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(a + " 缺少参数"); return argv[++i]; };
    switch (a) {
      case "--ledger": o.ledger = next(); break;
      case "--root": o.root = next(); break;
      case "--json": o.json = true; break;
      case "--self-test": o.selfTest = true; break;
      case "-h": case "--help":
        console.log("用法：node 检查要求台账.mjs [--ledger 路径] [--root 项目根] [--json] [--self-test]");
        process.exit(0);
      default: throw new Error("未知参数：" + a);
    }
  }
  return o;
}

function validate(text, opts) {
  const invalid = [];
  const debt = [];
  let data;
  try { data = JSON.parse(text); } catch (e) { invalid.push("不是合法 JSON：" + e.message); return { invalid, debt, items: [] }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) { invalid.push("顶层必须是对象"); return { invalid, debt, items: [] }; }
  if (!Array.isArray(data.items)) { invalid.push("缺少 items 数组"); return { invalid, debt, items: [] }; }
  const seen = new Set();
  data.items.forEach((it, idx) => {
    const at = "items[" + idx + "]" + (it && it.id ? "(" + it.id + ")" : "");
    if (!it || typeof it !== "object") { invalid.push(at + " 不是对象"); return; }
    if (!it.id || typeof it.id !== "string") invalid.push(at + " 缺 id");
    else if (seen.has(it.id)) invalid.push(at + " id 重复");
    else seen.add(it.id);
    if (!it.requirement || typeof it.requirement !== "string") invalid.push(at + " 缺 requirement 原文");
    const src = it.source || {};
    if (!SOURCE_KINDS.has(src.kind)) invalid.push(at + " source.kind 必须是 conversation/document/user_decision");
    if (!src.quote || typeof src.quote !== "string") invalid.push(at + " 缺 source.quote（要求原文）");
    if (src.kind === "conversation") {
      if (!src.session || !src.time) invalid.push(at + " conversation 来源必须有 source.session 与 source.time");
    }
    const st = it.status;
    if (!STATUSES.has(st)) invalid.push(at + " status 必须是 landed/partial/missing/contradicted");
    const landing = it.landing || {};
    if ((st === "landed" || st === "partial")) {
      if (!landing.file) invalid.push(at + " 已入册却缺 landing.file");
      else {
        const p = path.resolve(opts.root, landing.file);
        if (!fs.existsSync(p)) invalid.push(at + " landing.file 不存在：" + landing.file);
      }
      if (!landing.version && !landing.section) invalid.push(at + " landing 缺 version 或 section");
    }
    // 持久性要求如果声称已入册/部分入册，落点检查已在上面的 landing 分支里；
    // 若 status 是 missing/contradicted，则计入欠账（退出码 4），不当作台账结构错误。
    if (st === "missing" || st === "contradicted") debt.push(it.id + "：" + st + "（" + (it.requirement || "").slice(0, 50) + "）");
    if (!it.checked_at) invalid.push(at + " 缺 checked_at");
  });
  if (!data.items.length) debt.push("台账为空（要么真没要求，要么没人填——自己判）");
  return { invalid, debt, items: data.items };
}

function printReport(r, label) {
  console.log("=== 要求台账校验（" + label + "）===");
  console.log("条目 " + r.items.length + " ｜ 不合格 " + r.invalid.length + " ｜ 欠账 " + r.debt.length);
  if (r.invalid.length) {
    console.log("\n-- 不合格（结构/落点）--");
    for (const x of r.invalid) console.log("  ✗ " + x);
  }
  if (r.debt.length) {
    console.log("\n-- 欠账（未入册/矛盾，计划内缺口）--");
    for (const x of r.debt) console.log("  ⚠️ " + x);
  }
  if (!r.invalid.length && !r.debt.length) console.log("  ✓ 全部入册");
}

function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-check-"));
  const fsx = fs;
  try {
    fsx.mkdirSync(path.join(root, "纪律"), { recursive: true });
    fsx.writeFileSync(path.join(root, "纪律", "AGENTS.md"), "# 纪律\n- 以后每轮必须跑自检\n");
    const base = (over = {}) => ({
      version: 1,
      items: [{
        id: "R-1",
        requirement: "以后每轮必须跑审核自检",
        source: { kind: "conversation", session: "s1", time: "2026-10-25T16:00+08:00", quote: "以后每轮必须跑审核自检" },
        landing: { file: "纪律/AGENTS.md", section: "§1", version: "2026-10-25" },
        status: "landed",
        checked_at: "2026-10-25T16:30+08:00",
        ...over,
      }],
    });
    const cases = [];
    const good = validate(JSON.stringify(base()), { root });
    if (good.invalid.length || good.debt.length) cases.push("绿样本被误报：" + [...good.invalid, ...good.debt].join("；"));
    const missingLanding = validate(JSON.stringify(base({ landing: {}, status: "landed" })), { root });
    if (!missingLanding.invalid.length) cases.push("红样本①没红（缺落点）");
    const debtOnly = validate(JSON.stringify(base({ landing: {}, status: "missing", requirement: "以后补一个检查" })), { root });
    if (debtOnly.invalid.length || debtOnly.debt.length !== 1) cases.push("红样本②没区分「结构不合格」（0 条）与「欠账」（1 条）");
    const badKind = validate(JSON.stringify(base({ source: { kind: "chat", quote: "x" } })), { root });
    if (!badKind.invalid.length) cases.push("红样本③没红（来源类型非法）");
    if (cases.length) { console.log("❌ 自检失败：\n  - " + cases.join("\n  - ")); return 3; }
    console.log("✓ 自检通过：绿样本 0 不合格/0 欠账；红样本分别命中「缺落点 / 欠账分层 / 来源非法」");
    return 0;
  } catch (e) {
    console.log("❌ 自检崩了：" + (e && e.stack || e));
    return 3;
  } finally {
    try { fsx.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.selfTest) return selfTest();
  if (!fs.existsSync(opts.ledger)) {
    console.log("找不到台账：" + opts.ledger + "（先照 要求台账.template.json 建一份）⇒ 没验成");
    return 2;
  }
  const r = validate(fs.readFileSync(opts.ledger, "utf8"), opts);
  if (opts.json) {
    console.log(JSON.stringify({ ...r, exit: r.invalid.length ? 1 : (r.debt.length ? 4 : 0) }, null, 2));
    return r.invalid.length ? 1 : (r.debt.length ? 4 : 0);
  }
  printReport(r, opts.ledger);
  if (r.invalid.length) return 1;
  if (r.debt.length) return 4;
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.log("台账校验崩了：" + (e && e.stack || e));
  process.exit(3);
}

#!/usr/bin/env node
/**
 * 跑评测（审核评测集）—— 用「已知红/已知绿」的用例给审核判据记分。
 *
 * 每条用例 = 一个可跑命令 + 期望退出码：
 *   kind=clean      期望 0；红了 ⇒ **假红**（误报）
 *   kind=defect     期望非 0；绿了 ⇒ **漏检**（false negative）
 *   kind=known-debt 期望 4（只有计划内欠账）
 *   kind=env-limit  期望 2（没验成）
 *
 * 用法：
 *   node tools/跑评测.mjs [--json] [--list] [--case <id>] [--timeout-ms N]
 * 退出码：0 全部符合期望 ／ 1 有不符合 ／ 2 找不到评测集/夹具 ／ 3 崩
 *
 * 说明：历史缺陷、漏检、用户反馈确认后都要长成一条用例——这是文章的
 * “incidents become an eval set”；改判据/改提示后必须重跑本评测集。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CASES = path.join(HERE, "评测集", "cases.json");

function parseArgs(argv) {
  const o = { json: false, list: false, only: [], timeoutMs: 240000 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(a + " 缺少参数"); return argv[++i]; };
    switch (a) {
      case "--json": o.json = true; break;
      case "--list": o.list = true; break;
      case "--case": o.only.push(next()); break;
      case "--timeout-ms": o.timeoutMs = Number(next()); break;
      case "-h": case "--help":
        console.log("用法：node 跑评测.mjs [--json] [--list] [--case id] [--timeout-ms N]");
        process.exit(0);
      default: throw new Error("未知参数：" + a);
    }
  }
  return o;
}

function runCase(c, timeoutMs) {
  const started = Date.now();
  const r = spawnSync("/bin/bash", ["-lc", c.command], {
    cwd: ROOT, encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
  });
  const actual = r.status === null ? -1 : r.status;
  return {
    id: c.id, kind: c.kind, title: c.title, command: c.command,
    expect: c.expect_exit, actual, ok: actual === c.expect_exit,
    ms: Date.now() - started,
    stderrTail: (r.stderr || "").trim().split("\n").slice(-4).join("\n"),
  };
}

function classify(c, actual) {
  if (c.kind === "clean") return "假红（clean 用例没绿）";
  if (c.kind === "defect") return actual === 0 ? "漏检（defect 用例没红）" : "退出码与期望不符";
  if (c.kind === "known-debt") return "欠账口径漂移（应 4）";
  if (c.kind === "env-limit") return "没验成口径漂移（应 2）";
  return "退出码与期望不符";
}

function main() {
  const opts = parseArgs(process.argv);
  if (!fs.existsSync(CASES)) {
    console.log("找不到评测集：" + CASES + " ⇒ 没验成");
    return 2;
  }
  const data = JSON.parse(fs.readFileSync(CASES, "utf8"));
  let cases = Array.isArray(data.cases) ? data.cases : [];
  if (opts.only.length) cases = cases.filter((c) => opts.only.includes(c.id));
  if (!cases.length) {
    console.log("没有可跑的用例 ⇒ 没验成");
    return 2;
  }
  if (opts.list) {
    for (const c of cases) console.log(`${c.id}  kind=${c.kind}  expect=${c.expect_exit}  ${c.title}`);
    return 0;
  }

  const results = cases.map((c) => runCase(c, opts.timeoutMs));
  const bad = results.filter((r) => !r.ok);
  const fp = results.filter((r) => !r.ok && r.kind === "clean");
  const fn = results.filter((r) => !r.ok && r.kind === "defect" && r.actual === 0);
  const drift = bad.filter((r) => !fp.includes(r) && !fn.includes(r));
  const cleanN = results.filter((r) => r.kind === "clean").length;
  const defectN = results.filter((r) => r.kind === "defect").length;

  if (opts.json) {
    console.log(JSON.stringify({
      total: results.length, pass: results.length - bad.length,
      false_positive: fp.length, false_negative: fn.length, drift: drift.length,
      false_positive_rate: cleanN ? fp.length / cleanN : null,
      false_negative_rate: defectN ? fn.length / defectN : null,
      results, exit: bad.length ? 1 : 0,
    }, null, 2));
    return bad.length ? 1 : 0;
  }

  console.log("=== 审核评测集 ===");
  console.log(`工作区：${ROOT}`);
  for (const r of results) {
    const mark = r.ok ? "✓" : "✗";
    console.log(`${mark} ${r.id}  kind=${r.kind}  expect=${r.expect} actual=${r.actual}  (${r.ms}ms)`);
    if (!r.ok) {
      console.log(`    ${classify(r, r.actual)}`);
      console.log(`    $ ${r.command}`);
      if (r.stderrTail) console.log("    stderr: " + r.stderrTail.replace(/\n/g, "\n            "));
    }
  }
  console.log("\n-- 汇总 --");
  console.log(`  用例 ${results.length} ｜ 通过 ${results.length - bad.length} ｜ 失败 ${bad.length}`);
  console.log(`  假红 ${fp.length}${cleanN ? `（${(fp.length / cleanN * 100).toFixed(1)}% of clean）` : ""}`
    + ` ｜ 漏检 ${fn.length}${defectN ? `（${(fn.length / defectN * 100).toFixed(1)}% of defect）` : ""}`
    + ` ｜ 口径漂移 ${drift.length}`);
  if (bad.length) {
    console.log("  ⇒ 退出码 1：先把失败用例逐条核（假红/漏检都要留痕），再改判据");
    return 1;
  }
  console.log("  ✓ 全部符合期望（这只能说明“已知用例没退步”，不等于没漏检）");
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.log("评测跑崩了：" + (e && e.stack || e));
  process.exit(3);
}

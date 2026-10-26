#!/usr/bin/env node
/**
 * 生成转交（审核模式 → 修的人 / 开发 agent）。
 *
 * 从 findings.json 生成「给开发 agent 的转交提示词」：可执行、可复现、最小上下文。
 * 不是教学材料；不写补丁，只给修法方向与验证命令。
 *
 * 用法：
 *   node tools/生成转交.mjs --findings findings.json [--out <审核方工作区内路径>]
 *   node tools/生成转交.mjs --self-test
 * 退出码：0 成功 ／ 1 findings 不合格 ／ 2 找不到文件 ／ 3 崩
 *
 * 写入边界：--out 只允许落在当前工作区（审核方工作区）或系统临时目录内；
 * 拒绝写被审库/其它路径（防“顺手写到被审对象里”）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEV_RANK = { Blocker: 0, Major: 1, Minor: 2, Nit: 3 };
const TAGS = new Set(["Introduced", "Pre-existing", "Nit"]);
const REQUIRED = ["id", "severity", "tag", "location", "phenomenon", "evidence", "expected", "fixDirection", "verifyCommand"];

function parseArgs(argv) {
  const o = { findings: "tools/findings.json", out: null, json: false, selfTest: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(a + " 缺少参数"); return argv[++i]; };
    switch (a) {
      case "--findings": o.findings = next(); break;
      case "--out": o.out = next(); break;
      case "--json": o.json = true; break;
      case "--self-test": o.selfTest = true; break;
      case "-h": case "--help":
        console.log("用法：node 生成转交.mjs --findings findings.json [--out 目标.md] [--json] [--self-test]");
        process.exit(0);
      default: throw new Error("未知参数：" + a);
    }
  }
  return o;
}

function validate(data) {
  const bad = [];
  if (!data || typeof data !== "object") return { bad: ["顶层必须是对象"] , meta: {}, items: [] };
  const items = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : null);
  if (!items) return { bad: ["缺少 items 数组（或直接传数组）"], meta: {}, items: [] };
  const meta = (!Array.isArray(data) && data.meta) || {};
  const seen = new Set();
  items.forEach((it, idx) => {
    const at = `items[${idx}]` + (it && it.id ? `(${it.id})` : "");
    if (!it || typeof it !== "object") { bad.push(at + " 不是对象"); return; }
    for (const k of REQUIRED) {
      if (!it[k] || typeof it[k] !== "string" || !it[k].trim()) bad.push(at + ` 缺 ${k}`);
    }
    if (it.id) {
      if (seen.has(it.id)) bad.push(at + " id 重复");
      else seen.add(it.id);
    }
    if (!(it.severity in SEV_RANK)) bad.push(at + " severity 只能是 Blocker/Major/Minor/Nit");
    if (!TAGS.has(it.tag)) bad.push(at + " tag 只能是 Introduced/Pre-existing/Nit");
    if (it.response && !["fixed", "wrong", "intentional", "ignored"].includes(it.response)) bad.push(at + " response 非法");
    if (it.status && !["open", "closed"].includes(it.status)) bad.push(at + " status 只能是 open/closed");
    if (it.forbid && !(typeof it.forbid === "string" || Array.isArray(it.forbid))) bad.push(at + " forbid 必须是字符串或数组");
  });
  return { bad, meta, items: items.sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9)) };
}

function bullets(x) {
  return (Array.isArray(x) ? x : (x ? [x] : [])).map((s) => "- " + s).join("\n");
}

function buildMarkdown(data) {
  const { meta, items } = validate(data);
  const lines = [];
  lines.push("# 给开发 agent 的转交提示词（审核模式生成）", "");
  lines.push("> 读者：负责修的 agent。要求可执行/可复现/最小上下文；本件不教学、不含补丁。", "");
  lines.push("## 0. 取样（修之前先核）", "");
  lines.push(`- 轮次 / 要求版本：${meta.round || "?"} / ${meta.requirementVersion || "?"}`);
  lines.push(`- 冻结 HEAD：${meta.frozenHead || "?"}`);
  lines.push(`- 工作树：${meta.worktree || "?"}`);
  lines.push(`- 本轮审核报告：${meta.reportPath || "?"}`);
  lines.push(`- 转交时间：${meta.generatedAt || new Date().toISOString()}`, "");
  lines.push(`## 1. 本轮要修（${items.length} 条，按严重度排序）`, "");
  for (const it of items) {
    lines.push(`### ${it.id} · [${it.severity}] · ${it.tag} · \`${it.location}\``, "");
    lines.push(`- **现象**：${it.phenomenon}`);
    lines.push(`- **证据**：${it.evidence}`);
    lines.push(`- **期望**：${it.expected}`);
    lines.push(`- **修法方向**：${it.fixDirection}`);
    lines.push(`- **验证命令**：\`${it.verifyCommand}\``);
    if (it.forbid) lines.push(`- **禁止**：\n${bullets(it.forbid)}`);
    if (it.response) lines.push(`- 上轮回应：${it.response}（status: ${it.status || "?"}）`);
    lines.push("");
  }
  lines.push("## 2. 本轮不要动", "");
  lines.push("- 范围外文件 / 冻结的判据 / 已通过项：见审核报告 §6");
  lines.push("- 已知假红（不是缺陷，别修）：见审核报告 §6", "");
  lines.push("## 3. 交付要求（不满足就不算完成）", "");
  lines.push("- 每条 finding 逐条回答：fixed / intentional / 不同意（附复现命令）");
  lines.push("- 证据：命令 + 原始输出 + 退出码；**不许只写「已通过」**");
  lines.push("- 冻结 commit + 工作树干净；回复带轮次戳");
  lines.push("- 新发现的需求/缺口写进需求登记，不要静默绕过", "");
  lines.push("## 4. 未关闭 / 不计入本轮", "");
  lines.push("- Pre-existing（历史遗留，单独立项，不算本轮引入）：见 §1 标签");
  lines.push("- ignored（上轮未回应）：见 §1 回应");
  lines.push("- 没验成（2）：见审核报告 §6");
  return lines.join("\n");
}

function checkOutPath(out) {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const WORKSPACE = path.resolve(HERE, "..");
  const abs = path.resolve(out);
  const realish = (p) => {
    try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); }
    catch { return p; }
  };
  const roots = [WORKSPACE, os.tmpdir(), "/tmp", "/private/tmp"]
    .map((r) => { try { return fs.realpathSync(r); } catch { return path.resolve(r); } });
  const cand = realish(abs);
  if (!roots.some((r) => cand === r || cand.startsWith(r + path.sep))) {
    throw new Error(`拒绝写入工作区/临时目录之外：${abs}（审核方只写自己的区）`);
  }
  return abs;
}

function selfTest() {
  const problems = [];
  try {
    const good = {
      meta: { round: "rX", frozenHead: "abc1234" },
      items: [{
        id: "F-1", severity: "Blocker", tag: "Introduced", location: "a.py:1",
        phenomenon: "p", evidence: "e", expected: "x", fixDirection: "f", verifyCommand: "cmd",
      }],
    };
    const md = buildMarkdown(good);
    if (!/## 1\. 本轮要修（1 条/.test(md)) problems.push("绿样本没生成条目");
    if (!/验证命令/.test(md) || !/a\.py:1/.test(md)) problems.push("绿样本缺关键字段");
    const bad = { items: [{ ...good.items[0], verifyCommand: "" }] };
    const v = validate(bad);
    if (!v.bad.some((b) => /verifyCommand/.test(b))) problems.push("红样本没命中缺 verifyCommand");
    const badSev = { items: [{ ...good.items[0], severity: "Critical" }] };
    if (!validate(badSev).bad.length) problems.push("红样本没命中非法 severity");
    if (problems.length) {
      console.log("❌ 生成转交自检失败：\n  - " + problems.join("\n  - "));
      return 3;
    }
    console.log("✓ 生成转交自检通过：绿样本 1 条可生成；红样本命中缺字段/非法严重度");
    return 0;
  } catch (e) {
    console.log("❌ 生成转交自检崩了：" + (e && e.stack || e));
    return 3;
  }
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.selfTest) return selfTest();
  if (!fs.existsSync(opts.findings)) {
    console.log("找不到 findings 文件：" + opts.findings + "（示例见 tools/findings.example.json）⇒ 没验成");
    return 2;
  }
  let data;
  try { data = JSON.parse(fs.readFileSync(opts.findings, "utf8")); }
  catch (e) { console.log("findings 不是合法 JSON：" + e.message); return 1; }
  const { bad, items } = validate(data);
  if (bad.length) {
    console.log("findings 不合格 " + bad.length + " 条：");
    for (const b of bad) console.log("  ✗ " + b);
    return 1;
  }
  if (!items.length) { console.log("findings 为空 —— 没有要转交的（也算没验成）"); return 2; }
  const md = buildMarkdown(data);
  if (opts.out) {
    let abs;
    try { abs = checkOutPath(opts.out); }
    catch (e) { console.log("拒绝：" + (e && e.message || e)); return 1; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, md + "\n", "utf8");
    console.log(`转交件已写：${abs}`);
    console.log(`条目 ${items.length}（Blocker ${items.filter((i) => i.severity === "Blocker").length} / Major ${items.filter((i) => i.severity === "Major").length} / Minor ${items.filter((i) => i.severity === "Minor").length} / Nit ${items.filter((i) => i.severity === "Nit").length}）`);
  } else {
    console.log(md);
  }
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.log("生成转交崩了：" + (e && e.message || e));
  process.exit(3);
}

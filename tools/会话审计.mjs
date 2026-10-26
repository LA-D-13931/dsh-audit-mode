#!/usr/bin/env node
/**
 * 会话审计（只读）—— 给「审核模式」用：独立看「干活的 agent」到底要了什么、读了什么、跑了什么、写了什么。
 *
 * 证据来源：DSH 自己的会话日志（不是被审 agent 的自报）
 *   ~/.dsh/sessions/<编码工作目录>/<session-id>/session.v4.jsonl.zstd
 *   日志是 zstd 多帧拼接的 JSONL；本脚本按帧解压（Node >= 22 自带 zstd）。
 *
 * 边界：
 *   - 只读。除了 --self-test 会在系统临时目录建夹具，任何情况下不写被审对象。
 *   - 隐私最小化：默认只输出截断片段（--max-excerpt）；--no-content 只出摘要。
 *
 * 用法：
 *   node tools/会话审计.mjs --cwd /被审/工作区 [--limit 3]
 *   node tools/会话审计.mjs --cwd /被审/工作区 --forbid '/被审/工作区' \
 *        --must-read '10_审计方的要求|01_轮次' --must-run '审核自检\.py|检查交接通道'
 *   node tools/会话审计.mjs --list
 *   node tools/会话审计.mjs --self-test          # 红/绿两个样本自证
 *
 * 退出码：0 没发现红线 ／ 1 发现红线或未达标 ／ 2 没验成（没有可读会话/帧解不开）／ 3 脚本崩
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  collectSessionFiles, readHeader, readSessionEvents, SUPPORTED_VERSION,
} from "./lib/sessionlog.mjs";
const REQUIRE_RE = /(以后|今后|每轮|每次|必须|务必|不许|禁止|不能|一律|要求|约定|纪律|铁律|记住|长期)/;
const CLAIM_RE = /(已完成|做完了|已修|修好|已跑|跑过|已验证|已验|已落|已补|已提交|已归档|通过|交付|done|fixed|passed)/i;
const WRITE_TOOL_NAMES = new Set([
  "write", "edit", "ops_write", "ops_edit", "str_replace_editor",
  "create_file", "apply_patch", "multi_edit",
]);
const BASH_WRITE_RE = /(^|[^0-9])>{1,2}\s*(?!&)|\btee\s+|\bsed\s+-i|\brm\s+|\bmv\s+|\bcp\s+|\bmkdir\s+|\btouch\s+|\btruncate\s+|\bdd\s+|\bgit\s+(add|commit|checkout|reset|stash|clean|rm)\b/;

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const o = {
    sessionsDir: path.join(os.homedir(), ".dsh", "sessions"),
    cwd: [], session: [], since: null, until: null, limit: 3,
    forbid: [], mustRead: [], mustRun: [], json: false, list: false,
    noContent: false, maxExcerpt: 120, selfTest: false, showTools: false,
    dumpEvents: false, limitEvents: 5000,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(a + " 缺少参数"); return argv[++i]; };
    switch (a) {
      case "--sessions-dir": o.sessionsDir = next(); break;
      case "--cwd": o.cwd.push(next()); break;
      case "--session": o.session.push(next()); break;
      case "--since": o.since = parseTime(next()); break;
      case "--until": o.until = parseTime(next()); break;
      case "--limit": o.limit = Number(next()); break;
      case "--forbid": o.forbid.push(new RegExp(next())); break;
      case "--must-read": o.mustRead.push(new RegExp(next())); break;
      case "--must-run": o.mustRun.push(new RegExp(next())); break;
      case "--max-excerpt": o.maxExcerpt = Number(next()); break;
      case "--json": o.json = true; break;
      case "--list": o.list = true; break;
      case "--no-content": o.noContent = true; break;
      case "--show-tools": o.showTools = true; break;
      case "--dump-events": o.dumpEvents = true; break;
      case "--limit-events": o.limitEvents = Number(next()); break;
      case "--self-test": o.selfTest = true; break;
      case "-h": case "--help": printHelp(); process.exit(0); break;
      default: throw new Error("未知参数：" + a);
    }
  }
  return o;
}

function parseTime(s) {
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error("时间格式读不懂：" + s);
  return t;
}

function printHelp() {
  console.log(`会话审计（只读）
  --cwd <路径>         只看这个工作目录的会话（可重复）
  --session <id>       只看这些 session id（可重复）
  --since/--until      时间范围（ISO 或 epoch ms）
  --limit N            最多看 N 个会话（默认 3）
  --forbid <正则>      禁止写入的目标（命中写动作 ⇒ 红线；可重复）
  --must-read <正则>   要求被读到的文件/命令（没出现 ⇒ 红线；可重复）
  --must-run <正则>    要求跑过的命令（没出现 ⇒ 红线；可重复）
  --max-excerpt N      片段最长字符（默认 120）
  --no-content         不输出原文片段
  --show-tools         打印工具调用样本（排查假红用）
  --dump-events        打印原始事件（JSONL；排查/交给别的工具）
  --limit-events N     每个会话最多打印 N 条事件（默认 5000）
  --json               机器可读输出
  --list               只列会话元信息
  --self-test          红/绿两个样本自证
退出码：0 无红线 ／ 1 有红线 ／ 2 没验成 ／ 3 崩`);
}

// ---------------------------------------------------------------- 事件归类

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c.type === "file" && c.attachment && c.attachment.name) parts.push("[file] " + c.attachment.name);
  }
  return parts.join("\n").trim();
}

function excerpt(s, max) {
  return String(s || "").replace(/\s+/g, " ").slice(0, max);
}

function callArgsText(tc) {
  const raw = tc.data && tc.data.arguments;
  if (typeof raw === "string") {
    try { return JSON.stringify(JSON.parse(raw)); } catch { return raw; }
  }
  try { return JSON.stringify(raw || {}); } catch { return ""; }
}

function commandOf(tc) {
  const raw = tc.data && tc.data.arguments;
  let args = raw;
  if (typeof raw === "string") { try { args = JSON.parse(raw); } catch { args = {}; } }
  if (!args || typeof args !== "object") return "";
  return [args.command, args.script_path, args.cmd].filter((x) => typeof x === "string").join(" \n ");
}

function targetPathsOf(tc) {
  const raw = tc.data && tc.data.arguments;
  let args = raw;
  if (typeof raw === "string") { try { args = JSON.parse(raw); } catch { args = {}; } }
  if (!args || typeof args !== "object") return [];
  const out = [];
  for (const k of ["path", "file_path", "filePath", "target", "dest", "destination"]) {
    if (typeof args[k] === "string") out.push(args[k]);
  }
  if (Array.isArray(args.files)) {
    for (const f of args.files) if (f && typeof f.path === "string") out.push(f.path);
  }
  return out;
}

function isWriteLike(tc) {
  if (WRITE_TOOL_NAMES.has(tc.data.name)) return true;
  if (tc.data.name === "bash" || tc.data.name === "ops_bash" || tc.data.name === "pwsh") {
    return BASH_WRITE_RE.test(commandOf(tc));
  }
  return false;
}

/** @returns 分析结果 */
function analyzeSession(file, meta, opts) {
  const { events } = readSessionEvents(file);
  const header = events.find((e) => e.type === "session") || meta || {};
  const permission = events.find((e) => e.type === "permission/preset");
  const toolCalls = events.filter((e) => e.type === "tool/call");
  const userMsgs = events.filter((e) => e.type === "user/message");
  const assistantMsgs = events.filter((e) => e.type === "assistant/message");
  const toolResults = events.filter((e) => e.type === "tool/result");

  const ctx = {
    sessionId: header.id || path.basename(path.dirname(file)),
    cwd: header.cwd || "",
    agentPreset: header.agentPreset || "",
    permission: permission && permission.data ? permission.data.preset : "",
    createdAt: header.createdAt || 0,
    file,
    events: events.length,
    counts: {
      user: userMsgs.length, assistant: assistantMsgs.length,
      toolCalls: toolCalls.length, toolResults: toolResults.length,
    },
    requirementCandidates: [],
    toolSamples: [],
    writes: [],
    commands: [],
    findings: [],
  };

  const max = opts.maxExcerpt || 120;
  const hideContent = !!opts.noContent;

  for (const m of userMsgs) {
    const text = contentText(m.data && m.data.content);
    if (!text) continue;
    if (REQUIRE_RE.test(text)) {
      ctx.requirementCandidates.push({
        time: m.time || 0,
        text: hideContent ? "（--no-content）" : excerpt(text, max),
      });
    }
  }

  const readText = [];
  const rawCommandTexts = [];
  for (const tc of toolCalls) {
    const argText = callArgsText(tc);
    const name = tc.data.name || "";
    if (name === "bash" || name === "ops_bash" || name === "pwsh") {
      const cmd = commandOf(tc);
      if (cmd) {
        rawCommandTexts.push(cmd);   // 匹配用原文；展示用截断/隐藏，二者分开
        ctx.commands.push({ name, cmd: hideContent ? "（--no-content）" : excerpt(cmd, max) });
      }
    }
    if (isWriteLike(tc)) {
      const targets = targetPathsOf(tc);
      const cmd = commandOf(tc);
      ctx.writes.push({
        name,
        target: hideContent ? "（--no-content）" : excerpt(targets.join(" ") || cmd, max),
        rawForMatch: targets.join("\n") + "\n" + cmd,
        rawForMatchNoContent: hideContent,
      });
    }
    if (ctx.toolSamples.length < 60) {
      ctx.toolSamples.push({ turn: tc.data.turn, name, args: hideContent ? "（--no-content）" : excerpt(argText, 90) });
    }
    readText.push(argText);
  }
  const readBlob = readText.join("\n");

  // 红线 1：写禁区
  for (const w of ctx.writes) {
    for (const re of opts.forbid || []) {
      if (re.test(w.rawForMatch)) {
        ctx.findings.push({ level: "bad", code: "FORBIDDEN_WRITE", detail: `${w.name} 写了禁区：${w.target}` });
      }
    }
  }
  // 红线 2：该读的没读
  for (const re of opts.mustRead || []) {
    if (!re.test(readBlob)) {
      ctx.findings.push({ level: "bad", code: "MISSING_READ", detail: `没有读到匹配 ${re} 的内容` });
    }
  }
  // 红线 3：该跑的没跑
  const cmdBlob = rawCommandTexts.join("\n");
  for (const re of opts.mustRun || []) {
    if (!re.test(cmdBlob)) {
      ctx.findings.push({ level: "bad", code: "MISSING_RUN", detail: `没有跑到匹配 ${re} 的命令` });
    }
  }
  // 提醒：说了"已完成"但同一 turn 零工具动作
  const toolsByTurn = new Map();
  for (const tc of toolCalls) {
    const t = tc.data.turn;
    toolsByTurn.set(t, (toolsByTurn.get(t) || 0) + 1);
  }
  for (const m of assistantMsgs) {
    const text = contentText(m.data && m.data.message && m.data.message.content);
    if (!text || !CLAIM_RE.test(text)) continue;
    const t = m.data.turn;
    if (!toolsByTurn.get(t)) {
      ctx.findings.push({
        level: "warn", code: "CLAIM_NO_TOOL",
        detail: `turn ${t} 说了「${hideContent ? "…" : excerpt(text, 60)}」但该 turn 没有工具动作`,
      });
    }
  }
  // --no-content：匹配已经做完，把用于匹配的原文从输出对象里移除（隐私）
  if (hideContent) {
    for (const w of ctx.writes) delete w.rawForMatch;
    delete ctx.__raw;
  }
  return ctx;
}

// ---------------------------------------------------------------- 输出

function renderText(results, opts) {
  console.log("=== 会话审计（只读）===");
  console.log(`会话目录：${opts.sessionsDir}`);
  if (opts.cwd.length) console.log(`cwd 过滤：${opts.cwd.join(" ｜ ")}`);
  console.log(`会话数：${results.length}`);
  let bad = 0, warn = 0;
  for (const r of results) {
    console.log(`\n-- ${r.sessionId} --`);
    console.log(`  cwd=${r.cwd} ｜ preset=${r.agentPreset || "?"} ｜ permission=${r.permission || "?"}`);
    console.log(`  时间=${r.createdAt ? new Date(r.createdAt).toISOString() : "?"} ｜ 事件 ${r.events}`);
    console.log(`  user ${r.counts.user} ／ assistant ${r.counts.assistant} ／ tool/call ${r.counts.toolCalls} ／ tool/result ${r.counts.toolResults}`);
    console.log(`  写动作 ${r.writes.length} ｜ 命令 ${r.commands.length} ｜ 要求候选 ${r.requirementCandidates.length}`);
    if (r.requirementCandidates.length) {
      console.log("  要求候选（人工核是否入册）：");
      for (const q of r.requirementCandidates.slice(0, 10)) {
        console.log(`    · ${new Date(q.time).toISOString().slice(0, 19)} ${q.text}`);
      }
      if (r.requirementCandidates.length > 10) console.log(`    · …还有 ${r.requirementCandidates.length - 10} 条`);
    }
    if (opts.showTools && r.toolSamples.length) {
      console.log("  工具调用（前 " + r.toolSamples.length + " 条）：");
      for (const t of r.toolSamples) console.log("    · turn " + t.turn + " " + t.name + " " + t.args);
    }
    for (const f of r.findings) {
      console.log(`  ${f.level === "bad" ? "✗" : "⚠️"} [${f.code}] ${f.detail}`);
      if (f.level === "bad") bad++; else warn++;
    }
    if (!r.findings.length) console.log("  ✓ 未命中本脚本的红线");
  }
  console.log(`\n-- 汇总 --\n  红线 ${bad} 条 ｜ 提醒 ${warn} 条`);
  if (bad) console.log("  ⇒ 退出码 1（有红线；逐条看上方证据）");
  return bad;
}

// ---------------------------------------------------------------- 自检（红/绿两个样本）

function compressFrames(lines) {
  // 故意拆成两帧，验证多帧解码
  const half = Math.ceil(lines.length / 2);
  return Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(lines.slice(0, half).join("\n") + "\n", "utf8")),
    zlib.zstdCompressSync(Buffer.from(lines.slice(half).join("\n") + "\n", "utf8")),
  ]);
}

function writeFixture(root, name, events) {
  const dir = path.join(root, "--fixture--", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "session.v4.jsonl.zstd"), compressFrames(events.map((e) => JSON.stringify(e))));
  return path.join(dir, "session.v4.jsonl.zstd");
}

function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-audit-"));
  try {
    const goodCwd = "/tmp/审计-好例子";
    const good = [
      { type: "session", version: 4, id: "good", createdAt: Date.now(), cwd: goodCwd, agentPreset: "standard" },
      { type: "permission/preset", data: { preset: "workspace-write" } },
      { type: "user/message", seq: 1, time: Date.now(), data: { content: [{ type: "text", text: "以后每轮必须跑审核自检，并把要求写进纪律。" }] } },
      { type: "tool/call", seq: 2, time: Date.now(), data: { turn: 1, step: 1, callId: "c1", name: "read", arguments: JSON.stringify({ path: "10_审计方的要求.md" }) } },
      { type: "tool/call", seq: 3, time: Date.now(), data: { turn: 1, step: 1, callId: "c2", name: "bash", arguments: JSON.stringify({ command: "python3 审核自检.py" }) } },
      { type: "tool/call", seq: 4, time: Date.now(), data: { turn: 2, step: 1, callId: "c3", name: "write", arguments: JSON.stringify({ path: "/tmp/审核工作区/报告.md" }) } },
      { type: "assistant/message", seq: 5, time: Date.now(), data: { turn: 2, message: { role: "assistant", content: [{ type: "text", text: "已完成并归档。" }] } } },
      { type: "workspace/changes", seq: 6, time: Date.now(), data: { turn: 2 } },
    ];
    const badCwd = "/tmp/审计-坏例子";
    const bad = [
      { type: "session", version: 4, id: "bad", createdAt: Date.now(), cwd: badCwd, agentPreset: "standard" },
      { type: "permission/preset", data: { preset: "danger-full-access" } },
      { type: "user/message", seq: 1, time: Date.now(), data: { content: [{ type: "text", text: "必须把这条要求记进纪律。" }] } },
      { type: "tool/call", seq: 2, time: Date.now(), data: { turn: 1, step: 1, callId: "b1", name: "bash", arguments: JSON.stringify({ command: "echo '已完成' >> /tmp/被审库/作品.md" }) } },
      { type: "assistant/message", seq: 3, time: Date.now(), data: { turn: 1, message: { role: "assistant", content: [{ type: "text", text: "已完成。" }] } } },
    ];
    const goodFile = writeFixture(root, "good", good);
    const badFile = writeFixture(root, "bad", bad);
    const opts = { forbid: [/被审库/], mustRead: [/10_审计方的要求/], mustRun: [/审核自检\.py/], maxExcerpt: 120 };
    const g = analyzeSession(goodFile, null, opts);
    const b = analyzeSession(badFile, null, opts);

    const badOf = (r) => r.findings.filter((f) => f.level === "bad").map((f) => f.code);
    const problems = [];
    if (badOf(g).length) problems.push("绿样本被误报：" + badOf(g).join(","));
    for (const code of ["FORBIDDEN_WRITE", "MISSING_READ", "MISSING_RUN"]) {
      if (!badOf(b).includes(code)) problems.push("红样本没命中：" + code);
    }
    if (g.requirementCandidates.length !== 1) problems.push("要求候选抽取不对（绿样本）");
    if (g.counts.toolCalls !== 3) problems.push("多帧解码后 tool/call 计数不对（" + g.counts.toolCalls + "）");
    const gNC = analyzeSession(goodFile, null, { ...opts, noContent: true });
    if (badOf(gNC).length) problems.push("--no-content 造成假红：" + badOf(gNC).join(","));
    if (JSON.stringify(gNC).includes("python3 审核自检.py")) problems.push("--no-content 泄漏了命令原文");
    if (problems.length) {
      console.log("❌ 自检失败：\n  - " + problems.join("\n  - "));
      return 3;
    }
    console.log("✓ 自检通过：脆绿样本 0 红线；坏样本命中 " + badOf(b).join(" + "));
    return 0;
  } catch (e) {
    console.log("❌ 自检崩了：" + (e && e.stack || e));
    return 3;
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- main

function main() {
  const opts = parseArgs(process.argv);
  if (opts.selfTest) return selfTest();

  const files = collectSessionFiles(opts.sessionsDir).sort();
  if (!files.length) {
    console.log("没找到会话日志（--sessions-dir " + opts.sessionsDir + "）⇒ 没验成");
    return 2;
  }
  const metas = [];
  const unsupported = [];
  for (const f of files) {
    const h = readHeader(f);
    if (!h || h.type !== "session") continue;
    if (h.version !== SUPPORTED_VERSION) {
      unsupported.push({ file: f, version: h.version });
      continue;
    }
    if (opts.cwd.length && !opts.cwd.includes(h.cwd)) continue;
    if (opts.session.length) {
      const sid = h.id || path.basename(path.dirname(f));
      if (!opts.session.includes(sid) && !opts.session.includes(path.basename(path.dirname(f)))) continue;
    }
    if (opts.since && h.createdAt && h.createdAt < opts.since) continue;
    if (opts.until && h.createdAt && h.createdAt > opts.until) continue;
    metas.push({ file: f, header: h });
  }
  if (!metas.length) {
    if (unsupported.length) {
      console.log(`日志版本 ${[...new Set(unsupported.map((u) => u.version))].join("/")} 未支持（本工具只认 v${SUPPORTED_VERSION}）⇒ 没验成`);
      return 2;
    }
    console.log("过滤后没有会话（cwd/时间/session 条件太窄）⇒ 没验成");
    return 2;
  }
  metas.sort((a, b) => (b.header.createdAt || 0) - (a.header.createdAt || 0));
  const picked = metas.slice(0, Math.max(1, opts.limit || 3));

  if (opts.list) {
    for (const m of metas) {
      console.log(`${new Date(m.header.createdAt || 0).toISOString()}  ${m.header.id}  ${m.header.cwd}  preset=${m.header.agentPreset || "?"}`);
    }
    return 0;
  }

  if (opts.dumpEvents) {
    const max = Math.max(1, opts.limitEvents || 5000);
    for (const m of picked) {
      let events;
      try {
        events = readSessionEvents(m.file).events;
      } catch (e) {
        console.log("解日志失败：" + (e && e.message || e) + " ⇒ 没验成");
        return 2;
      }
      for (const ev of events.slice(0, max)) console.log(JSON.stringify(ev));
      if (events.length > max) console.error(`… ${m.header.id} 还有 ${events.length - max} 条未打印（--limit-events 调整）`);
    }
    return 0;
  }

  let results;
  try {
    results = picked.map((m) => analyzeSession(m.file, m.header, opts));
  } catch (e) {
    console.log("解日志失败：" + (e && e.message || e) + " ⇒ 没验成");
    return 2;
  }
  if (opts.json) {
    const bad = results.flatMap((r) => r.findings).filter((f) => f.level === "bad");
    console.log(JSON.stringify({ sessions: results, exit: bad.length ? 1 : 0 }, null, 2));
    return bad.length ? 1 : 0;
  }
  const bad = renderText(results, opts);
  return bad ? 1 : 0;
}

try {
  process.exit(main());
} catch (e) {
  console.log("会话审计崩了：" + (e && e.stack || e));
  process.exit(3);
}

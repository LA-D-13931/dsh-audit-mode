#!/usr/bin/env node
/**
 * 巡检（只读）—— 两件事：
 *   ① 看被审库自上次巡检以来变了什么（尤其敏感路径：判据/生成器/答案键/CI/纪律）；
 *   ② 看审核侧状态源、欠账、会话有没有漂移（状态源落后于被审库 HEAD = 冻结取样不一致）。
 *
 * 不写被审对象。只会在 --update-baseline 时写 tools/巡检基线.json（审核方自己的工作区）。
 *
 * 用法：
 *   node tools/巡检.mjs [--config 巡检配置.json] [--json] [--update-baseline]
 * 退出码：0 没有红线（可能有提醒）／1 有红线 ／2 没验成（被审库/配置不可读）／3 崩
 *
 * 基线语义：--update-baseline 记录“我已经看过这些变化”，**不代表问题已修**。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function parseArgs(argv) {
  const o = { config: path.join(HERE, "巡检配置.json"), json: false, updateBaseline: false, selfTest: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(a + " 缺少参数"); return argv[++i]; };
    switch (a) {
      case "--config": o.config = next(); break;
      case "--json": o.json = true; break;
      case "--update-baseline": o.updateBaseline = true; break;
      case "--self-test": o.selfTest = true; break;
      case "-h": case "--help":
        console.log("用法：node 巡检.mjs [--config 路径] [--json] [--update-baseline] [--self-test]");
        process.exit(0);
      default: throw new Error("未知参数：" + a);
    }
  }
  return o;
}

function resolveP(p) { return path.isAbsolute(p) ? p : path.resolve(ROOT, p); }

function git(repo, args) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) return null;
  return r.stdout;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function runSessionList(cwd, sessionsDir) {
  const script = path.join(HERE, "会话审计.mjs");
  if (!fs.existsSync(script)) return null;
  const args = [script, "--cwd", cwd, "--list"];
  if (sessionsDir) args.push("--sessions-dir", sessionsDir);
  const r = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 120000 });
  if (r.status !== 0) return null;
  return r.stdout.split("\n").filter((l) => /^\d{4}-\d\d-\d\dT/.test(l));
}

function gitq(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 30000 });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "patrol-selftest-"));
  const repo = path.join(tmp, "repo");
  const script = fileURLToPath(import.meta.url);
  const run = (configPath, extra = []) => spawnSync(process.execPath, [script, "--config", configPath, ...extra],
    { encoding: "utf8", timeout: 120000 });
  const problems = [];
  try {
    fs.mkdirSync(repo, { recursive: true });
    gitq(tmp, ["init", "-q", repo]);
    gitq(repo, ["config", "user.email", "audit@test.local"]);
    gitq(repo, ["config", "user.name", "audit-test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    gitq(repo, ["add", "-A"]);
    gitq(repo, ["commit", "-q", "-m", "init"]);

    const cfgPath = path.join(tmp, "巡检配置.json");
    fs.writeFileSync(cfgPath, JSON.stringify({
      targetRepo: repo,
      sensitivePatterns: ["scripts/check-"],
      baselineFile: path.join(tmp, "baseline.json"),
      maxCommits: 10,
    }, null, 2));

    // A. 首次建基线：应 0（无红线）
    const a = run(cfgPath, ["--update-baseline"]);
    if (a.status !== 0) problems.push("首次巡检应退 0，实际 " + a.status + "：" + (a.stdout || "").slice(0, 300));
    if (!fs.existsSync(path.join(tmp, "baseline.json"))) problems.push("基线没写出来");

    // B. 敏感路径新提交：应提醒 SENSITIVE_PATHS（仍 0）
    fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(repo, "scripts", "check-x.py"), "print('judge')\n");
    gitq(repo, ["add", "-A"]);
    gitq(repo, ["commit", "-q", "-m", "touch judge"]);
    const b = run(cfgPath);
    if (b.status !== 0) problems.push("敏感路径提交不应退 1（提醒不是红线），实际 " + b.status);
    if (!/SENSITIVE_PATHS/.test(b.stdout || "")) problems.push("没报 SENSITIVE_PATHS");

    // C. 工作树不干净：应 1（红线）
    fs.appendFileSync(path.join(repo, "README.md"), "dirty\n");
    const c = run(cfgPath);
    if (c.status !== 1) problems.push("工作树不干净应退 1，实际 " + c.status);
    if (!/DIRTY_WORKTREE/.test(c.stdout || "")) problems.push("没报 DIRTY_WORKTREE");

    if (problems.length) {
      console.log("❌ 巡检自检失败：\n  - " + problems.join("\n  - "));
      return 3;
    }
    console.log("✓ 巡检自检通过：绿样本 0 红线；敏感路径提交只提醒；工作树脏退 1");
    return 0;
  } catch (e) {
    console.log("❌ 巡检自检崩了：" + (e && e.stack || e));
    return 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.selfTest) return selfTest();
  const cfg = readJson(resolveP(opts.config));
  if (!cfg || !cfg.targetRepo) {
    console.log("巡检配置读不到或缺 targetRepo：" + opts.config + " ⇒ 没验成");
    return 2;
  }
  const findings = [];
  const add = (level, code, detail) => findings.push({ level, code, detail });
  const repo = cfg.targetRepo;
  if (!fs.existsSync(repo) || !git(repo, ["rev-parse", "--is-inside-work-tree"])) {
    console.log("被审库不可读或不是 git 仓库：" + repo + " ⇒ 没验成");
    return 2;
  }

  const head = (git(repo, ["rev-parse", "--short", "HEAD"]) || "").trim();
  const headTime = (git(repo, ["log", "-1", "--format=%cI"]) || "").trim();
  const dirty = (git(repo, ["status", "--porcelain"]) || "").split("\n").filter(Boolean);
  if (dirty.length) add("bad", "DIRTY_WORKTREE", `被审库工作树不干净（${dirty.length} 处）——冻结取样前先记账`);

  const baselinePath = resolveP(cfg.baselineFile || "tools/巡检基线.json");
  const base = readJson(baselinePath);
  const firstRun = !base;

  // 变更集：优先“自基线 HEAD 以来”，否则最近 maxCommits 个提交
  const maxCommits = Math.max(1, Math.min(100, cfg.maxCommits || 20));
  // 有基线且 HEAD 没变 ⇒ 没有新提交（不能退化成“最近 N 个提交”）
  let range = null;
  let logArgs = null;
  if (!base) {
    logArgs = ["log", "--oneline", "--name-only", "-n", String(maxCommits)];
  } else if (base.head && base.head !== head) {
    range = `${base.head}..HEAD`;
    logArgs = ["log", "--oneline", "--name-only", range, "-n", String(maxCommits)];
  }
  const log = logArgs ? (git(repo, logArgs) || "") : "";
  const commits = [];
  let cur = null;
  for (const line of log.split("\n")) {
    if (!line.trim()) continue;
    if (/^[0-9a-f]{7,}\s/.test(line)) {
      cur = { hash: line.slice(0, 7), subject: line.slice(8), files: [] };
      commits.push(cur);
    } else if (cur) cur.files.push(line.trim());
  }
  const sensitiveRe = (cfg.sensitivePatterns || []).map((p) => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  let sensitiveCommits = 0;
  for (const c of commits) {
    const hit = c.files.filter((f) => sensitiveRe.some((re) => re.test(f)));
    if (!hit.length) continue;
    sensitiveCommits++;
    if (firstRun) continue;   // 首次基线：历史提交不逐条报
    add("warn", "SENSITIVE_PATHS",
      `${c.hash} ${c.subject} —— 敏感路径：${[...new Set(hit)].slice(0, 4).join("、")}`);
  }
  if (firstRun && sensitiveCommits) {
    add("info", "BASELINE_HISTORY",
      `首次基线：最近 ${commits.length} 个提交里 ${sensitiveCommits} 个触敏感路径（历史，不逐条报；建基线后只看新增）`);
  }

  // 状态源是否落后于被审库
  const stateAbs = cfg.stateSource ? resolveP(cfg.stateSource) : null;
  let stateInfo = null;
  if (stateAbs && fs.existsSync(stateAbs)) {
    const st = fs.statSync(stateAbs);
    const text = fs.readFileSync(stateAbs, "utf8").split("\n").slice(0, 30).join("\n");
    const round = (text.match(/^##\s*第\s*(\d+)\s*轮/m) || text.match(/轮次[：:]\s*(\d+)/) || [])[1] || "?";
    stateInfo = { round, mtime: st.mtime.toISOString() };
    if (headTime && st.mtime.getTime() < Date.parse(headTime)) {
      add("bad", "STATE_BEHIND_HEAD",
        `状态源（${path.relative(ROOT, stateAbs)}，轮次 ${round}，改于 ${st.mtime.toISOString().slice(0, 19)}）`
        + ` 早于被审库 HEAD（${head} @ ${headTime}）——冻结取样不一致，先刷新状态源`);
    }
  } else if (stateAbs) {
    add("warn", "STATE_SOURCE_MISSING", "状态源文件不存在：" + path.relative(ROOT, stateAbs));
  }

  // 欠账是否增加（涨了 = 新失败）
  let openDebt = null;
  if (cfg.debtLedger && fs.existsSync(resolveP(cfg.debtLedger))) {
    const d = readJson(resolveP(cfg.debtLedger));
    const items = (d && d.items) || [];
    openDebt = items.filter((x) => x.status === "candidate" || x.status === "ignored").length;
    if (base && typeof base.openDebt === "number" && openDebt > base.openDebt) {
      add("bad", "DEBT_INCREASED", `审核欠账从 ${base.openDebt} 涨到 ${openDebt}——涨了算新失败`);
    }
  }

  // 新会话（自上次巡检）
  let newSessions = null;
  if (cfg.sessionsCwd) {
    const lines = runSessionList(cfg.sessionsCwd, cfg.sessionsDir);
    if (lines) {
      const since = base ? Date.parse(base.lastCheckedAt || base.updatedAt || 0) : 0;
      newSessions = lines.filter((l) => Date.parse(l.slice(0, 24)) > since).length;
      if (newSessions) {
        add(firstRun ? "info" : "warn", "NEW_SESSIONS",
          `${firstRun ? "首次基线，现有" : "自上次巡检有"} ${newSessions} 个会话——建议跑会话审计（要求入册/必跑项）`);
      }
    }
  }

  const bad = findings.filter((f) => f.level === "bad");
  const warn = findings.filter((f) => f.level === "warn");
  const info = findings.filter((f) => f.level === "info");

  const newBaseline = {
    updatedAt: new Date().toISOString(),
    head, headTime,
    stateSource: stateInfo,
    openDebt,
    lastRunHadBad: bad.length,
    note: "--update-baseline 只表示“已看过”，不代表问题已修",
  };
  if (opts.updateBaseline) {
    try { fs.writeFileSync(baselinePath, JSON.stringify(newBaseline, null, 2) + "\n", "utf8"); }
    catch (e) { add("warn", "BASELINE_WRITE_FAILED", "基线写不进去：" + e.message); }
  }

  if (opts.json) {
    console.log(JSON.stringify({
      repo, head, headTime, firstRun, range,
      commits: commits.map((c) => ({ hash: c.hash, subject: c.subject, files: c.files.length, sensitive: c.files.filter((f) => sensitiveRe.some((re) => re.test(f))) })),
      state: stateInfo, openDebt, newSessions, findings,
      baseline: opts.updateBaseline ? newBaseline : base,
      exit: bad.length ? 1 : 0,
    }, null, 2));
    if (bad.length) return 1;
    return 0;
  }

  console.log("=== 审核巡检（只读）===");
  console.log(`被审库：${repo}`);
  console.log(`HEAD：${head} @ ${headTime}`);
  console.log(`基线：${firstRun ? "首次（无基线）" : (base.head || "?")} ｜ 范围内提交 ${commits.length} 个｜ 敏感路径提交 ${sensitiveCommits} 个`);
  if (stateInfo) console.log(`状态源：轮次 ${stateInfo.round} @ ${stateInfo.mtime.slice(0, 19)}`);
  if (openDebt !== null) console.log(`审核欠账开放：${openDebt} 条`);
  if (newSessions !== null) console.log(`新会话：${newSessions} 个`);
  console.log("");
  if (!findings.length) {
    console.log("✓ 没有红线，也没有提醒");
  } else {
    for (const f of findings) {
      const mark = f.level === "bad" ? "✗" : (f.level === "warn" ? "⚠️" : "ℹ️");
      console.log(`${mark} [${f.code}] ${f.detail}`);
    }
  }
  if (opts.updateBaseline) console.log(`\n基线已更新：${path.relative(ROOT, baselinePath)}（只表示已看过，不代表已修）`);
  console.log(`\n-- 汇总 --\n  红线 ${bad.length} 条 ｜ 提醒 ${warn.length} 条 ｜ 信息 ${info.length} 条`);
  if (bad.length) { console.log("  ⇒ 退出码 1：先处理红线（冻结/状态源/欠账/工作树），再签“通过”"); return 1; }
  if (warn.length) console.log("  ⇒ 退出码 0（只有提醒；提醒要人工判，不是缺陷）");
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.log("巡检崩了：" + (e && e.stack || e));
  process.exit(3);
}

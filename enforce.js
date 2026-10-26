/**
 * 审核模式 · 宿主级强制层（audit enforce）
 *
 * 架构参考：taoggt/dsh-qa-preset 的 enforce.js（MIT）——restrict/guard 的宿主级作用域方案。
 *
 * 问题：预设组合只能控制它自己挂载的插件；宿主全局注册的工具
 * （computer-use、Agent-Teams、ppt/office、memory、schedule、plugin_manager …）
 * 会被每个会话继承。所以“纯审核、只读”不能只靠预设+提示词。
 *
 * 做法（Q&A 预设 enforce 的同构方案）：
 *  - 只对「有效预设 = audit」的会话生效（读 agentPreset 持久投影）；
 *  - 通过 agent.ctx 注册 tools.restrict({deny})，把非白名单的全局工具从模型请求里拿掉；
 *  - 通过 agent.ctx 注册单调 tools.guard，兜底拒绝漏网的执行；
 *  - 白名单内的写类工具再按“路径必须在审核工作区内”做参数级检查；
 *  - bash 做静态检查（明显写系统/写被审库外/系统变更命令直接拒绝），并把每次决策写 JSONL 审计日志。
 *
 * 边界：bash 静态检查不是沙箱（脚本内部写盘它看不见）；最终边界仍是会话的
 * sandbox 模式 + 被审库在工作区之外。本插件负责的是“审核 agent 不越权”，
 * 并提供可回放的 JSONL 证据。
 *
 * 自检（不依赖 DSH）：node enforce.js --self-test
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'dsh-audit-mode/enforce'

/** 强依赖：tools + agentPresets；workingDirectory 用于解析会话工作区。 */
export const inject = ['tools', 'agentPresets', 'workingDirectory']

const AUDIT_PRESET_ID = 'audit'
const AGENT_PRESET_PROJECTION = 'agentPreset'
const RUN_CODE_TOOL = 'run_code'

/** 模型可见的安全工具面（含审核模式自己挂载的工具）。 */
const ALLOWED_TOOLS = Object.freeze([
  // 审核模式自带
  'read', 'read_image', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh',
  'job_list', 'job_output', 'job_kill', 'skill', 'ask_user_question',
  'todo_write', 'web_search', 'web_fetch', 'present', 'exit_plan_mode',
  'subagent', 'subagent_fork', 'list_agents', 'send_message', 'interrupt_agent', 'wait_agent',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  // profile 提供的只读/低风险工具
  'memory_recall', 'modlens_read_image', 'load_workspace_dependencies', 'lsp',
  'secure_scan', 'secure_diff', 'secure_report', 'secure_health', 'secure_deps', 'secure_policy_show',
])

/** 这些工具即使名字没在白名单里也永不自动放行（白名单优先）。 */
const HARD_DENY_TOOLS = Object.freeze([
  'plugin_manager', 'working_directory', 'run_code',
  'schedule_create', 'schedule_update', 'schedule_delete',
  'secure_export', 'secure_baseline', 'secure_policy_set', 'secure_fix_verify',
])

const WRITE_TOOLS = new Set(['write', 'edit'])
const SHELL_TOOLS = new Set(['bash', 'pwsh'])
const WRITE_OPS = /(>>?|\btee\b|\brm\b|\bmv\b|\bcp\b|\bsed\s+-i\b|\btruncate\b|\bdd\b|\binstall\b|\bmkdir\b|\btouch\b|\bln\s+-s\b|\bgit\s+(commit|add|checkout|reset|stash|clean|rm|push|merge|apply)\b|\bgit\s+-C\s+\S+\s+(commit|add|checkout|reset|stash|clean|rm|push|merge|apply)\b)/
const SYSTEM_MUTATION = [
  /\bsudo\b/, /\bchmod\b/, /\bchown\b/, /\blaunchctl\b/, /\bdefaults\s+write\b/,
  /\bbrew\s+(install|uninstall|upgrade)\b/,
  /\bpip3?\s+install\b/, /\bnpm\s+(install|i)\s+-g\b/, /\bpnpm\s+add\s+-g\b/, /\byarn\s+global\s+add\b/,
]
const DSH_STATE = /(~|\$DSH_HOME|\/Users\/[^/\s]+\/\.dsh)\/(sessions|profiles|agent-presets|skills)\b/

function denyText(toolName, why) {
  return `审核模式已启用（只读监督）：拒绝执行「${toolName}」——${why}。只允许在审核方工作区内写报告/证据；被审库、审计工具与系统状态一律只读。`
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function isInside(root, abs) {
  if (typeof root !== 'string' || root === '') return false
  const r = path.resolve(root)
  const p = path.resolve(abs)
  return p === r || p.startsWith(r + path.sep)
}

function expandPath(value, workspaceRoot, home) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  let p = value.trim()
  if (p === '~') p = home
  else if (p.startsWith('~/')) p = path.join(home, p.slice(2))
  else if (p.startsWith('$DSH_HOME')) p = path.join(process.env.DSH_HOME || path.join(home, '.dsh'), p.replace(/^\$DSH_HOME\/?/, ''))
  if (!path.isAbsolute(p)) p = path.resolve(workspaceRoot || '.', p)
  return path.resolve(p)
}

/** 从工具参数里收集所有“可能是路径”的字符串（写类工具用）。 */
function collectPathValues(args, depth = 0) {
  const out = []
  if (depth > 4 || args === null || typeof args !== 'object') return out
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && /path|file|dir|target|dest|out/i.test(k) && v.trim()) out.push(v)
    else if (v && typeof v === 'object') out.push(...collectPathValues(v, depth + 1))
  }
  return out
}

/** 从 shell 命令里提取明显的外部路径（绝对路径 / ~ / $DSH_HOME）。 */
function shellPaths(command) {
  const out = []
  const re = /(?:^|[\s=])((?:\/|~\/|\$DSH_HOME\/)[^\s;&|<>()'"`]+)/g
  let m
  while ((m = re.exec(command)) !== null) out.push(m[1])
  return out
}

/**
 * 纯函数策略（可单测）：返回 undefined 表示放行，返回字符串表示拒绝原因。
 * @param {{name:string, args:unknown, workspaceRoot:string, home:string}} call
 */
export function evaluatePolicy(call) {
  const { name, args, workspaceRoot, home } = call
  if (typeof name !== 'string' || name === '') return '工具名为空'
  if (HARD_DENY_TOOLS.includes(name)) return '该工具不在审核白名单'
  if (name === 'spawn_teammate') return '请用 subagent / subagent_fork 分派子代理（子会话继承 audit 预设并同样受 enforce 约束）；Team spawn 可能生成不受本预设约束的会话'
  if (name === 'memory') {
    const action = asObject(args).action
    if (action !== 'query') return 'memory 只允许 query（不允许写记忆）'
    return undefined
  }
  if (!ALLOWED_TOOLS.includes(name)) return '该工具不在审核白名单'

  if (WRITE_TOOLS.has(name)) {
    if (!workspaceRoot) return '无法确定审核工作区'
    const paths = collectPathValues(asObject(args))
    if (!paths.length) return '写类工具没有可检查的路径（fail closed）'
    for (const p of paths) {
      const abs = expandPath(p, workspaceRoot, home)
      if (!abs || !isInside(workspaceRoot, abs)) return `写路径不在审核工作区内：${p}`
    }
    return undefined
  }

  if (SHELL_TOOLS.has(name)) {
    const command = asObject(args).command
    if (typeof command !== 'string' || command.trim() === '') return 'shell 命令为空'
    for (const re of SYSTEM_MUTATION) if (re.test(command)) return '命令包含系统级变更（安装/权限/服务）'
    if (DSH_STATE.test(command)) return '命令指向 DSH 自身状态目录（sessions/profiles）'
    if (WRITE_OPS.test(command)) {
      if (!workspaceRoot) return '无法确定审核工作区'
      for (const p of shellPaths(command)) {
        const abs = expandPath(p, workspaceRoot, home)
        if (!abs || !isInside(workspaceRoot, abs)) return `命令写入/改动了审核工作区之外的路径：${p}`
      }
      const cd = /(?:^|[;&|]\s*)cd\s+([^\s;&|]+)/g
      let m
      while ((m = cd.exec(command)) !== null) {
        const abs = expandPath(m[1], workspaceRoot, home)
        if (!abs || !isInside(workspaceRoot, abs)) return `命令切换到了审核工作区之外的目录：${m[1]}`
      }
    }
    return undefined
  }
  return undefined
}

/** JSONL 审计日志（只写 DSH home，不写被审库）。 */
function appendAuditLog(payload) {
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const dir = path.join(home, 'audit-mode')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'enforce.jsonl'), JSON.stringify({
      ts: new Date().toISOString(), pid: process.pid, ...payload,
    }) + '\n', 'utf8')
  } catch { /* 日志失败不影响主流程 */ }
}

function briefArgs(args) {
  try {
    const s = JSON.stringify(args)
    return s.length > 600 ? s.slice(0, 600) + '…' : s
  } catch { return '<unrenderable>' }
}

function describeError(error) {
  try { return error instanceof Error ? error.message : String(error) } catch { return 'unrenderable error' }
}

function schemaNames(schemas) {
  if (!Array.isArray(schemas)) throw new Error('tools.schemas() did not return an array')
  const names = []
  for (const s of schemas) {
    if (s && typeof s.name === 'string' && s.name !== '') names.push(s.name)
  }
  return names
}

function unknownRestrictNames(error) {
  const match = /unknown global tools? ((?:"[^"]*"(?:, )?)+)/.exec(describeError(error))
  if (!match) return new Set()
  const names = new Set()
  for (const q of match[1].matchAll(/"([^"]*)"/g)) names.add(q[1])
  return names
}

// ---------------------------------------------------------------------------
// DSH plugin
// ---------------------------------------------------------------------------

export function apply(ctx) {
  const allowed = new Set(ALLOWED_TOOLS)
  const home = os.homedir()
  const agents = new Map()
  const warned = new Set()
  const sessionProjections = ctx.get('sessionProjections')
  let workingDirectory
  try { workingDirectory = ctx.get('workingDirectory') } catch { workingDirectory = undefined }

  const warnOnce = (key, message) => {
    if (warned.has(key)) return
    warned.add(key)
    ctx.logger.warn(message)
  }

  appendAuditLog({ event: 'enforcer-loaded', preset: AUDIT_PRESET_ID })

  function workspaceOf(agent) {
    try {
      if (workingDirectory && typeof workingDirectory.get === 'function' && agent.session) {
        const dir = workingDirectory.get(agent.session)
        if (typeof dir === 'string' && dir !== '') return dir
      }
    } catch (error) {
      warnOnce('workspace', `audit-enforce: cannot read the session workspace: ${describeError(error)}`)
    }
    try {
      if (agent.session && typeof agent.session.cwd === 'string' && agent.session.cwd !== '') return agent.session.cwd
    } catch { /* ignore */ }
    return undefined
  }

  function presetIdOf(agent) {
    const projections = sessionProjections === undefined ? ctx.get('sessionProjections') : sessionProjections
    if (projections) {
      try {
        const state = projections.stateOf(agent.session, AGENT_PRESET_PROJECTION)
        if (typeof state === 'string' && state !== '') return state
      } catch (error) {
        warnOnce('projection', `audit-enforce: cannot read the agentPreset projection: ${describeError(error)}`)
      }
    }
    try {
      const id = ctx.agentPresets.composedPreset(agent.ctx)
      if (typeof id === 'string' && id !== '') return id
    } catch (error) {
      warnOnce('composed', `audit-enforce: cannot read the composed preset: ${describeError(error)}`)
    }
    return undefined
  }

  function lookupAgent(sessionId) {
    try {
      const runtime = ctx.get('agents')
      if (runtime && typeof runtime.get === 'function') return runtime.get(sessionId)
    } catch { /* ignore */ }
    return undefined
  }

  function ensureAgent(agent) {
    if (!agent) return undefined
    let sessionId
    try { sessionId = agent.session && agent.session.id } catch { return undefined }
    if (!sessionId) return undefined
    const existing = agents.get(sessionId)
    let presetId
    try { presetId = presetIdOf(agent) } catch (error) {
      warnOnce('preset', `audit-enforce: cannot resolve preset: ${describeError(error)}`)
      return existing
    }
    if (presetId !== AUDIT_PRESET_ID) {
      if (existing) disposeEntry(existing)
      return undefined
    }
    if (existing && existing.agent === agent) {
      try { reconcile(existing) } catch (error) {
        warnOnce(`reconcile:${String(sessionId)}`, `audit-enforce: reconcile failed: ${describeError(error)}`)
      }
      return existing
    }
    if (existing) disposeEntry(existing)

    const entry = {
      agent, session: agent.session, workspaceRoot: workspaceOf(agent),
      catalogNames: new Set(), unrestrictableNames: new Set(),
      guardDispose: undefined, restrictionDispose: undefined, restrictionKey: undefined,
    }
    try {
      entry.guardDispose = agent.ctx.tools.guard((execution) => guardExecution(entry, execution))
    } catch (error) {
      warnOnce(`guard:${String(sessionId)}`, `audit-enforce: cannot install guard: ${describeError(error)}`)
      disposeEntry(entry)
      return undefined
    }
    agents.set(sessionId, entry)
    appendAuditLog({ event: 'enforcer-installed', session: String(sessionId), preset: AUDIT_PRESET_ID, workspace: entry.workspaceRoot || null })
    try { reconcile(entry) } catch (error) {
      warnOnce(`reconcile:${String(sessionId)}`, `audit-enforce: reconcile failed: ${describeError(error)}`)
    }
    return entry
  }

  function guardExecution(entry, execution) {
    try {
      if (!execution) return undefined
      const toolName = execution.name
      if (typeof toolName !== 'string' || toolName === '') return undefined
      const workspaceRoot = entry.workspaceRoot || workspaceOf(entry.agent)
      const reason = evaluatePolicy({
        name: toolName, args: execution.arguments, workspaceRoot, home,
      })
      const risky = SHELL_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName)
        || ['subagent', 'subagent_fork', 'spawn_teammate', 'memory', 'secure_export'].includes(toolName)
      if (reason) {
        appendAuditLog({ event: 'deny', session: String(entry.session.id), tool: toolName, reason, args: briefArgs(execution.arguments) })
        return denyText(toolName, reason)
      }
      if (risky) appendAuditLog({ event: 'allow', session: String(entry.session.id), tool: toolName, args: briefArgs(execution.arguments) })
      return undefined
    } catch (error) {
      warnOnce('guard-eval', `audit-enforce: guard failed to evaluate: ${describeError(error)}`)
      return undefined
    }
  }

  function reconcile(entry) {
    try { refreshCatalog(entry) } catch (error) {
      warnOnce('catalog', `audit-enforce: cannot read tool catalog: ${describeError(error)}`)
      return
    }
    const deny = restrictableDeny(entry)
    if (!deny.length) { clearRestriction(entry); return }
    if (entry.restrictionDispose !== undefined && entry.restrictionKey === deny.join('\n')) return
    const applied = applyRestriction(entry, deny)
    if (!applied) return
    clearRestriction(entry)
    entry.restrictionDispose = applied.dispose
    entry.restrictionKey = applied.key
  }

  function refreshCatalog(entry) {
    for (const n of schemaNames(ctx.tools.schemas(entry.agent))) entry.catalogNames.add(n)
    for (const n of schemaNames(ctx.tools.schemas())) entry.catalogNames.add(n)
  }

  function restrictableDeny(entry) {
    const deny = []
    for (const n of entry.catalogNames) {
      if (n === RUN_CODE_TOOL || allowed.has(n) || entry.unrestrictableNames.has(n)) continue
      deny.push(n)
    }
    return deny.sort()
  }

  function applyRestriction(entry, candidates) {
    let names = candidates
    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const dispose = entry.agent.ctx.tools.restrict({ deny: names })
        return { dispose, key: names.join('\n') }
      } catch (error) {
        lastError = error
        const unknown = unknownRestrictNames(error)
        if (!unknown.size) break
        for (const n of unknown) entry.unrestrictableNames.add(n)
        names = candidates.filter((n) => !entry.unrestrictableNames.has(n))
        if (!names.length) {
          warnOnce(`restrict-empty:${String(entry.session.id)}`, 'audit-enforce: no restrictable tools remain; guard still denies execution')
          return undefined
        }
      }
    }
    warnOnce(`restrict:${String(entry.session.id)}`, `audit-enforce: could not restrict tools: ${describeError(lastError)}`)
    return undefined
  }

  function clearRestriction(entry) {
    const dispose = entry.restrictionDispose
    entry.restrictionDispose = undefined
    entry.restrictionKey = undefined
    if (typeof dispose === 'function') {
      try { dispose() } catch (error) { ctx.logger.warn(`audit-enforce: restriction cleanup failed: ${describeError(error)}`) }
    }
  }

  function disposeEntry(entry) {
    if (!entry) return
    const sessionId = entry.session && entry.session.id
    if (sessionId !== undefined && agents.get(sessionId) === entry) agents.delete(sessionId)
    clearRestriction(entry)
    const dispose = entry.guardDispose
    entry.guardDispose = undefined
    if (typeof dispose === 'function') {
      try { dispose() } catch (error) { ctx.logger.warn(`audit-enforce: guard cleanup failed: ${describeError(error)}`) }
    }
  }

  ctx.effect(() => () => {
    for (const entry of [...agents.values()]) disposeEntry(entry)
    agents.clear()
  }, 'audit-enforce: per-agent enforcement')

  ctx.on('agent/created', (payload) => {
    try { ensureAgent(payload && payload.agent) } catch (error) {
      warnOnce('created', `audit-enforce: agent/created failed: ${describeError(error)}`)
    }
  })
  ctx.on('agent-preset/selected', (sessionId) => {
    try {
      const agent = lookupAgent(sessionId)
      if (agent) ensureAgent(agent)
    } catch (error) { warnOnce('selected', `audit-enforce: preset selection failed: ${describeError(error)}`) }
  })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    try { ensureAgent(agent) } catch (error) { warnOnce('pre-step', `audit-enforce: pre-step failed: ${describeError(error)}`) }
    return next()
  })
  ctx.on('agent/disposed', (payload) => {
    const agent = payload && payload.agent
    if (!agent) return
    let sessionId
    try { sessionId = agent.session && agent.session.id } catch { return }
    const entry = sessionId !== undefined ? agents.get(sessionId) : undefined
    if (entry && entry.agent === agent) disposeEntry(entry)
  })

  try {
    const runtime = ctx.get('agents')
    if (runtime && typeof runtime.list === 'function') {
      for (const agent of runtime.list()) {
        try { ensureAgent(agent) } catch (error) { warnOnce('adopt', `audit-enforce: adopt failed: ${describeError(error)}`) }
      }
    }
  } catch (error) { warnOnce('adopt', `audit-enforce: cannot enumerate agents: ${describeError(error)}`) }
}

// ---------------------------------------------------------------------------
// 自检（不依赖 DSH）
// ---------------------------------------------------------------------------

function selfTest() {
  const ws = path.join(os.tmpdir(), 'audit-ws-selftest')
  const home = path.join(os.tmpdir(), 'audit-home-selftest')
  const cases = [
    ['read', { path: '/etc/hosts' }, 'allow'],
    ['grep', { pattern: 'x', path: '/etc' }, 'allow'],
    ['write', { path: path.join(ws, '报告.md') }, 'allow'],
    ['write', { path: '/Users/someone/被审库/x.md' }, 'deny'],
    ['write', { path: '../escape.md' }, 'deny'],
    ['edit', { file_path: path.join(ws, 'a.md') }, 'allow'],
    ['edit', { file_path: '/tmp/outside.md' }, 'deny'],
    ['bash', { command: `cat /etc/hosts` }, 'allow'],
    ['bash', { command: `echo hi > ${path.join(ws, 'ok.txt')}` }, 'allow'],
    ['bash', { command: 'echo hi > /tmp/outside.txt' }, 'deny'],
    ['bash', { command: 'git -C /Users/someone/被审库 commit -m x' }, 'deny'],
    ['bash', { command: 'sudo rm -rf /' }, 'deny'],
    ['bash', { command: 'echo x > ~/.dsh/sessions/x' }, 'deny'],
    ['bash', { command: 'pip install requests' }, 'deny'],
    ['memory', { action: 'query', query: 'x' }, 'allow'],
    ['memory', { action: 'add', text: 'x' }, 'deny'],
    ['plugin_manager', { action: 'list_bundles' }, 'deny'],
    ['schedule_create', { title: 'x' }, 'deny'],
    ['subagent', { description: 'x', prompt: 'y' }, 'allow'],
    ['spawn_teammate', { name: 'x', prompt: 'y' }, 'deny'],
    ['present', { files: [] }, 'allow'],
    ['ppt_create', { title: 'x' }, 'deny'],
    ['mystery_tool', {}, 'deny'],
  ]
  const bad = []
  for (const [name, args, want] of cases) {
    const got = evaluatePolicy({ name, args, workspaceRoot: ws, home }) === undefined ? 'allow' : 'deny'
    if (got !== want) bad.push(`${name} ${JSON.stringify(args)} ⇒ ${got}（期望 ${want}）`)
  }
  if (bad.length) {
    console.log('❌ audit-enforce 自检失败：\n  - ' + bad.join('\n  - '))
    return 3
  }
  console.log(`✓ audit-enforce 自检通过：${cases.length} 个样本（写区内放行 / 写区外拒绝 / 系统变更拒绝 / 只读工具放行）`)
  return 0
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.includes('--self-test')) {
    try { process.exit(selfTest()) } catch (error) {
      console.log('❌ 自检崩了：' + describeError(error))
      process.exit(3)
    }
  } else {
    console.log('用法：node enforce.js --self-test（本文件是 DSH 宿主插件，直接运行只做自检）')
    process.exit(0)
  }
}

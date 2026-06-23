#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const defaultOlderThanSeconds = 10 * 60
const defaultGraceMs = 1500

const options = parseArgs(process.argv.slice(2))
const selfPid = process.pid

const helperMatchers = [
  {
    id: 'context7-mcp',
    isNode: true,
    match: (command) => command.includes('@upstash/context7-mcp') || /\bcontext7-mcp\b/.test(command),
  },
  {
    id: 'xcodebuildmcp',
    isNode: true,
    match: (command) => /\bxcodebuildmcp\b/.test(command),
  },
  {
    id: 'firebase-mcp',
    isNode: true,
    match: (command) => (
      command.includes('firebase-tools') ||
      /\/bin\/firebase\b/.test(command)
    ) && /\bmcp\b/.test(command),
  },
  {
    id: 'supabase-mcp',
    isNode: true,
    match: (command) => (
      command.includes('@supabase/mcp-server-supabase') ||
      /\bmcp-server-supabase\b/.test(command)
    ),
  },
  {
    id: 'node-repl',
    isNode: true,
    match: (command) => command.includes('/cua_node/bin/node_repl'),
  },
  {
    id: 'pencil-mcp',
    isNode: false,
    match: (command) => command.includes('/Pencil.app/') && command.includes('mcp-server'),
  },
]

if (options.help) {
  printHelp()
  process.exit(0)
}

if (options.kill && !options.yes) {
  fail('Refusing to kill processes without --yes. Re-run with --kill --yes after checking the dry run.')
}

const snapshot = await listProcesses()
const analysis = analyze(snapshot, options)
printReport(analysis, options)

if (options.kill && analysis.killGroups.length > 0) {
  await terminateGroups(analysis.killGroups, options)
}

function parseArgs(args) {
  const parsed = {
    dryRun: true,
    kill: false,
    yes: false,
    force: false,
    all: false,
    includeNonNode: false,
    olderThanSeconds: defaultOlderThanSeconds,
    graceMs: defaultGraceMs,
    signal: 'SIGTERM',
    help: false,
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--dry-run') parsed.dryRun = true
    else if (arg === '--kill') {
      parsed.kill = true
      parsed.dryRun = false
    } else if (arg === '--yes') parsed.yes = true
    else if (arg === '--force') parsed.force = true
    else if (arg === '--all') parsed.all = true
    else if (arg === '--include-non-node') parsed.includeNonNode = true
    else if (arg === '--older-than') {
      index += 1
      parsed.olderThanSeconds = parseDuration(args[index], '--older-than')
    } else if (arg.startsWith('--older-than=')) {
      parsed.olderThanSeconds = parseDuration(arg.slice('--older-than='.length), '--older-than')
    } else if (arg === '--grace-ms') {
      index += 1
      parsed.graceMs = parsePositiveInteger(args[index], '--grace-ms')
    } else if (arg.startsWith('--grace-ms=')) {
      parsed.graceMs = parsePositiveInteger(arg.slice('--grace-ms='.length), '--grace-ms')
    } else if (arg === '--signal') {
      index += 1
      parsed.signal = parseSignal(args[index])
    } else if (arg.startsWith('--signal=')) {
      parsed.signal = parseSignal(arg.slice('--signal='.length))
    } else {
      fail(`Unknown argument: ${arg}`)
    }
  }

  return parsed
}

function parseDuration(value, flagName) {
  if (!value) fail(`${flagName} needs a value like 10m, 1h, 90s, or 0.`)
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value)
  if (!match) fail(`${flagName} has invalid duration: ${value}`)
  const amount = Number(match[1])
  const unit = match[2] || 's'
  if (unit === 'ms') return Math.ceil(amount / 1000)
  if (unit === 's') return amount
  if (unit === 'm') return amount * 60
  if (unit === 'h') return amount * 60 * 60
  return amount
}

function parsePositiveInteger(value, flagName) {
  if (!/^\d+$/.test(value || '')) fail(`${flagName} needs a positive integer.`)
  return Number(value)
}

function parseSignal(value) {
  const signal = String(value || '').toUpperCase()
  if (!/^SIG[A-Z0-9]+$/.test(signal)) fail(`Invalid signal: ${value}`)
  return signal
}

async function listProcesses() {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,pgid=,etime=,rss=,command='], {
    maxBuffer: 8 * 1024 * 1024,
  })

  return stdout
    .split('\n')
    .map(parsePsLine)
    .filter(Boolean)
}

function parsePsLine(line) {
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line)
  if (!match) return null
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    pgid: Number(match[3]),
    etime: match[4],
    elapsedSeconds: parseEtime(match[4]),
    rssKb: Number(match[5]),
    command: match[6],
  }
}

function parseEtime(value) {
  const [dayPart, timePart] = value.includes('-') ? value.split('-', 2) : [null, value]
  const parts = timePart.split(':').map(Number)
  let seconds = 0
  if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2]
  else if (parts.length === 2) seconds = parts[0] * 60 + parts[1]
  else seconds = parts[0] || 0
  return seconds + (dayPart ? Number(dayPart) * 24 * 3600 : 0)
}

function analyze(processes, opts) {
  const byPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]))
  const childrenByParent = new Map()
  for (const processInfo of processes) {
    if (!childrenByParent.has(processInfo.ppid)) childrenByParent.set(processInfo.ppid, [])
    childrenByParent.get(processInfo.ppid).push(processInfo)
  }

  const desktopRoots = processes.filter(isCodexDesktopAppServer)
  const desktopDescendantPids = new Set()
  for (const root of desktopRoots) collectDescendants(root.pid, childrenByParent, desktopDescendantPids)

  const groupMap = new Map()
  const skippedNonNode = []

  for (const pid of desktopDescendantPids) {
    if (pid === selfPid) continue
    const processInfo = byPid.get(pid)
    if (!processInfo) continue
    const helper = helperMatchers.find((matcher) => matcher.match(processInfo.command))
    if (!helper) continue
    if (!helper.isNode && !opts.includeNonNode) {
      skippedNonNode.push({ ...processInfo, helperId: helper.id })
      continue
    }
    if (!groupMap.has(processInfo.pgid)) {
      groupMap.set(processInfo.pgid, {
        pgid: processInfo.pgid,
        helperId: helper.id,
        processes: [],
        matchingCommands: new Set(),
      })
    }
    const group = groupMap.get(processInfo.pgid)
    group.helperId = group.helperId || helper.id
    group.processes.push(processInfo)
    group.matchingCommands.add(processInfo.command)
  }

  const groups = [...groupMap.values()]
    .filter((group) => group.pgid > 1)
    .map((group) => completeGroup(group, processes))
    .filter((group) => !isProtectedGroup(group))
    .sort((left, right) => right.elapsedSeconds - left.elapsedSeconds)

  const newestByHelper = new Map()
  for (const group of groups) {
    const current = newestByHelper.get(group.helperId)
    if (!current || group.elapsedSeconds < current.elapsedSeconds) newestByHelper.set(group.helperId, group)
  }

  const killGroups = []
  const keptGroups = []
  for (const group of groups) {
    const isNewest = newestByHelper.get(group.helperId)?.pgid === group.pgid
    const isOldEnough = group.elapsedSeconds >= opts.olderThanSeconds
    if (!opts.all && isNewest) keptGroups.push({ ...group, reason: 'newest for helper' })
    else if (!isOldEnough) keptGroups.push({ ...group, reason: `younger than ${formatDuration(opts.olderThanSeconds)}` })
    else killGroups.push(group)
  }

  return {
    desktopRoots,
    groups,
    killGroups,
    keptGroups,
    skippedNonNode,
  }
}

function isCodexDesktopAppServer(processInfo) {
  return (
    processInfo.command.includes('/Applications/Codex.app/') &&
    processInfo.command.includes('/Contents/Resources/codex app-server')
  )
}

function collectDescendants(pid, childrenByParent, output) {
  for (const child of childrenByParent.get(pid) || []) {
    if (output.has(child.pid)) continue
    output.add(child.pid)
    collectDescendants(child.pid, childrenByParent, output)
  }
}

function completeGroup(group, processes) {
  const groupProcesses = processes
    .filter((processInfo) => processInfo.pgid === group.pgid)
    .sort((left, right) => left.pid - right.pid)
  const matchingProcesses = group.processes.sort((left, right) => left.pid - right.pid)
  const elapsedSeconds = Math.max(...matchingProcesses.map((processInfo) => processInfo.elapsedSeconds))
  const rssKb = groupProcesses.reduce((sum, processInfo) => sum + processInfo.rssKb, 0)
  return {
    ...group,
    processes: groupProcesses,
    matchingProcesses,
    elapsedSeconds,
    rssKb,
    displayCommand: shortestUsefulCommand([...group.matchingCommands][0] || groupProcesses[0]?.command || ''),
  }
}

function isProtectedGroup(group) {
  if (group.processes.some((processInfo) => processInfo.pid === selfPid)) return true
  return group.processes.some((processInfo) => (
    processInfo.command.includes('/Users/plevi/Coding/TurboLearner/') ||
    processInfo.command.includes('server/index.mjs') ||
    processInfo.command.includes('node_modules/.bin/vite') ||
    processInfo.command.includes('node_modules/.bin/nodemon')
  ))
}

function shortestUsefulCommand(command) {
  return command
    .replace(/--api-key\s+\S+/g, '--api-key ***')
    .replace(/\s+/g, ' ')
    .trim()
}

function printReport(analysis, opts) {
  const mode = opts.kill ? 'KILL' : 'DRY RUN'
  const processCount = analysis.killGroups.reduce((sum, group) => sum + group.processes.length, 0)
  const totalRssKb = analysis.killGroups.reduce((sum, group) => sum + group.rssKb, 0)

  console.log(`Codex Desktop roots: ${analysis.desktopRoots.length ? analysis.desktopRoots.map((root) => root.pid).join(', ') : 'none'}`)
  console.log(`Mode: ${mode}`)
  console.log(`Selection: Codex Desktop helper process groups, older than ${formatDuration(opts.olderThanSeconds)}, ${opts.all ? 'including newest helper groups' : 'keeping newest group per helper'}`)
  console.log(`Signal: ${opts.signal}${opts.force ? `, then SIGKILL after ${opts.graceMs}ms if still alive` : ''}`)
  console.log(`Targets: ${analysis.killGroups.length} process groups, ${processCount} processes, ${formatMb(totalRssKb)} RSS`)
  console.log('')

  if (analysis.killGroups.length > 0) {
    console.log(opts.kill ? 'Signaling:' : 'Would signal:')
    printGroupTable(analysis.killGroups)
    console.log('')
  }

  if (analysis.keptGroups.length > 0) {
    console.log('Kept:')
    printGroupTable(analysis.keptGroups, true)
    console.log('')
  }

  if (analysis.skippedNonNode.length > 0 && !opts.includeNonNode) {
    const helpers = new Set(analysis.skippedNonNode.map((processInfo) => processInfo.helperId))
    console.log(`Skipped non-node helpers: ${analysis.skippedNonNode.length} processes (${[...helpers].join(', ')}). Use --include-non-node to include them.`)
    console.log('')
  }

  if (!opts.kill) {
    console.log('No processes were changed.')
    if (analysis.killGroups.length > 0) {
      console.log('To apply: npm run cleanup:codex -- --kill --yes')
      console.log('More aggressive: npm run cleanup:codex -- --older-than 0 --all --kill --yes --force')
    }
  }
}

function printGroupTable(groups, showReason = false) {
  for (const group of groups) {
    const pids = group.processes.map((processInfo) => processInfo.pid).join(',')
    const reason = showReason ? group.reason : ''
    console.log([
      `pgid=${group.pgid}`,
      `helper=${group.helperId}`,
      `age=${formatDuration(group.elapsedSeconds)}`,
      `rss=${formatMb(group.rssKb)}`,
      `pids=${pids}`,
      `${reason}`,
      `cmd=${group.displayCommand}`,
    ].filter(Boolean).join(' | '))
  }
}

async function terminateGroups(groups, opts) {
  const pgids = groups.map((group) => group.pgid)
  for (const pgid of pgids) {
    signalGroup(pgid, opts.signal)
  }

  await sleep(opts.graceMs)
  const remaining = await remainingGroups(pgids)

  if (remaining.length > 0 && opts.force) {
    for (const pgid of remaining) signalGroup(pgid, 'SIGKILL')
    await sleep(250)
  }

  const finalRemaining = await remainingGroups(pgids)
  if (finalRemaining.length > 0) {
    console.log(`Still running after ${opts.signal}: ${finalRemaining.map((pgid) => `pgid=${pgid}`).join(', ')}`)
    if (!opts.force) console.log('Re-run with --force to send SIGKILL after the grace period.')
  } else {
    console.log('Cleanup complete.')
  }
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal)
    console.log(`Sent ${signal} to pgid=${pgid}`)
  } catch (error) {
    console.warn(`Failed to send ${signal} to pgid=${pgid}: ${error.message}`)
  }
}

async function remainingGroups(pgids) {
  const processes = await listProcesses()
  const livePgids = new Set(processes.map((processInfo) => processInfo.pgid))
  return pgids.filter((pgid) => livePgids.has(pgid))
}

function formatDuration(seconds) {
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m${seconds % 60}s`
  return `${seconds}s`
}

function formatMb(kb) {
  return `${Math.round(kb / 1024)} MB`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function printHelp() {
  console.log(`
Usage:
  npm run cleanup:codex
  npm run cleanup:codex -- --kill --yes

Safely clean stale Codex Desktop helper process groups.

Defaults:
  - dry run only
  - only descendants of the Codex Desktop app-server
  - only node/npm helper groups
  - keep newest process group for each helper
  - target groups older than 10m
  - skip TurboLearner dev-server and app-server processes

Options:
  --kill                Send signals instead of only printing a report.
  --yes                 Required with --kill.
  --force               Send SIGKILL after the grace period if SIGTERM did not exit.
  --all                 Do not keep the newest group per helper.
  --older-than <time>   Target age threshold, e.g. 0, 90s, 10m, 1h.
  --signal <signal>     Signal to send first. Default: SIGTERM.
  --grace-ms <ms>       Wait before checking remaining groups. Default: 1500.
  --include-non-node    Also include non-node Codex helpers such as Pencil MCP.
  --help                Show this help.
`.trim())
}

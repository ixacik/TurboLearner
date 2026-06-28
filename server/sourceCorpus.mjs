import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'

export const sourceCorpusFileName = 'source-corpus.txt'
export const sourceCorpusHeaderPrefix = '@@TURBOLEARNER_SOURCE '

const defaultSearchContextLines = 20
const defaultSearchLimit = 30
const defaultMaxChars = 200_000

export function topicSourceCorpusPath(topicDir) {
  return path.join(topicDir, sourceCorpusFileName)
}

export function buildSourceCorpusText({ topicId, sources }) {
  const lines = [
    '# TurboLearner Source Corpus',
    `# topicId: ${topicId}`,
    '# This file is generated from extracted topic sources. Do not edit by hand.',
    '',
  ]

  for (const source of sources) {
    const metadata = {
      id: source.id,
      name: source.name,
      relativePath: source.relativePath || '',
      extension: source.extension || '',
    }
    lines.push(`${sourceCorpusHeaderPrefix}${JSON.stringify(metadata)}`)
    const normalizedText = normalizeCorpusText(source.text)
    if (normalizedText) lines.push(...normalizedText.split('\n'))
    lines.push('@@TURBOLEARNER_END_SOURCE')
    lines.push('')
  }

  return `${lines.join('\n').replace(/\r\n?/g, '\n')}\n`
}

export function writeSourceCorpus({ topicId, topicDir, sources }) {
  fs.mkdirSync(topicDir, { recursive: true })
  const corpusPath = topicSourceCorpusPath(topicDir)
  const text = buildSourceCorpusText({ topicId, sources })
  fs.writeFileSync(corpusPath, text, 'utf8')
  return summarizeSourceCorpus(corpusPath)
}

export function summarizeSourceCorpus(corpusPath) {
  if (!fs.existsSync(corpusPath)) {
    return {
      path: corpusPath,
      exists: false,
      sourceCount: 0,
      lineCount: 0,
      sizeBytes: 0,
    }
  }

  const text = fs.readFileSync(corpusPath, 'utf8')
  return {
    path: corpusPath,
    exists: true,
    sourceCount: text.split('\n').filter((line) => line.startsWith(sourceCorpusHeaderPrefix)).length,
    lineCount: text ? text.split('\n').length : 0,
    sizeBytes: Buffer.byteLength(text, 'utf8'),
  }
}

export function searchSourceCorpus({
  corpusPath,
  query,
  context = defaultSearchContextLines,
  limit = defaultSearchLimit,
  maxChars = defaultMaxChars,
  sourcePattern = '',
  caseSensitive = false,
  randomize = true,
  sampleSeed = '',
}) {
  const rawQuery = String(query ?? '')
  if (rawQuery.length === 0) throw new Error('Search regex is required.')
  if (!fs.existsSync(corpusPath)) throw new Error(`Source corpus not found: ${corpusPath}`)

  const text = fs.readFileSync(corpusPath, 'utf8')
  const lines = text.split('\n')
  const matcher = buildMatcher(rawQuery, { caseSensitive })
  const sourceMatcher = sourcePattern
    ? buildMatcher(sourcePattern, { caseSensitive: false })
    : null
  const safeContext = clampInteger(context, 0, 80, defaultSearchContextLines)
  const safeLimit = clampInteger(limit, 1, 200, defaultSearchLimit)
  const safeMaxChars = clampInteger(maxChars, 2_000, 200_000, defaultMaxChars)
  const candidates = []
  let currentSource = null
  let currentSourceStartIndex = 0

  for (const [index, line] of lines.entries()) {
    const source = parseSourceHeader(line)
    if (source) {
      currentSource = source
      currentSourceStartIndex = index + 1
      continue
    }
    if (line.startsWith('@@TURBOLEARNER_')) continue
    if (sourceMatcher && !sourceMatcher.test(`${currentSource?.name || ''} ${currentSource?.relativePath || ''}`)) continue
    if (!matcher.test(line)) continue

    const lineNumber = index + 1
    const startIndex = boundedContextStart(lines, Math.max(currentSourceStartIndex, index - safeContext), index)
    const endIndex = boundedContextEnd(lines, index, Math.min(lines.length - 1, index + safeContext))
    candidates.push({
      source: currentSource,
      sourceKey: currentSource?.id || currentSource?.name || 'unknown-source',
      lineNumber,
      lineStart: startIndex + 1,
      lineEnd: endIndex + 1,
      matchLine: line,
      contextLines: lines.slice(startIndex, endIndex + 1).map((contextLine, offset) => ({
        lineNumber: startIndex + offset + 1,
        text: contextLine,
      })),
    })
  }

  const pool = randomize && candidates.length > 1
    ? shuffle(candidates, sampleSeed)
    : candidates
  const hits = pool.slice(0, safeLimit)

  return {
    query: rawQuery,
    corpusPath,
    hitCount: hits.length,
    totalMatchCount: candidates.length,
    hits,
    truncatedByLimit: hits.length < candidates.length,
    randomized: Boolean(randomize),
    output: formatSourceSearchResults({
      query: rawQuery,
      corpusPath,
      hits,
      limit: safeLimit,
      maxChars: safeMaxChars,
      totalMatchCount: candidates.length,
      randomize: Boolean(randomize),
    }),
  }
}

export function formatSourceSearchResults({
  query,
  hits,
  limit,
  maxChars,
  totalMatchCount = hits.length,
  randomize = true,
}) {
  const parts = [
    `TurboLearner source regex: ${JSON.stringify(query)}`,
    `Showing ${hits.length}${randomize ? ' sampled' : ''} snippet${hits.length === 1 ? '' : 's'} from ${totalMatchCount} match${totalMatchCount === 1 ? '' : 'es'}${hits.length >= limit && hits.length < totalMatchCount ? ` (limit ${limit})` : ''}.`,
  ]
  if (hits.length === 0) {
    parts.push('No matches. Try a different JavaScript regex pattern, such as an explicit whitespace or boundary pattern.')
  }

  for (const [index, hit] of hits.entries()) {
    const source = hit.source || {}
    parts.push(`SOURCE ${index + 1}: ${source.name || 'unknown'}. ${formatContextBlob(hit.contextLines)}`)
  }

  const output = `${parts.join('\n')}\n`
  if (output.length <= maxChars) return output
  return `${output.slice(0, maxChars)}\n[truncated at ${maxChars} characters; rerun with a narrower query or lower --limit]\n`
}

function buildMatcher(query, { caseSensitive }) {
  try {
    return new RegExp(query, caseSensitive ? '' : 'i')
  } catch (error) {
    throw new Error(`Invalid source-search regex ${JSON.stringify(query)}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function parseSourceHeader(line) {
  if (!line.startsWith(sourceCorpusHeaderPrefix)) return null
  try {
    return JSON.parse(line.slice(sourceCorpusHeaderPrefix.length))
  } catch {
    return { name: 'unknown' }
  }
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(number)))
}

function boundedContextStart(lines, startIndex, matchIndex) {
  let bounded = startIndex
  for (let index = matchIndex - 1; index >= startIndex; index -= 1) {
    if (
      parseSourceHeader(lines[index]) ||
      lines[index].startsWith('@@TURBOLEARNER_END_SOURCE')
    ) {
      bounded = index + 1
      break
    }
  }
  return bounded
}

function boundedContextEnd(lines, matchIndex, endIndex) {
  let bounded = endIndex
  for (let index = matchIndex + 1; index <= endIndex; index += 1) {
    if (
      parseSourceHeader(lines[index]) ||
      lines[index].startsWith('@@TURBOLEARNER_END_SOURCE')
    ) {
      bounded = index - 1
      break
    }
  }
  return bounded
}

function formatContextBlob(contextLines) {
  return normalizeOcrText(dedupeAdjacentLines(contextLines
    .map((line) => line.text)
    .filter((line) => !line.startsWith('@@TURBOLEARNER_'))
    .map((line) => line.trim())
    .filter(Boolean))
    .join(' '))
}

function shuffle(items, seed) {
  const copy = [...items]
  const randomInt = seed ? seededRandomInt(seed) : cryptoRandomInt
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1)
    const value = copy[index]
    copy[index] = copy[swapIndex]
    copy[swapIndex] = value
  }
  return copy
}

function cryptoRandomInt(maxExclusive) {
  return crypto.randomInt(maxExclusive)
}

function seededRandomInt(seed) {
  let state = hashSeed(seed)
  return (maxExclusive) => {
    state = Math.imul(1664525, state) + 1013904223
    state >>>= 0
    return Math.floor((state / 0x100000000) * maxExclusive)
  }
}

function hashSeed(seed) {
  let hash = 2166136261
  for (const char of String(seed)) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0 || 1
}

function dedupeAdjacentLines(lines) {
  const output = []
  let previous = ''
  for (const line of lines) {
    const normalized = line.replace(/\s+/g, ' ').trim()
    if (!normalized || normalized === previous) continue
    output.push(normalized)
    previous = normalized
  }
  return output
}

function normalizeOcrText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeCorpusText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\f/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join('\n')
    .trim()
}

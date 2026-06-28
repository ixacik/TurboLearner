#!/usr/bin/env node
import path from 'node:path'
import { searchSourceCorpus, topicSourceCorpusPath } from '../server/sourceCorpus.mjs'

const appRoot = process.cwd()

function main() {
  const { topicId, query, options } = parseArgs(process.argv.slice(2))
  if (!topicId || !query) {
    printUsage()
    process.exitCode = 1
    return
  }

  const topicDir = path.join(appRoot, '.turbolearner', 'topics', sanitizePathSegment(topicId))
  const corpusPath = topicSourceCorpusPath(topicDir)
  try {
    const result = searchSourceCorpus({
      corpusPath,
      query,
      context: options.context,
      limit: options.limit,
      maxChars: options.maxChars,
      sourcePattern: options.source,
      caseSensitive: options.caseSensitive,
      randomize: options.randomize,
      sampleSeed: options.seed,
    })
    process.stdout.write(result.output)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

function parseArgs(args) {
  const positionals = []
  const options = {
    context: 20,
    limit: 30,
    maxChars: 200_000,
    source: '',
    caseSensitive: false,
    randomize: true,
    seed: '',
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--context') options.context = args[++index]
    else if (arg === '--limit') options.limit = args[++index]
    else if (arg === '--max-chars') options.maxChars = args[++index]
    else if (arg === '--source') options.source = args[++index] || ''
    else if (arg === '--case-sensitive') options.caseSensitive = true
    else if (arg === '--ordered') options.randomize = false
    else if (arg === '--seed') options.seed = args[++index] || ''
    else if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    } else {
      positionals.push(arg)
    }
  }

  return {
    topicId: positionals[0] || '',
    query: positionals.slice(1).join(' '),
    options,
  }
}

function sanitizePathSegment(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '')
}

function printUsage() {
  process.stdout.write(`Usage:
  node scripts/searchTopicSource.mjs <topicId> <regex> [--context 20] [--limit 30] [--source source-regex] [--ordered]

Examples:
  node scripts/searchTopicSource.mjs introduction-to-rl "Dyna " --context 12 --limit 20
  node scripts/searchTopicSource.mjs introduction-to-rl "Dyna\\s" --context 12 --limit 20
  node scripts/searchTopicSource.mjs introduction-to-rl "Q\\(s,\\s*a\\)" --context 8

Notes:
  The search term is always interpreted as a JavaScript regular expression, not literal text.
  Spaces inside quotes are preserved, including a trailing space in patterns like "Dyna ".
  --limit is the maximum number of matching snippets to display.
  Results are sampled by default when there are more matches than the limit.
  Use --ordered for first-match ordering and --seed <value> for repeatable sampling.
  Use --case-sensitive when capitalization should matter. The --source filter is also regex.
`)
}

main()

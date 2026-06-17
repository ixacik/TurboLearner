import fs from 'node:fs'
import path from 'node:path'

const bankPath = path.resolve('public/questions.json')
const reportPath = path.resolve('docs/question-bank-audit.md')
const bank = JSON.parse(fs.readFileSync(bankPath, 'utf8'))

const expected = {
  'practice-exam': {
    title: 'Practice Exam',
    numbers: [
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
      '12',
      '13',
      '14',
      '15',
      '16',
      '17',
      '18',
      '20',
      '21',
      '22',
      '23',
      '23a',
      '23b',
      '23c',
      '26',
      '25a',
      '25b',
    ],
    expectedGroups: {
      'practice-exam-q25': ['25a', '25b'],
    },
    noImageNumbers: ['23a'],
  },
  'last-year-exam': {
    title: "Last Year's Exam",
    numbers: [
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
      '12',
      '13',
      '14',
      '15',
      '16',
      '17',
      '18a',
      '18b',
      '18c',
      '18d',
      '19a',
      '19b',
      '19c',
      '19d',
    ],
    expectedGroups: {
      'last-year-exam-q18': ['18a', '18b', '18c', '18d'],
      'last-year-exam-q19': ['19a', '19b', '19c', '19d'],
    },
    noImageNumbers: ['18a', '18b', '18c', '18d', '19a', '19b', '19c', '19d'],
  },
}

const lines = [
  '# Question Bank Audit',
  '',
  `Generated: ${new Date().toISOString()}`,
  '',
  'This checks `public/questions.json` against the question structure sent in chat and the known grouping rules.',
  '',
]

let hasFailure = false

for (const [setId, expectation] of Object.entries(expected)) {
  const set = bank.sets.find((candidate) => candidate.id === setId)
  lines.push(`## ${expectation.title}`, '')

  if (!set) {
    hasFailure = true
    lines.push(`- FAIL: missing set \`${setId}\``, '')
    continue
  }

  const actualNumbers = set.questions.map((question) => question.number)
  const missing = expectation.numbers.filter((number) => !actualNumbers.includes(number))
  const extra = actualNumbers.filter((number) => !expectation.numbers.includes(number))
  const outOfOrder = actualNumbers.join('|') !== expectation.numbers.join('|')
  const rawScreenshotRefs = set.questions.filter((question) =>
    JSON.stringify(question).includes('/var/folders') ||
    JSON.stringify(question).includes('codex-clipboard'),
  )
  const contextlessLettered = set.questions.filter(
    (question) => /^\d+[a-z]+$/i.test(question.number) && !question.groupId,
  )
  const placeholders = set.questions.filter((question) =>
    /Python code shown|Missing source capture/i.test(
      `${question.prompt}\n${question.groupPrompt ?? ''}`,
    ),
  )
  const openWithOptions = set.questions.filter(
    (question) => question.type === 'open' && question.options.length > 0,
  )
  const singleOddOptions = set.questions.filter(
    (question) => question.type === 'single' && question.options.length !== 4,
  )

  pushCheck(lines, 'Question count', set.questions.length === expectation.numbers.length, `${set.questions.length}/${expectation.numbers.length}`)
  pushCheck(lines, 'Missing numbers', missing.length === 0, missing.join(', ') || 'none')
  pushCheck(lines, 'Extra numbers', extra.length === 0, extra.join(', ') || 'none')
  pushCheck(lines, 'Order matches chat capture', !outOfOrder, outOfOrder ? `actual: ${actualNumbers.join(', ')}` : 'yes')
  pushCheck(lines, 'No raw screenshot paths', rawScreenshotRefs.length === 0, rawScreenshotRefs.map((question) => question.number).join(', ') || 'none')
  pushCheck(lines, 'No missing source placeholders', placeholders.length === 0, placeholders.map((question) => question.number).join(', ') || 'none')
  pushCheck(lines, 'No open questions with options', openWithOptions.length === 0, openWithOptions.map((question) => question.number).join(', ') || 'none')

  for (const [groupId, expectedMembers] of Object.entries(expectation.expectedGroups)) {
    const actualMembers = set.questions
      .filter((question) => question.groupId === groupId)
      .sort((a, b) => (a.groupOrder ?? 0) - (b.groupOrder ?? 0))
      .map((question) => question.number)
    const ok = actualMembers.join('|') === expectedMembers.join('|')
    pushCheck(lines, `Group ${groupId}`, ok, actualMembers.join(', ') || 'none')
  }

  for (const number of expectation.noImageNumbers ?? []) {
    const question = set.questions.find((candidate) => candidate.number === number)
    const serialized = JSON.stringify(question ?? {})
    const hasImage =
      serialized.includes('<image>') ||
      serialized.includes('/generated-assets/') ||
      serialized.includes('/var/folders')
    pushCheck(lines, `No image for text/code question ${number}`, !hasImage, hasImage ? 'has image' : 'none')
    if (hasImage) hasFailure = true
  }

  lines.push('', 'Notes:', '')
  lines.push(`- Lettered questions without a shared group: ${contextlessLettered.map((question) => question.number).join(', ') || 'none'}`)
  lines.push(`- Questions with placeholder text: ${placeholders.map((question) => question.number).join(', ') || 'none'}`)
  lines.push(`- Single-answer questions with non-4 option counts: ${singleOddOptions.map((question) => `${question.number}(${question.options.length})`).join(', ') || 'none'}`)
  lines.push('')

  if (
    missing.length ||
    extra.length ||
    outOfOrder ||
    rawScreenshotRefs.length ||
    placeholders.length ||
    openWithOptions.length
  ) {
    hasFailure = true
  }
}

fs.writeFileSync(reportPath, `${lines.join('\n')}\n`)
console.log(`Wrote ${reportPath}`)
if (hasFailure) {
  console.error('Question bank audit failed. See docs/question-bank-audit.md.')
  process.exitCode = 1
}

function pushCheck(output, label, ok, detail) {
  output.push(`- ${ok ? 'PASS' : 'FAIL'}: ${label} — ${detail}`)
}

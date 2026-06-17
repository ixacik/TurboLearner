import fs from 'node:fs'
import path from 'node:path'

const sources = [
  {
    id: 'practice-exam',
    title: 'Practice Exam',
    description: 'Machine Learning BSc practice exam, 2024-2025.',
    path: '/Users/plevi/ML-Exam/practice_exam_questions.md',
  },
  {
    id: 'last-year-exam',
    title: "Last Year's Exam",
    description: "Previous Machine Learning exam questions.",
    path: '/Users/plevi/ML-Exam/last_year_exam_questions.md',
  },
]

const outPath = path.resolve('public/questions.json')
const schemaRef = 'schemas/question-bank.schema.json'

const schema = {
  version: 2,
  schemaRef,
  description:
    'Question bank for TurboLearner. Each question has an explicit type, prompt content with structured tags, options when applicable, and an answer object. The UI renders <math>, <image>, and <code> tags into KaTeX, local/remote images, and highlighted code blocks.',
  contentTags: {
    math: '<math>x^2</math> for inline LaTeX, or <math display>...</math> for display equations',
    image: '<image>/absolute/local/path.png</image> or <image>https://...</image>',
    code: '<code lang="python">...</code>; use lang="mermaid" for generated diagrams',
  },
  question: {
    id: 'stable string id',
    setId: 'id of parent set',
    source: 'human source label',
    number: 'exam question number as text',
    title: 'short display title',
    type: 'single | multiple | open',
    prompt: 'markdown prompt text with optional <math>, <image>, and <code> structured tags',
    points: 'optional numeric point value',
    options: [{ id: 'A', text: 'markdown option text with optional <math>...</math> tags' }],
    answer: {
      correctOptionIds: 'array when an answer key is known, otherwise null',
      expectedText: 'string for open questions when an answer key is known, otherwise null',
      source: 'provided | inferred | missing',
    },
    correctOptionIds: 'legacy optional array mirrored from answer.correctOptionIds when known',
    groupId: 'optional stable id when this question is part of a shared-context group',
    groupTitle: 'optional title for a shared-context group',
    groupPrompt: 'optional shared prompt rendered once above grouped subquestions',
    groupOrder: 'optional 0-based order within a shared-context group',
    concepts: 'optional tags used for review and generation',
  },
}

const manualTypeOverrides = {
  'practice-exam:5': 'multiple',
  'practice-exam:11': 'multiple',
  'practice-exam:16': 'multiple',
  'practice-exam:20': 'multiple',
  'practice-exam:23c': 'multiple',
  'practice-exam:26': 'multiple',
  'last-year-exam:2': 'multiple',
  'last-year-exam:6': 'multiple',
  'last-year-exam:19a': 'multiple',
  'last-year-exam:19c': 'multiple',
}

const sets = sources.map((source) => parseQuestionSet(source))
const bank = {
  schema,
  generatedAt: new Date().toISOString(),
  sets,
}

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, `${JSON.stringify(bank, null, 2)}\n`)
console.log(`Wrote ${outPath}`)
for (const set of sets) {
  console.log(`${set.title}: ${set.questions.length} questions`)
  const suspiciousSingles = set.questions.filter(
    (question) => question.type === 'single' && question.options.length !== 4,
  )
  for (const question of suspiciousSingles) {
    console.warn(
      `  warning: ${question.number} is single-answer with ${question.options.length} options`,
    )
  }
}

function parseQuestionSet(source) {
  const markdown = fs.readFileSync(source.path, 'utf8')
  const blocks = markdown
    .split(/\n---\n/g)
    .map((block) => block.trim())
    .filter((block) => /^##\s+Question/i.test(block))

  const questions = blocks.flatMap((block, index) => parseQuestionBlock(block, source, index))

  return {
    id: source.id,
    title: source.title,
    description: source.description,
    sourcePath: source.path,
    questions,
  }
}

function parseQuestionBlock(block, source, index) {
  const lines = block.split('\n')
  const heading = lines.shift()?.replace(/^##\s+/, '').trim() ?? `Question ${index + 1}`
  const body = lines.join('\n').trim()

  if (/^###\s+Question/im.test(body)) {
    return parseCompoundQuestionBlock(heading, body, source, index)
  }

  const parsed = parseQuestionParts({
    heading,
    body,
    source,
    index,
  })

  if (isContextOnly(parsed, body)) return []
  return [parsed]
}

function parseCompoundQuestionBlock(parentHeading, body, source, index) {
  const firstSubquestion = body.search(/^###\s+Question/im)
  const sharedContext = body.slice(0, firstSubquestion).trim()
  const subquestionText = body.slice(firstSubquestion).trim()
  const groupNumber = [...parentHeading.matchAll(/Question\s+([^\s-]+)/gi)].at(-1)?.[1] ?? String(index + 1)
  const groupImagePaths = [...sharedContext.matchAll(/Image:\s+`([^`]+)`/g)].map((match) => match[1])
  const groupId = `${source.id}-${slugQuestionNumber(groupNumber)}`
  const groupPrompt = normalizeStructuredTags(embedImages(cleanSharedContext(sharedContext), groupImagePaths))
  const groupTitle = cleanTitle(parentHeading, groupNumber)
  const subBlocks = subquestionText
    .split(/(?=^###\s+Question)/gm)
    .map((subBlock) => subBlock.trim())
    .filter(Boolean)

  return subBlocks.map((subBlock, subIndex) => {
    const lines = subBlock.split('\n')
    const heading = lines.shift()?.replace(/^###\s+/, '').trim() ?? parentHeading
    const body = lines.join('\n').trim()
    return parseQuestionParts({
      heading,
      body,
      source,
      index,
      subIndex,
      group: {
        id: groupId,
        title: groupTitle,
        prompt: groupPrompt,
        order: subIndex,
      },
    })
  })
}

function parseQuestionParts({ heading, body, sharedContext = '', source, index, subIndex = 0, group = null }) {
  const numberMatches = [...heading.matchAll(/Question\s+([^\s-]+)/gi)]
  const pointsMatch = heading.match(/(\d+(?:\.\d+)?)p/i)
  const number = numberMatches.at(-1)?.[1] ?? String(index + 1)
  const combined = [group ? '' : sharedContext, body].filter(Boolean).join('\n\n')
  const imagePaths = [...combined.matchAll(/Image:\s+`([^`]+)`/g)].map((match) => match[1])
  const optionLines = body.match(/^- .+$/gm) ?? []
  const options = optionLines.map((line, optionIndex) => ({
    id: optionId(optionIndex),
    text: normalizeStructuredTags(line.replace(/^- /, '').trim()),
  }))
  const prompt = normalizeStructuredTags(embedImages(
    [group ? '' : cleanSharedContext(sharedContext), stripOptionsAndAnswer(body)].filter(Boolean).join('\n\n'),
    imagePaths,
  ))
  const type = inferType(source.id, number, heading, prompt, options)
  const answer = {
    correctOptionIds: null,
    expectedText: null,
    source: 'missing',
  }

  return {
    id: `${source.id}-${slugQuestionNumber(number || `${index + 1}-${subIndex + 1}`)}`,
    setId: source.id,
    source: source.title,
    number,
    title: cleanTitle(heading, number),
    type,
    prompt,
    points: pointsMatch ? Number(pointsMatch[1]) : undefined,
    options,
    answer,
    imagePaths,
    groupId: group?.id,
    groupTitle: group?.title,
    groupPrompt: group?.prompt,
    groupOrder: group?.order,
    concepts: inferConcepts(`${heading}\n${prompt}`),
  }
}

function embedImages(prompt, imagePaths) {
  const cleanedPrompt = prompt.replace(/\n?Image:\s+`[^`]+`/g, '').trim()
  if (imagePaths.length === 0) return cleanedPrompt
  const imageTags = imagePaths.map((imagePath) => `<image>${imagePath}</image>`).join('\n\n')
  return `${cleanedPrompt}\n\n${imageTags}`.trim()
}

function stripOptionsAndAnswer(body) {
  return body
    .split('\n')
    .filter((line) => !line.startsWith('- '))
    .join('\n')
    .replace(/\n?Answer:\s*$/i, '')
    .trim()
}

function cleanSharedContext(context) {
  return context.replace(/\n?Image:\s+`[^`]+`/g, '').trim()
}

function normalizeStructuredTags(text) {
  return text
    .replace(/```([\w-]+)?\n([\s\S]*?)```/g, (_, lang = '', code = '') => {
      const langAttribute = lang ? ` lang="${lang}"` : ''
      return `\n\n<code${langAttribute}>\n${code.trimEnd()}\n</code>\n\n`
    })
    .replace(/`([^`\n]+)`/g, (_, code = '') => inlineBacktickTag(code))
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, math = '') => `<math display>${math.trim()}</math>`)
    .replace(/\$([^$\n]+)\$/g, (_, math = '') => `<math>${math.trim()}</math>`)
}

function inlineBacktickTag(rawCode) {
  const code = rawCode.trim()
  if (!code) return ''
  return isMathLikeInline(code) ? `<math>${code}</math>` : `<code>${code}</code>`
}

function isMathLikeInline(code) {
  if (/[\\/{}=+\-*^|]/.test(code)) return true
  if (/^[A-Z]\([^)]+\)$/.test(code)) return true
  if (/^[A-Za-z](?:_\{?[A-Za-z0-9]+\}?|\^\{?[A-Za-z0-9]+\}?|['’])*$/.test(code)) return true
  if (/^[A-Za-z]$/.test(code)) return true
  return false
}

function inferType(sourceId, number, heading, prompt, options) {
  const override = manualTypeOverrides[`${sourceId}:${number}`]
  if (override) return override

  if (options.length === 0 || /\bwrite|explain|name\b/i.test(prompt)) return 'open'
  if (/select all|select two|one or more|multiple answers|checkbox|option\(s\)|which of the following are|which statements|statements are valid|is\/are correct/i.test(`${heading}\n${prompt}`)) {
    return 'multiple'
  }
  return 'single'
}

function cleanTitle(heading, number) {
  const title = heading
    .replace(/^Question\s+[^\s-]+\s*[-/]?\s*/i, '')
    .replace(/\s+-\s+\d+(?:\.\d+)?p$/i, '')
    .trim()
  if (!title || /^\d+(?:\.\d+)?p$/i.test(title)) return `Question ${number}`
  return title
}

function optionId(index) {
  return String.fromCharCode(65 + index)
}

function slugQuestionNumber(number) {
  return `q${String(number).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

function isContextOnly(question, rawBody) {
  return question.options.length === 0 && !/\banswer:\s*$/i.test(rawBody)
}

function inferConcepts(text) {
  const rules = [
    ['roc', /roc|auc/i],
    ['metrics', /precision|recall|f1|rmse|r\^2|accuracy|true positives|false negatives/i],
    ['decision-trees', /decision tree|gini|entropy|pruning|split/i],
    ['ensembles', /bagging|boosting|random forest|adaboost|gradient boosting/i],
    ['bayesian', /bayes|posterior|prior|likelihood|map|mle|gaussian mixture/i],
    ['clustering', /cluster|k-means|silhouette|medoid/i],
    ['linear-models', /linear|regression|svm|kernel|perceptron/i],
    ['neural-networks', /neural|activation|softmax|sigmoid|loss/i],
    ['xai', /lime|explain|surrogate|probing|tcav|bias/i],
    ['features', /pca|feature|ordinal|dimensionality|normalis/i],
    ['experiments', /friedman|t-test|cross-validation|validation/i],
  ]
  return rules.filter(([, pattern]) => pattern.test(text)).map(([concept]) => concept)
}

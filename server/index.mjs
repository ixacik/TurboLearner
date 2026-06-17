import cors from 'cors'
import express from 'express'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..')
const app = express()
const port = Number(process.env.TURBOLEARNER_API_PORT || 8787)

const tutorThreads = new Map()
let codex

app.use(cors())
app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, codex: 'app-server', port })
})

app.get('/api/file', (req, res) => {
  const filePath = String(req.query.path || '')
  if (!filePath) {
    res.status(400).send('Missing path')
    return
  }
  res.sendFile(filePath, (error) => {
    if (error) res.status(404).send('File not found')
  })
})

app.post('/api/explain', (req, res) => {
  streamTutorTurn(req.body ?? {}, res).catch((error) => {
    if (!res.headersSent) {
      res.status(200).json(fallbackExplanation(req.body ?? {}, error))
      return
    }
    writeEvent(res, { type: 'final', response: fallbackExplanation(req.body ?? {}, error) })
    writeEvent(res, { type: 'done' })
    res.end()
  })
})

app.listen(port, () => {
  codex = new CodexAppServer()
  console.log(`TurboLearner Codex bridge listening on http://localhost:${port}`)
})

async function streamTutorTurn(payload, res) {
  res.set({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()

  const sessionId = String(payload.sessionId || payload.question?.id || 'default')
  const isFollowUp = payload.mode === 'chat'
  const isLearningRequest = payload.mode === 'learn'
  const threadId = await getTutorThread(sessionId)
  const prompt = isLearningRequest
    ? buildLearningPrompt(payload)
    : isFollowUp
      ? buildFollowUpPrompt(payload)
      : buildGradingPrompt(payload)
  const input = buildCodexInput(prompt, payload)
  let markdown = ''
  let grade = null
  let answerKey = null
  const gradeFilter = createGradeCallFilter((nextGrade) => {
    grade = nextGrade
  }, (nextAnswerKey) => {
    answerKey = nextAnswerKey
  })
  let settled = false

  writeEvent(res, { type: 'status', message: 'Asking Codex...' })

  res.on('close', () => {
    settled = true
  })

  await codex.startTurn({
    threadId,
    input,
    cwd: appRoot,
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
    onNotification: (message) => {
      if (settled) return

      if (message.method === 'turn/started') {
        writeEvent(res, { type: 'status', message: 'Codex is thinking...' })
        return
      }

      if (message.method === 'item/agentMessage/delta') {
        const delta = message.params?.delta ?? ''
        const visibleDelta = gradeFilter.push(delta)
        if (visibleDelta) {
          markdown += visibleDelta
          writeEvent(res, { type: 'delta', delta: visibleDelta })
        }
        return
      }

      if (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage') {
        return
      }
    },
  })

  if (settled) return
  const finalDelta = gradeFilter.flush()
  if (finalDelta) {
    markdown += finalDelta
    writeEvent(res, { type: 'delta', delta: finalDelta })
  }
  const response = tutorResponseFromMarkdown(payload, markdown, grade, answerKey)
  writeEvent(res, { type: 'final', response })
  writeEvent(res, { type: 'done' })
  res.end()
}

function buildCodexInput(prompt, payload) {
  const imageInputs = collectQuestionImageInputs(payload.question)
  const imageNote =
    imageInputs.length > 0
      ? `\n\nAttached question image${imageInputs.length === 1 ? '' : 's'}: ${imageInputs.length}. Use the attached pixels when grading or answering.`
      : ''

  return [
    { type: 'text', text: `${prompt}${imageNote}`, text_elements: [] },
    ...imageInputs,
  ]
}

function collectQuestionImageInputs(question) {
  const rawPaths = new Set()
  collectImagePaths(question, rawPaths)

  return [...rawPaths]
    .map((rawPath) => imagePathToInput(rawPath))
    .filter(Boolean)
}

function collectImagePaths(value, rawPaths) {
  if (!value || typeof value !== 'object') return

  for (const field of ['prompt', 'groupPrompt', 'sharedPrompt']) {
    if (typeof value[field] === 'string') {
      for (const imagePath of extractImageTags(value[field])) rawPaths.add(imagePath)
    }
  }

  if (Array.isArray(value.imagePaths)) {
    for (const imagePath of value.imagePaths) {
      if (typeof imagePath === 'string' && imagePath.trim()) rawPaths.add(imagePath.trim())
    }
  }

  if (Array.isArray(value.questions)) {
    for (const question of value.questions) collectImagePaths(question, rawPaths)
  }
}

function extractImageTags(markup) {
  const paths = []
  markup.replace(/<image>([\s\S]*?)<\/image>/gi, (_, rawPath) => {
    const imagePath = String(rawPath).trim()
    if (imagePath) paths.push(imagePath)
    return ''
  })
  return paths
}

function imagePathToInput(rawPath) {
  const imagePath = decodeImagePath(rawPath)
  if (/^https?:\/\//i.test(imagePath) || /^data:image\//i.test(imagePath)) {
    return { type: 'image', url: imagePath, detail: 'high' }
  }

  const localPath = resolveLocalImagePath(imagePath)
  if (!localPath || !fs.existsSync(localPath)) return null

  return { type: 'localImage', path: localPath, detail: 'high' }
}

function resolveLocalImagePath(imagePath) {
  if (path.isAbsolute(imagePath)) return imagePath
  if (/^\/generated-assets\//i.test(imagePath)) {
    return path.join(appRoot, 'public', imagePath)
  }
  if (/^generated-assets\//i.test(imagePath)) {
    return path.join(appRoot, 'public', imagePath)
  }
  return null
}

function decodeImagePath(imagePath) {
  try {
    return decodeURI(imagePath)
  } catch {
    return imagePath
  }
}

async function getTutorThread(sessionId) {
  const existing = tutorThreads.get(sessionId)
  if (existing) return existing

  const response = await codex.request('thread/start', {
    cwd: appRoot,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: true,
    developerInstructions: tutorDeveloperInstructions(),
  })
  const threadId = response.thread.id
  tutorThreads.set(sessionId, threadId)
  return threadId
}

function tutorDeveloperInstructions() {
  return `
You are Codex acting as the TurboLearner sidebar tutor for machine learning exam prep.

Do not edit files, run commands, or browse. Stay in teaching mode.

Write in natural GitHub-flavored Markdown. Be direct, but teach the idea.
You can organize the response however it flows best for the learner.
Use LaTeX for mathematical notation: inline math as $...$ and display math as $$...$$.
Do not put formulas, symbolic expressions, variable definitions, or short algorithmic steps in
fenced code blocks unless they are actual source code in a programming language. For pseudocode,
prefer normal prose lists with inline math.

The TurboLearner bridge exposes one state tool named grade. For submitted answers only,
finish your response with a final line in this exact form:
grade({"isCorrect":true,"score":0.9,"verdict":"Short verdict","nextPrompt":"Short follow-up question"})

For multiple-choice questions when you know the correct option id or ids, include a final hidden
answer key line immediately before grade, or as the final line when grade is not used:
answerKey({"correctOptionIds":["A","B"]})

Use score as a decimal from 0 to 1. Use isCorrect=true when the answer is substantially correct.
The grade and answerKey lines are tool calls for the app, not learner-facing prose.

For follow-up chat, answer the learner's question in Markdown and keep using the same tutoring style. If the learner asks for the answer, give it and explain why.
`.trim()
}

function buildGradingPrompt(payload) {
  return `
Grade this learner answer and teach the concept.

Question:
${JSON.stringify(payload.question, null, 2)}

Conversation so far:
${formatConversation(payload.messages)}

Learner answer:
${JSON.stringify(payload.answer, null, 2)}

Rules:
- If question.type is "group", grade every child in question.questions against the matching entry in answer.subAnswers, then give one overall score. Mention each subquestion briefly.
- For multiple-choice questions, compare selected option ids/text against the correct answer if present.
- Prefer question.answer.correctOptionIds or question.answer.expectedText when present. If those are missing, use legacy question.correctOptionIds if present.
- If no official answer is present, infer the answer from the concept and say that you inferred it.
- Do not only tell the learner whether they are correct. Give the correct answer, explain the concept, and connect related concepts.
- Use LaTeX math delimiters for formulas and symbolic notation. Avoid fenced code blocks unless showing real executable code.
- For multiple-choice questions, include answerKey({"correctOptionIds":[...]}) with the correct option ids.
`.trim()
}

function buildFollowUpPrompt(payload) {
  const latestUserMessage = [...(payload.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'learner')
  const isPreSubmit = payload.phase === 'pre_submit'
  const currentQuestion = isPreSubmit ? questionWithoutAnswerKey(payload.question) : payload.question

  return `
The learner is asking a follow-up in the same tutoring session.

Current question:
${JSON.stringify(currentQuestion, null, 2)}

Their current or submitted answer:
${JSON.stringify(payload.answer, null, 2)}

Conversation so far:
${formatConversation(payload.messages)}

Follow-up question:
${JSON.stringify(latestUserMessage?.content ?? '', null, 2)}

Answer conversationally in Markdown. Do not call grade for ordinary follow-up chat.
Use LaTeX math delimiters for formulas and symbolic notation. Avoid fenced code blocks unless showing real executable code.
${isPreSubmit ? preSubmitHintRules() : postSubmitChatRules()}
`.trim()
}

function buildLearningPrompt(payload) {
  return `
The learner chose "I don't know" for this question. This is a learning request, not a graded attempt.

Current question:
${JSON.stringify(payload.question, null, 2)}

Learner's current partial answer, if any:
${JSON.stringify(payload.answer, null, 2)}

Conversation so far:
${formatConversation(payload.messages)}

Teach the entire concept from zero.

Rules:
- Start from intuition and plain language before formal definitions.
- Give the correct answer and explain why it is correct.
- Explain why the tempting wrong answers or wrong approaches are wrong when options are available.
- Connect the idea to related machine-learning concepts, terminology, and exam patterns.
- Include a compact worked example or analogy when it helps.
- End with a short checklist the learner can use to recognize this concept next time.
- Use LaTeX math delimiters for formulas and symbolic notation. Avoid fenced code blocks unless showing real executable code.
- For multiple-choice questions, include answerKey({"correctOptionIds":[...]}) with the correct option ids as the final line.
- Do not call grade.
`.trim()
}

function formatConversation(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '(none)'

  return messages
    .slice(-12)
    .map((message) => {
      const role = message?.role === 'learner' ? 'Learner' : 'Tutor'
      const content = typeof message?.content === 'string' ? message.content.trim() : ''
      return `${role}: ${content || '(empty)'}`
    })
    .join('\n\n')
}

function preSubmitHintRules() {
  return `
This is before the learner has submitted for grading.
- Do not reveal the correct answer, correct option id, final formula, or whether their current choice is right.
- Explain the underlying concept, define terms, show a parallel example with different numbers/details, or ask a guiding question.
- If they directly ask for the answer, refuse briefly and give a useful hint instead.
- Keep it focused on helping them reason to the answer themselves.
`.trim()
}

function postSubmitChatRules() {
  return `
The learner has already submitted or is discussing the graded result.
- You may give the correct answer when relevant.
- Explain why it is correct and connect the related concepts.
`.trim()
}

function questionWithoutAnswerKey(question) {
  if (!question || typeof question !== 'object') return question
  const { answer, correctOptionIds, expectedAnswer, questions, ...rest } = question
  return {
    ...rest,
    questions: Array.isArray(questions) ? questions.map(questionWithoutAnswerKey) : questions,
  }
}

function tutorResponseFromMarkdown(payload, markdown, grade = null, answerKey = null) {
  const score = grade ? clamp(Number(grade.score), 0, 1) : extractScore(markdown)
  const verdict = grade?.verdict || extractLabel(markdown, 'Verdict') || firstTextLine(markdown) || 'Codex response.'
  const nextPrompt =
    grade?.nextPrompt ||
    extractSection(markdown, 'Follow-up') ||
    'Explain the key concept in your own words before moving on.'

  return {
    isCorrect: typeof grade?.isCorrect === 'boolean' ? grade.isCorrect : score >= 0.8,
    score,
    verdict,
    explanation: stripGradeToolCall(markdown).trim(),
    concepts: uniqueStrings([
      ...(payload.question?.concepts ?? []),
      ...((payload.question?.questions ?? []).flatMap((question) => question.concepts ?? [])),
    ]),
    nextPrompt: stripMarkdown(nextPrompt).trim(),
    correctOptionIds: answerKey?.correctOptionIds ?? undefined,
  }
}

function createGradeCallFilter(onGrade, onAnswerKey) {
  let pending = ''

  return {
    push(delta) {
      pending += delta
      let visible = ''

      while (true) {
        const newline = pending.match(/\r?\n/)
        if (!newline) break

        const lineEnd = newline.index
        const breakEnd = lineEnd + newline[0].length
        const line = pending.slice(0, lineEnd)
        const lineWithBreak = pending.slice(0, breakEnd)
        pending = pending.slice(breakEnd)

        const toolCall = parseHiddenToolCall(line)
        if (toolCall?.type === 'grade') onGrade(toolCall.value)
        else if (toolCall?.type === 'answerKey') onAnswerKey(toolCall.value)
        else visible += lineWithBreak
      }

      return visible
    },
    flush() {
      const toolCall = parseHiddenToolCall(pending)
      const visible = toolCall ? '' : pending
      if (toolCall?.type === 'grade') onGrade(toolCall.value)
      else if (toolCall?.type === 'answerKey') onAnswerKey(toolCall.value)
      pending = ''
      return visible
    },
  }
}

function parseHiddenToolCall(line) {
  const trimmed = line.trim()
  const gradeMatch = trimmed.match(/^grade\((\{[\s\S]*\})\)$/i)
  if (gradeMatch) {
    const grade = parseGradeToolCallJson(gradeMatch[1])
    return grade ? { type: 'grade', value: grade } : null
  }

  const answerKeyMatch = trimmed.match(/^answerKey\((\{[\s\S]*\})\)$/i)
  if (answerKeyMatch) {
    const answerKey = parseAnswerKeyToolCallJson(answerKeyMatch[1])
    return answerKey ? { type: 'answerKey', value: answerKey } : null
  }

  return null
}

function parseGradeToolCallJson(json) {
  try {
    const grade = JSON.parse(json)
    return {
      isCorrect: Boolean(grade.isCorrect),
      score: clamp(Number(grade.score), 0, 1),
      verdict: typeof grade.verdict === 'string' ? grade.verdict : '',
      nextPrompt: typeof grade.nextPrompt === 'string' ? grade.nextPrompt : '',
    }
  } catch {
    return null
  }
}

function parseAnswerKeyToolCallJson(json) {
  try {
    const answerKey = JSON.parse(json)
    const correctOptionIds = Array.isArray(answerKey.correctOptionIds)
      ? answerKey.correctOptionIds.filter((id) => typeof id === 'string' && id.trim())
      : []
    return correctOptionIds.length > 0 ? { correctOptionIds } : null
  } catch {
    return null
  }
}

function parseGradeToolCall(line) {
  const match = line.trim().match(/^grade\((\{[\s\S]*\})\)$/i)
  if (!match) return null

  return parseGradeToolCallJson(match[1])
}

function stripGradeToolCall(markdown) {
  return markdown
    .replace(/(?:^|\n)\s*answerKey\(\{[\s\S]*?\}\)\s*$/i, '')
    .replace(/(?:^|\n)\s*grade\(\{[\s\S]*?\}\)\s*$/i, '')
    .trim()
}

function extractScore(markdown) {
  const label = markdown.match(/\*\*Score:\*\*\s*([01](?:\.\d+)?|\d{1,3}%)/i)
  const plain = label ?? markdown.match(/\bscore\s*[:\-]\s*([01](?:\.\d+)?|\d{1,3}%)/i)
  if (!plain) return 0
  const raw = plain[1]
  if (raw.endsWith('%')) return clamp(Number(raw.slice(0, -1)) / 100, 0, 1)
  return clamp(Number(raw), 0, 1)
}

function extractLabel(markdown, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = markdown.match(new RegExp(`\\*\\*${escaped}:\\*\\*\\s*([^\\n]+)`, 'i'))
  return match?.[1]?.trim() ?? ''
}

function extractSection(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = markdown.match(new RegExp(`^##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, 'im'))
  return match?.[1]?.trim() ?? ''
}

function firstTextLine(markdown) {
  return stripMarkdown(markdown)
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
}

function stripMarkdown(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#*_`>\-]/g, '')
}

function fallbackExplanation(payload, error) {
  const question = payload.question ?? {}
  const answer = payload.answer ?? {}
  const selected = Array.isArray(answer.selectedOptionIds) ? answer.selectedOptionIds : []
  const correct = Array.isArray(question.answer?.correctOptionIds)
    ? question.answer.correctOptionIds
    : Array.isArray(question.correctOptionIds)
      ? question.correctOptionIds
      : []
  const canAutoGrade = question.type !== 'open' && question.kind !== 'open' && correct.length > 0
  const isCorrect = canAutoGrade && sameSet(selected, correct)

  return {
    isCorrect,
    score: canAutoGrade ? (isCorrect ? 1 : 0) : 0,
    verdict: canAutoGrade
      ? isCorrect
        ? 'Correct.'
        : 'Not correct yet.'
      : 'Codex was unavailable, so this needs manual review.',
    explanation:
      error instanceof Error
        ? `**Codex failed:** ${error.message}`
        : '**Codex failed.**',
    concepts: question.concepts ?? [],
    nextPrompt: 'Explain the key concept in your own words before moving on.',
  }
}

function sameSet(a, b) {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((item) => set.has(item))
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))]
}

function writeEvent(res, event) {
  res.write(`${JSON.stringify(event)}\n`)
}

class CodexAppServer {
  constructor() {
    this.proc = null
    this.rl = null
    this.nextId = 1
    this.pending = new Map()
    this.activeTurns = new Map()
    this.readyPromise = null
  }

  async request(method, params) {
    await this.ensureStarted()
    const id = this.nextId++
    this.proc.stdin.write(`${JSON.stringify({ method, id, params })}\n`)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
  }

  async startTurn({ threadId, input, cwd, approvalPolicy, sandboxPolicy, onNotification }) {
    await this.ensureStarted()
    const result = await this.request('turn/start', {
      threadId,
      input,
      cwd,
      approvalPolicy,
      sandboxPolicy,
    })
    const turnId = result.turn.id

    return new Promise((resolve, reject) => {
      this.activeTurns.set(turnId, { threadId, onNotification, resolve, reject })
    })
  }

  async ensureStarted() {
    if (this.readyPromise) return this.readyPromise
    this.readyPromise = this.start()
    return this.readyPromise
  }

  async start() {
    this.proc = spawn('codex', ['app-server', '--stdio', '-c', 'approval_policy="never"'], {
      cwd: appRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    })

    this.proc.stderr.on('data', (chunk) => {
      process.stderr.write(chunk)
    })

    this.proc.on('exit', () => {
      const error = new Error('Codex app-server exited.')
      for (const pending of this.pending.values()) pending.reject(error)
      for (const turn of this.activeTurns.values()) turn.reject(error)
      this.pending.clear()
      this.activeTurns.clear()
      this.readyPromise = null
      this.proc = null
      this.rl = null
    })

    this.rl = createInterface({ input: this.proc.stdout })
    this.rl.on('line', (line) => this.handleLine(line))

    const initialized = await this.rawRequest('initialize', {
      clientInfo: {
        name: 'turbolearner',
        title: 'TurboLearner',
        version: '0.0.0',
      },
      capabilities: { experimentalApi: true },
    })
    this.notify('initialized', {})
    return initialized
  }

  rawRequest(method, params) {
    const id = this.nextId++
    this.proc.stdin.write(`${JSON.stringify({ method, id, params })}\n`)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
  }

  notify(method, params) {
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`)
  }

  handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }

    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message || 'Codex request failed.'))
      else pending.resolve(message.result)
      return
    }

    const turnId = message.params?.turnId ?? message.params?.turn?.id
    const activeTurn = turnId ? this.activeTurns.get(turnId) : null
    if (!activeTurn) return

    activeTurn.onNotification(message)

    if (message.method === 'turn/completed') {
      this.activeTurns.delete(turnId)
      activeTurn.resolve(message.params)
    }
  }
}

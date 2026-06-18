import cors from 'cors'
import express from 'express'
import fs from 'node:fs'
import multer from 'multer'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..')
const app = express()
const port = Number(process.env.TURBOLEARNER_API_PORT || 8787)
const codexRequestTimeoutMs = Number(process.env.TURBOLEARNER_CODEX_REQUEST_TIMEOUT_MS || 30_000)
const codexTurnTimeoutMs = Number(process.env.TURBOLEARNER_CODEX_TURN_TIMEOUT_MS || 90_000)
const contextGenerationTurnTimeoutMs = Number(process.env.TURBOLEARNER_CONTEXT_TURN_TIMEOUT_MS || 10 * 60 * 1000)
const tutorThreadTtlMs = Number(process.env.TURBOLEARNER_TUTOR_THREAD_TTL_MS || 30 * 60 * 1000)
const tutorThreadCleanupIntervalMs = Math.min(tutorThreadTtlMs, 5 * 60 * 1000)
const contextDir = path.join(appRoot, '.turbolearner')
const contextUploadsDir = path.join(contextDir, 'uploads')
const contextStatePath = path.join(contextDir, 'context.json')
const textFileExtensions = new Set(['.txt', '.md', '.csv', '.json', '.log'])
const acceptedContextExtensions = new Set(['.pdf', ...textFileExtensions])

const tutorThreads = new Map()
let contextState = loadContextState()
let contextJobId = 0
let codex

fs.mkdirSync(contextUploadsDir, { recursive: true })

app.use(cors())
app.use(express.json({ limit: '1mb' }))

const uploadContextFiles = multer({
  storage: multer.diskStorage({
    destination: contextUploadsDir,
    filename: (_req, file, cb) => {
      const extension = path.extname(file.originalname).toLowerCase()
      const base = path.basename(file.originalname, extension).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80) || 'file'
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}-${base}${extension}`)
    },
  }),
  limits: {
    files: 24,
    fileSize: 100 * 1024 * 1024,
  },
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, codex: 'app-server', port })
})

app.get('/api/context', (_req, res) => {
  res.json(publicContextState())
})

app.post('/api/context/files', uploadContextFiles.array('files', 24), (req, res) => {
  const files = Array.isArray(req.files) ? req.files : []
  if (files.length === 0) {
    res.status(400).json({ error: 'No files uploaded.' })
    return
  }

  const jobId = ++contextJobId
  const uploadedFiles = files.map((file) => ({
    originalName: file.originalname,
    path: file.path,
    size: file.size,
    mimetype: file.mimetype,
    extension: path.extname(file.originalname).toLowerCase(),
  }))
  contextState = {
    status: 'processing',
    fileCount: uploadedFiles.length,
    files: uploadedFiles.map(({ originalName, size, extension }) => ({ name: originalName, size, extension })),
    generatedAt: null,
    injectedPrompt: '',
    error: null,
  }
  persistContextState()
  void generatePersistentContext(jobId, uploadedFiles)
  res.status(202).json(publicContextState())
})

app.delete('/api/context', (_req, res) => {
  contextJobId += 1
  contextState = emptyContextState()
  persistContextState()
  tutorThreads.clear()
  res.json(publicContextState())
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
  const cleanupInterval = setInterval(cleanupExpiredTutorThreads, tutorThreadCleanupIntervalMs)
  cleanupInterval.unref?.()
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
  cleanupExpiredTutorThreads()
  const now = Date.now()
  const existing = tutorThreads.get(sessionId)
  if (existing) {
    existing.lastUsedAt = now
    return existing.threadId
  }

  const response = await codex.request('thread/start', {
    cwd: appRoot,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: true,
    developerInstructions: tutorDeveloperInstructions(),
  })
  const threadId = response.thread.id
  tutorThreads.set(sessionId, { threadId, lastUsedAt: now })
  return threadId
}

function cleanupExpiredTutorThreads() {
  const now = Date.now()
  for (const [sessionId, record] of tutorThreads) {
    if (now - record.lastUsedAt > tutorThreadTtlMs) {
      tutorThreads.delete(sessionId)
    }
  }
}

function tutorDeveloperInstructions() {
  return [
    `
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
For grouped questions, include child question scores when possible:
grade({"isCorrect":true,"score":0.9,"verdict":"Short verdict","nextPrompt":"Short follow-up question","questionScores":{"question-id":1},"questionCorrectness":{"question-id":true}})

For every multiple-choice response that identifies any correct/accepted option, include a final hidden
answer key line immediately before grade, or as the final line when grade is not used. Use option.id,
not option.visibleLabel, in answerKey. If multiple options are true or accepted, include all of them:
answerKey({"correctOptionIds":["opt_example1","opt_example2"]})
For grouped questions, key answers by child question id:
answerKey({"correctOptionIdsByQuestion":{"question-id-1":["opt_example3"],"question-id-2":["opt_example4","opt_example5"]}})

Use score as a decimal from 0 to 1. Use isCorrect=true when the answer is substantially correct.
The grade and answerKey lines are tool calls for the app, not learner-facing prose.

For follow-up chat, answer the learner's question in Markdown and keep using the same tutoring style.
Before submission, follow the pre-submit hint rules and do not reveal the answer. After submission,
you may give the correct answer when relevant.
`.trim(),
    persistentCourseContextInstructions(),
  ].filter(Boolean).join('\n\n')
}

function persistentCourseContextInstructions() {
  if (contextState.status !== 'ready' || !contextState.injectedPrompt?.trim()) return ''
  return `
## TurboLearner Persistent Course Context

The following course scope was generated from learner-selected lecture files and is persistent.
Use it as the source of truth for what this course covered and at what depth.
You may use general knowledge to explain listed covered concepts, but align grading and expected
answers to the listed scope, notation, terminology, framing, and lecture-specific nuances.

${contextState.injectedPrompt.trim()}
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
- For grouped questions, include questionScores and questionCorrectness in the hidden grade line keyed by child question id.
- For multiple-choice questions, compare selected option ids/text against the correct answer if present. Option id is the canonical answer identity; visibleLabel is only the shuffled label shown to the learner.
- Prefer question.answer.correctOptionIds or question.answer.expectedText when present. If those are missing, use legacy question.correctOptionIds if present.
- If no official answer is present, infer the answer from the concept and say that you inferred it.
- For every multiple-choice grading response, emit answerKey with all canonical option.id values you accept as correct. If the question is flawed and multiple options are true, include every accepted true option in answerKey.
- Do not only tell the learner whether they are correct. Give the correct answer, explain the concept, and connect related concepts.
- For every open question, include a "Model answer" section even when the learner is correct. Put the model answer itself in a Markdown blockquote. Make it concise, exam-ready, and phrased the way a strong university answer should be written.
- For grouped questions with open child questions, include a separate model answer blockquote for each open child question under that child's feedback.
- For every multiple-choice question, include an option-by-option rationale that explicitly says why each available option is right or wrong. For grouped multiple-choice questions, do this under each child question.
- Use LaTeX math delimiters for formulas and symbolic notation. Avoid fenced code blocks unless showing real executable code.
- For multiple-choice questions, include answerKey({"correctOptionIds":[...]}) with canonical option.id values, not visibleLabel values. In the visible explanation, mention visibleLabel for the learner, but keep answerKey canonical.
- For grouped multiple-choice questions, include answerKey({"correctOptionIdsByQuestion":{...}}) keyed by child question id.
`.trim()
}

function buildFollowUpPrompt(payload) {
  const latestUserMessage = [...(payload.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'learner')
  const isPreSubmit = payload.phase === 'pre_submit'
  const currentQuestion = isPreSubmit ? questionWithoutAnswerKey(payload.question) : payload.question
  const request = typeof payload.request === 'string' && payload.request.trim()
    ? payload.request.trim()
    : latestUserMessage?.content ?? ''

  return `
The learner is asking a follow-up in the same tutoring session.

Current question:
${JSON.stringify(currentQuestion, null, 2)}

Their current or submitted answer:
${JSON.stringify(payload.answer, null, 2)}

Conversation so far:
${formatConversation(payload.messages)}

Learner request:
${JSON.stringify(request, null, 2)}

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
- For multiple-choice questions, include answerKey({"correctOptionIds":[...]}) with canonical option.id values, not visibleLabel values, as the final line.
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
- If the learner says they do not know, teach the underlying concept from first principles in a compact textbook style.
- Preserve desirable difficulty: the learner must still have to reason through and submit an answer.
- Do not reveal the correct answer, correct option id, final formula for this exact question, elimination path, or whether their current choice is right.
- Do not discuss each answer option, narrow the choices to a small set, or map the explanation directly onto the options.
- Use a parallel example with different numbers/details when useful, but do not solve this exact prompt.
- End with one guiding question or recognition cue that helps them decide what idea applies.
- If they directly ask for the answer, refuse briefly and give a useful hint instead.
- Do not call grade or answerKey.
- Keep it focused on helping them reason to the answer themselves without making the answer immediately inferable.
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
    correctOptionIdsByQuestion: answerKey?.correctOptionIdsByQuestion ?? undefined,
    questionScores: grade?.questionScores ?? undefined,
    questionCorrectness: grade?.questionCorrectness ?? undefined,
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
    const questionScores = parseQuestionScores(grade.questionScores)
    const questionCorrectness = parseQuestionCorrectness(grade.questionCorrectness)
    return {
      isCorrect: Boolean(grade.isCorrect),
      score: clamp(Number(grade.score), 0, 1),
      verdict: typeof grade.verdict === 'string' ? grade.verdict : '',
      nextPrompt: typeof grade.nextPrompt === 'string' ? grade.nextPrompt : '',
      ...(Object.keys(questionScores).length > 0 ? { questionScores } : {}),
      ...(Object.keys(questionCorrectness).length > 0 ? { questionCorrectness } : {}),
    }
  } catch {
    return null
  }
}

function parseQuestionScores(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  return Object.fromEntries(
    Object.entries(value)
      .map(([questionId, score]) => [questionId, Number(score)])
      .filter(([questionId, score]) => typeof questionId === 'string' && questionId.trim() && Number.isFinite(score))
      .map(([questionId, score]) => [questionId, clamp(score, 0, 1)])
  )
}

function parseQuestionCorrectness(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  return Object.fromEntries(
    Object.entries(value)
      .filter(([questionId, isCorrect]) => typeof questionId === 'string' && questionId.trim() && typeof isCorrect === 'boolean'),
  )
}

function parseAnswerKeyToolCallJson(json) {
  try {
    const answerKey = JSON.parse(json)
    const correctOptionIds = Array.isArray(answerKey.correctOptionIds)
      ? answerKey.correctOptionIds.filter((id) => typeof id === 'string' && id.trim())
      : []
    const correctOptionIdsByQuestion =
      answerKey.correctOptionIdsByQuestion &&
      typeof answerKey.correctOptionIdsByQuestion === 'object' &&
      !Array.isArray(answerKey.correctOptionIdsByQuestion)
        ? Object.fromEntries(
            Object.entries(answerKey.correctOptionIdsByQuestion)
              .map(([questionId, ids]) => [
                questionId,
                Array.isArray(ids)
                  ? ids.filter((id) => typeof id === 'string' && id.trim())
                  : [],
              ])
              .filter(([, ids]) => ids.length > 0),
          )
        : {}
    if (correctOptionIds.length === 0 && Object.keys(correctOptionIdsByQuestion).length === 0) {
      return null
    }
    return {
      ...(correctOptionIds.length > 0 ? { correctOptionIds } : {}),
      ...(Object.keys(correctOptionIdsByQuestion).length > 0
        ? { correctOptionIdsByQuestion }
        : {}),
    }
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

function emptyContextState() {
  return {
    status: 'idle',
    fileCount: 0,
    files: [],
    generatedAt: null,
    injectedPrompt: '',
    error: null,
  }
}

function loadContextState() {
  try {
    const rawState = JSON.parse(fs.readFileSync(contextStatePath, 'utf8'))
    if (rawState?.status === 'ready' && typeof rawState.injectedPrompt === 'string') {
      return {
        status: 'ready',
        fileCount: Number(rawState.fileCount) || 0,
        files: Array.isArray(rawState.files) ? rawState.files.map(publicContextFile) : [],
        generatedAt: typeof rawState.generatedAt === 'string' ? rawState.generatedAt : null,
        injectedPrompt: rawState.injectedPrompt,
        error: null,
      }
    }
    if (rawState?.status === 'error') {
      return {
        status: 'error',
        fileCount: Number(rawState.fileCount) || 0,
        files: Array.isArray(rawState.files) ? rawState.files.map(publicContextFile) : [],
        generatedAt: typeof rawState.generatedAt === 'string' ? rawState.generatedAt : null,
        injectedPrompt: typeof rawState.injectedPrompt === 'string' ? rawState.injectedPrompt : '',
        error: typeof rawState.error === 'string' ? rawState.error : 'Context generation failed.',
      }
    }
  } catch {
    // Missing or malformed context state should not block the tutor.
  }
  return emptyContextState()
}

function persistContextState() {
  fs.mkdirSync(contextDir, { recursive: true })
  fs.writeFileSync(contextStatePath, JSON.stringify(publicContextState(), null, 2))
}

function publicContextState() {
  return {
    status: contextState.status,
    fileCount: Number(contextState.fileCount) || 0,
    files: Array.isArray(contextState.files) ? contextState.files.map(publicContextFile) : [],
    generatedAt: contextState.generatedAt ?? null,
    injectedPrompt: typeof contextState.injectedPrompt === 'string' ? contextState.injectedPrompt : '',
    error: typeof contextState.error === 'string' ? contextState.error : null,
  }
}

function publicContextFile(file) {
  return {
    name: typeof file?.name === 'string' ? file.name : String(file?.originalName || 'Untitled file'),
    size: Number(file?.size) || 0,
    extension: typeof file?.extension === 'string' ? file.extension : '',
  }
}

async function generatePersistentContext(jobId, files) {
  try {
    const extractedFiles = await Promise.all(files.map(extractContextFile))
    if (jobId !== contextJobId) return

    const usableFiles = extractedFiles.filter((file) => file.text.trim())
    const failedFiles = extractedFiles.filter((file) => file.error)
    if (usableFiles.length === 0) {
      throw new Error([
        'No usable text could be extracted from the selected files.',
        ...failedFiles.map((file) => `${file.name}: ${file.error}`),
      ].filter(Boolean).join('\n'))
    }

    const injectedPrompt = await summarizeCourseContextWithCodex(usableFiles, failedFiles)
    if (jobId !== contextJobId) return

    contextState = {
      status: 'ready',
      fileCount: files.length,
      files: files.map(({ originalName, size, extension }) => ({ name: originalName, size, extension })),
      generatedAt: new Date().toISOString(),
      injectedPrompt,
      error: failedFiles.length > 0
        ? `Skipped ${failedFiles.length} file${failedFiles.length === 1 ? '' : 's'} with extraction errors.`
        : null,
    }
    persistContextState()
    tutorThreads.clear()
  } catch (error) {
    if (jobId !== contextJobId) return
    contextState = {
      ...contextState,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    }
    persistContextState()
  }
}

async function extractContextFile(file) {
  if (!acceptedContextExtensions.has(file.extension)) {
    return {
      name: file.originalName,
      text: '',
      error: `Unsupported file type "${file.extension || '(none)'}".`,
    }
  }

  try {
    const text = file.extension === '.pdf'
      ? await extractPdfText(file.path)
      : await fs.promises.readFile(file.path, 'utf8')
    return {
      name: file.originalName,
      text: text.trim(),
      error: text.trim() ? null : 'No text was extracted.',
    }
  } catch (error) {
    return {
      name: file.originalName,
      text: '',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function extractPdfText(filePath) {
  return runCommand('pdftotext', ['-layout', filePath, '-'], 60_000)
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: appRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s.`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `${command} exited with status ${code}.`))
    })
  })
}

async function summarizeCourseContextWithCodex(usableFiles, failedFiles) {
  const thread = await codex.request('thread/start', {
    cwd: appRoot,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: true,
    developerInstructions: `
You create compact persistent scope context for TurboLearner.
The output is consumed by another LLM tutor, not by a human.
The reader already knows every standard machine-learning concept; never explain standard concepts.
Your job is only to preserve course-specific coverage, expected depth, notation, terminology, and lecture-specific nuances.
Minimize context-window bloat.
Do not edit files, run commands, or browse. Use only the lecture text in the prompt.
Return only the text that should be injected into future tutor developer instructions.
`.trim(),
  })
  let markdown = ''
  await codex.startTurn({
    threadId: thread.thread.id,
    input: [{ type: 'text', text: buildCourseContextSummaryPrompt(usableFiles, failedFiles), text_elements: [] }],
    cwd: appRoot,
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
    timeoutMs: contextGenerationTurnTimeoutMs,
    onNotification: (message) => {
      if (message.method === 'item/agentMessage/delta') {
        markdown += message.params?.delta ?? ''
      }
    },
  })

  const injectedPrompt = markdown.trim()
  if (!injectedPrompt) throw new Error('Codex generated an empty course context.')
  return injectedPrompt
}

function buildCourseContextSummaryPrompt(usableFiles, failedFiles) {
  const extractionNotes = failedFiles.length > 0
    ? `
Extraction notes for this one-time summarizer pass:
${failedFiles.map((file) => `- ${file.name}: ${file.error}`).join('\n')}
`.trim()
    : 'Extraction notes for this one-time summarizer pass: none.'

  return `
Create a persistent Course Scope document from the selected lecture files.

This output will be injected verbatim into future TurboLearner tutor developer instructions.
The reader is another LLM-based tutor that already knows every standard machine-learning concept.
No human student will read this.
The goal is to minimize injected context-window bloat while preserving course-specific scope.

Purpose:
Tell the future tutor exactly what this course covered and at what depth.
Do not teach the tutor machine learning.

Length:
- Prefer <= 12,000 characters.
- You may exceed 12,000 characters only to preserve course-specific nuance, notation, unusual lecture framing, or explicit expected depth.
- Never exceed 25,000 characters.

Preserve, in priority order:
1. Covered topic and subtopic names.
2. Expected depth for each topic:
   - recognition only;
   - conceptual explanation;
   - formula use;
   - metric computation;
   - algorithm tracing;
   - derivation/proof;
   - implementation awareness.
3. Course-specific notation, terminology, naming, and framing.
4. Professor-specific or slide-specific nuances.
5. Explicit caveats stated or strongly evidenced by the lecture text.
6. Examples only when they define exam scope or expected answer style.

Drop aggressively:
- Definitions of standard ML concepts.
- Generic explanations.
- Textbook descriptions.
- Worked examples unless they define scope.
- Step-by-step derivations unless the derivation itself is expected.
- Objective/loss formulas unless formula recognition/use is part of expected depth.
- Repeated formulas when a compact depth label is enough.
- Broad enumeration of what is not covered.
- External ML topics not evidenced by the lectures.
- File names, extraction notes, skipped-file notes, upload details, or process metadata.

Use extraction notes and file boundaries only to understand the source material.

Required format:

# Course Scope

## Global Course Framing
- Scope:
- Expected level:
- Course terminology/notation:
- General grading/scope rules:

## Covered Topics

### <Topic Name>
- Covered:
- Expected depth:
- Course-specific notation/terms:
- Lecture-specific nuance/caveats:

Use only bullets. Keep each bullet dense and short.
If a field has nothing course-specific, omit that field.
Do not include prose paragraphs.
Do not include a "Not in scope" section.
Return only the Course Scope document.

${extractionNotes}

Lecture text:
${usableFiles.map((file) => `
--- BEGIN FILE: ${file.name} ---
${file.text}
--- END FILE: ${file.name} ---
`).join('\n')}
`.trim()
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

  async request(method, params, timeoutMs = codexRequestTimeoutMs) {
    await this.ensureStarted()
    try {
      return await this.rawRequest(method, params, timeoutMs)
    } catch (error) {
      if (error instanceof CodexTimeoutError) this.restart(error.message)
      throw error
    }
  }

  async startTurn({ threadId, input, cwd, approvalPolicy, sandboxPolicy, timeoutMs = codexTurnTimeoutMs, onNotification }) {
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
      const timer = setTimeout(() => {
        this.activeTurns.delete(turnId)
        this.restart(`Codex turn timed out after ${timeoutMs}ms.`)
        reject(new CodexTimeoutError(`Codex turn timed out after ${Math.round(timeoutMs / 1000)}s.`))
      }, timeoutMs)

      this.activeTurns.set(turnId, {
        threadId,
        onNotification,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
    })
  }

  async ensureStarted() {
    if (this.readyPromise) return this.readyPromise
    this.readyPromise = this.start().catch((error) => {
      this.stopProcess(error)
      throw error
    })
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
      tutorThreads.clear()
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

  rawRequest(method, params, timeoutMs = codexRequestTimeoutMs) {
    const id = this.nextId++
    this.proc.stdin.write(`${JSON.stringify({ method, id, params })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CodexTimeoutError(`Codex ${method} request timed out after ${Math.round(timeoutMs / 1000)}s.`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
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

  restart(reason) {
    console.warn(`Restarting Codex app-server: ${reason}`)
    this.stopProcess(new Error(reason))
  }

  stopProcess(error = new Error('Codex app-server stopped.')) {
    for (const pending of this.pending.values()) pending.reject(error)
    for (const turn of this.activeTurns.values()) turn.reject(error)
    this.pending.clear()
    this.activeTurns.clear()
    tutorThreads.clear()
    this.readyPromise = null

    const proc = this.proc
    this.proc = null
    this.rl?.close()
    this.rl = null
    if (proc && !proc.killed) proc.kill()
  }
}

class CodexTimeoutError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CodexTimeoutError'
  }
}

import cors from 'cors'
import Database from 'better-sqlite3'
import express from 'express'
import fs from 'node:fs'
import multer from 'multer'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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
const examUploadsDir = path.join(contextDir, 'exam-uploads')
const generatedAssetsDir = path.join(contextDir, 'generated-assets')
const examGenerationStatePath = path.join(contextDir, 'exam-generation.json')
const generatedExamsPath = path.join(contextDir, 'generated-exams.json')
const questionBankPath = path.join(appRoot, 'public', 'questions.json')
const sqlitePath = path.join(contextDir, 'turbolearner.sqlite')
const topicsDir = path.join(contextDir, 'topics')
const defaultTopicId = 'machine-learning'
const defaultTopicName = 'Machine Learning'
const defaultTopicEmoji = '🧠'
const textFileExtensions = new Set(['.txt', '.md', '.csv', '.json', '.log'])
const acceptedContextExtensions = new Set(['.pdf', ...textFileExtensions])
const examGenerationTurnTimeoutMs = Number(process.env.TURBOLEARNER_EXAM_GENERATION_TURN_TIMEOUT_MS || 20 * 60 * 1000)

const tutorThreads = new Map()
const db = initializeDatabase()
const topicContextJobs = new Map()
const topicExamGenerationJobs = new Map()
let contextState = loadContextState()
let contextJobId = 0
let examGenerationState = loadExamGenerationState()
let examGenerationJobId = 0
let codex

fs.mkdirSync(contextUploadsDir, { recursive: true })
fs.mkdirSync(examUploadsDir, { recursive: true })
fs.mkdirSync(generatedAssetsDir, { recursive: true })
fs.mkdirSync(topicsDir, { recursive: true })
await migrateLegacyContextSourcesForDefaultTopic()

app.use(cors())
app.use(express.json({ limit: '25mb' }))

const uploadTopicSources = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 48,
    fileSize: 100 * 1024 * 1024,
  },
})

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

const uploadExamFiles = multer({
  storage: multer.diskStorage({
    destination: examUploadsDir,
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

app.get('/api/topics', (_req, res) => {
  try {
    res.json({ topics: listTopics() })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.post('/api/topics', (req, res) => {
  try {
    const name = nonEmptyString(req.body?.name, 'New Topic')
    const emoji = typeof req.body?.emoji === 'string' && req.body.emoji.trim()
      ? req.body.emoji.trim().slice(0, 8)
      : '📚'
    const topic = createTopic({ name, emoji })
    res.status(201).json(topic)
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.patch('/api/topics/:topicId', (req, res) => {
  try {
    const topicId = requireTopicId(req.params.topicId)
    updateTopic(topicId, {
      name: typeof req.body?.name === 'string' ? req.body.name : undefined,
      emoji: typeof req.body?.emoji === 'string' ? req.body.emoji : undefined,
    })
    res.json(publicTopic(topicId))
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.delete('/api/topics/:topicId', (req, res) => {
  try {
    const topicId = requireTopicId(req.params.topicId)
    if (topicId === defaultTopicId) {
      res.status(400).json({ error: 'The default migrated topic cannot be deleted.' })
      return
    }
    deleteTopic(topicId)
    res.json({ ok: true })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.get('/api/topics/:topicId/question-bank', (req, res) => {
  try {
    const topicId = requireTopicId(req.params.topicId)
    res.json(topicQuestionBank(topicId))
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.delete('/api/topics/:topicId/question-sets/:setId', (req, res) => {
  try {
    const topicId = requireTopicId(req.params.topicId)
    const setId = sanitizePathSegment(req.params.setId)
    deleteGeneratedQuestionSet(topicId, setId)
    res.json({ ok: true, bank: topicQuestionBank(topicId), generation: publicTopicExamGenerationState(topicId) })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.get('/api/topics/:topicId/sources', (req, res) => {
  try {
    const topicId = requireTopicId(req.params.topicId)
    res.json({ sources: listTopicSources(topicId) })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.post('/api/topics/:topicId/sources/files', uploadTopicSources.array('files', 48), async (req, res) => {
  try {
    const topicId = requireTopicId(req.params.topicId)
    const files = Array.isArray(req.files) ? req.files : []
    if (files.length === 0) {
      res.status(400).json({ error: 'No files uploaded.' })
      return
    }
    for (const file of files) await storeTopicSourceUpload(topicId, file)
    queueTopicContextRefresh(topicId)
    res.status(201).json({ sources: listTopicSources(topicId), context: publicTopicContextState(topicId) })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.delete('/api/topics/:topicId/sources/:sourceId', (req, res) => {
  try {
    const topicId = requireTopicId(req.params.topicId)
    deleteTopicSource(topicId, req.params.sourceId)
    queueTopicContextRefresh(topicId)
    res.json({ sources: listTopicSources(topicId), context: publicTopicContextState(topicId) })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.get('/api/topics/:topicId/context', (req, res) => {
  try {
    const topicId = requireTopicId(req.params.topicId)
    res.json(publicTopicContextState(topicId))
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.post('/api/topics/:topicId/context/generate', (req, res) => {
  try {
    const topicId = requireTopicId(req.params.topicId)
    if (listTopicSources(topicId).length === 0) {
      res.status(400).json({ error: 'Upload lecture sources before generating context.' })
      return
    }
    queueTopicContextRefresh(topicId)
    res.status(202).json(publicTopicContextState(topicId))
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.delete('/api/topics/:topicId/context', (req, res) => {
  try {
    const topicId = requireTopicId(req.params.topicId)
    topicContextJobs.set(topicId, randomUUID())
    upsertTopicContext(topicId, {
      status: 'idle',
      generatedAt: null,
      injectedPrompt: '',
      error: null,
      jobId: null,
    })
    tutorThreads.clear()
    res.json(publicTopicContextState(topicId))
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.get('/api/topics/:topicId/exam-generation', (req, res) => {
  try {
    const topicId = requireTopicId(req.params.topicId)
    res.json(publicTopicExamGenerationState(topicId))
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.post('/api/topics/:topicId/exam-generation', (req, res) => {
  try {
    const topicId = requireTopicId(req.params.topicId)
    const sources = listTopicSources(topicId)
    if (sources.length === 0) {
      res.status(400).json({ error: 'Upload lecture sources before generating an exam.' })
      return
    }
    const jobId = randomUUID()
    topicExamGenerationJobs.set(topicId, jobId)
    upsertGenerationJob({
      id: jobId,
      topicId,
      type: 'exam',
      status: 'processing',
      phase: 'Queued',
      log: [examGenerationLogEntry('status', 'Queued exam generation.')],
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      resultId: null,
    })
    void generatePersistentExamForTopic(topicId, jobId)
    res.status(202).json(publicTopicExamGenerationState(topicId))
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.delete('/api/topics/:topicId/exam-generation', (req, res) => {
  try {
    const topicId = requireTopicId(req.params.topicId)
    topicExamGenerationJobs.set(topicId, randomUUID())
    deleteActiveGenerationJob(topicId, 'exam')
    res.json(publicTopicExamGenerationState(topicId))
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.get('/api/topics/:topicId/sessions', (req, res) => {
  try {
    const topicId = requireTopicId(req.params.topicId)
    res.json({ sessions: getTopicSessions(topicId) })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.put('/api/topics/:topicId/sessions/:setId', (req, res) => {
  try {
    const topicId = requireTopicId(req.params.topicId)
    const setId = String(req.params.setId || '')
    if (!topicQuestionSetIds(topicId).has(setId)) {
      res.status(404).json({ error: 'Question set not found for topic.' })
      return
    }
    const session = sanitizeExamSessionForSet(topicId, setId, req.body?.session ?? req.body)
    saveTopicSession(topicId, setId, session)
    res.json({ session })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.post('/api/topics/:topicId/sessions/import-localstorage', (req, res) => {
  try {
    const topicId = requireTopicId(req.params.topicId)
    const result = importLocalStorageSessions(topicId, req.body?.sessions, req.body?.activeSetId)
    res.json(result)
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.get('/api/question-bank', (_req, res) => {
  try {
    res.json(topicQuestionBank(defaultTopicId))
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
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

app.get('/api/exam-generation', (_req, res) => {
  res.json(publicExamGenerationState())
})

app.post('/api/exam-generation/files', uploadExamFiles.array('files', 24), (req, res) => {
  const files = Array.isArray(req.files) ? req.files : []
  if (files.length === 0) {
    res.status(400).json({ error: 'No files uploaded.' })
    return
  }

  const jobId = ++examGenerationJobId
  const uploadedFiles = files.map((file) => ({
    originalName: file.originalname,
    path: file.path,
    size: file.size,
    mimetype: file.mimetype,
    extension: path.extname(file.originalname).toLowerCase(),
  }))
  examGenerationState = {
    status: 'processing',
    phase: 'Queued',
    fileCount: uploadedFiles.length,
    files: uploadedFiles.map(({ originalName, size, extension }) => ({ name: originalName, size, extension })),
    startedAt: new Date().toISOString(),
    completedAt: null,
    threadId: null,
    generatedExamId: null,
    generatedExamTitle: null,
    questionCount: 0,
    log: [examGenerationLogEntry('status', 'Queued exam generation.')],
    error: null,
  }
  persistExamGenerationState()
  void generatePersistentExam(jobId, uploadedFiles)
  res.status(202).json(publicExamGenerationState())
})

app.delete('/api/exam-generation', (_req, res) => {
  examGenerationJobId += 1
  examGenerationState = emptyExamGenerationState()
  persistExamGenerationState()
  res.json(publicExamGenerationState())
})

app.get(/^\/api\/generated-assets\/([^/]+)\/([^/]+)\/([^/]+)$/, (req, res) => {
  const [, rawTopicId, rawExamId, rawFile] = req.path.match(/^\/api\/generated-assets\/([^/]+)\/([^/]+)\/([^/]+)$/i) ?? []
  const topicId = sanitizePathSegment(rawTopicId)
  const examId = sanitizePathSegment(rawExamId)
  const file = sanitizePathSegment(rawFile)
  if (!topicId || !examId || !file || !/\.(png|jpe?g)$/i.test(file)) {
    res.status(404).send('File not found')
    return
  }
  const topicFilePath = path.join(topicPath(topicId), 'generated-assets', examId, file)
  const filePath = fs.existsSync(topicFilePath)
    ? topicFilePath
    : path.join(generatedAssetsDir, examId, file)
  res.sendFile(filePath, { dotfiles: 'allow' }, (error) => {
    if (error) res.status(404).send('File not found')
  })
})

app.get(/^\/api\/generated-assets\/([^/]+)\/([^/]+)$/, (req, res) => {
  const [, rawExamId, rawFile] = req.path.match(/^\/api\/generated-assets\/([^/]+)\/([^/]+)$/i) ?? []
  const examId = sanitizePathSegment(rawExamId)
  const file = sanitizePathSegment(rawFile)
  if (!examId || !file || !/\.(png|jpe?g)$/i.test(file)) {
    console.warn('[generated-assets] invalid asset request', { path: req.path, examId, file })
    res.status(404).send('File not found')
    return
  }
  const filePath = path.join(generatedAssetsDir, examId, file)
  res.sendFile(filePath, { dotfiles: 'allow' }, (error) => {
    if (error) {
      console.warn('[generated-assets] failed to send asset', { filePath, error: error.message })
      res.status(404).send('File not found')
    }
  })
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

  const topicId = safeTopicId(payload.topicId) ?? defaultTopicId
  const sessionId = String(payload.sessionId || payload.question?.id || 'default')
  const tutorThreadKey = `${topicId}:${sessionId}`
  const isFollowUp = payload.mode === 'chat'
  const isLearningRequest = payload.mode === 'learn'
  const threadId = await getTutorThread(tutorThreadKey, topicId)
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
  if (/^\/api\/generated-assets\//i.test(imagePath)) {
    const [, topicId, examId, topicFile] = imagePath.match(/^\/api\/generated-assets\/([^/]+)\/([^/]+)\/([^/]+)$/i) ?? []
    if (topicId && examId && topicFile) {
      const topicFilePath = path.join(topicPath(sanitizePathSegment(topicId)), 'generated-assets', sanitizePathSegment(examId), sanitizePathSegment(topicFile))
      return fs.existsSync(topicFilePath)
        ? topicFilePath
        : path.join(generatedAssetsDir, sanitizePathSegment(examId), sanitizePathSegment(topicFile))
    }
    const [, legacyExamId, file] = imagePath.match(/^\/api\/generated-assets\/([^/]+)\/([^/]+)$/i) ?? []
    if (!legacyExamId || !file) return null
    return path.join(generatedAssetsDir, sanitizePathSegment(legacyExamId), sanitizePathSegment(file))
  }
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

async function getTutorThread(sessionId, topicId = defaultTopicId) {
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
    developerInstructions: tutorDeveloperInstructions(topicId),
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

function tutorDeveloperInstructions(topicId = defaultTopicId) {
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
    persistentCourseContextInstructions(topicId),
  ].filter(Boolean).join('\n\n')
}

function persistentCourseContextInstructions(topicId = defaultTopicId) {
  const topicContext = safeTopicId(topicId) ? publicTopicContextState(topicId) : contextState
  if (topicContext.status !== 'ready' || !topicContext.injectedPrompt?.trim()) return ''
  return `
## TurboLearner Persistent Course Context

The following course scope was generated from learner-selected lecture files and is persistent.
Use it as the source of truth for what this course covered and at what depth.
You may use general knowledge to explain listed covered concepts, but align grading and expected
answers to the listed scope, notation, terminology, framing, and lecture-specific nuances.

${topicContext.injectedPrompt.trim()}
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

function initializeDatabase() {
  fs.mkdirSync(contextDir, { recursive: true })
  const database = new Database(sqlitePath)
  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  database.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS topic_sources (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      extracted_text_path TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      extension TEXT NOT NULL DEFAULT '',
      extraction_status TEXT NOT NULL DEFAULT 'pending',
      extraction_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS topic_contexts (
      topic_id TEXT PRIMARY KEY REFERENCES topics(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      generated_at TEXT,
      injected_prompt TEXT NOT NULL DEFAULT '',
      error TEXT,
      job_id TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS question_sets (
      id TEXT NOT NULL,
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL,
      source_path TEXT NOT NULL DEFAULT '',
      questions_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (topic_id, id)
    );

    CREATE TABLE IF NOT EXISTS generation_jobs (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT '',
      log_json TEXT NOT NULL DEFAULT '[]',
      started_at TEXT,
      completed_at TEXT,
      error TEXT,
      result_id TEXT
    );

    CREATE TABLE IF NOT EXISTS exam_sessions (
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      set_id TEXT NOT NULL,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (topic_id, set_id)
    );
  `)
  seedDefaultTopic(database)
  return database
}

function seedDefaultTopic(database) {
  const now = new Date().toISOString()
  const hasDefaultTopic = database.prepare('SELECT id FROM topics WHERE id = ?').get(defaultTopicId)
  if (!hasDefaultTopic) {
    database.prepare(`
      INSERT INTO topics (id, name, emoji, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(defaultTopicId, defaultTopicName, defaultTopicEmoji, now, now)
  }

  const baseBank = readJsonFile(questionBankPath, { schema: null, sets: [] })
  const generatedBank = loadGeneratedExamBank()
  const importSet = database.prepare(`
    INSERT INTO question_sets (
      id, topic_id, title, description, source_type, source_path, questions_json, created_at, updated_at
    ) VALUES (
      @id, @topicId, @title, @description, @sourceType, @sourcePath, @questionsJson, @createdAt, @updatedAt
    )
    ON CONFLICT(topic_id, id) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      source_type = excluded.source_type,
      source_path = excluded.source_path,
      questions_json = excluded.questions_json,
      updated_at = excluded.updated_at
  `)
  const seedSets = database.transaction(() => {
    for (const set of Array.isArray(baseBank.sets) ? baseBank.sets : []) {
      importSet.run(questionSetDbParams(defaultTopicId, set, 'static', 'public/questions.json', now))
    }
    for (const set of Array.isArray(generatedBank.sets) ? generatedBank.sets : []) {
      importSet.run(questionSetDbParams(defaultTopicId, set, 'generated', '.turbolearner/generated-exams.json', now))
    }
  })
  seedSets()

  const hasContext = database.prepare('SELECT topic_id FROM topic_contexts WHERE topic_id = ?').get(defaultTopicId)
  if (!hasContext) {
    const legacyContext = loadContextState()
    database.prepare(`
      INSERT INTO topic_contexts (
        topic_id, status, generated_at, injected_prompt, error, job_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      defaultTopicId,
      legacyContext.status,
      legacyContext.generatedAt,
      legacyContext.injectedPrompt,
      legacyContext.error,
      null,
      now,
    )
  }
}

function questionSetDbParams(topicId, set, sourceType, sourcePath, timestamp = new Date().toISOString()) {
  return {
    id: nonEmptyString(set?.id, stableId(set?.title, randomUUID())),
    topicId,
    title: nonEmptyString(set?.title, 'Untitled Exam'),
    description: typeof set?.description === 'string' ? set.description : '',
    sourceType,
    sourcePath,
    questionsJson: JSON.stringify(Array.isArray(set?.questions) ? set.questions : []),
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function requireTopicId(value) {
  const topicId = sanitizePathSegment(value)
  if (!topicId || !db.prepare('SELECT id FROM topics WHERE id = ?').get(topicId)) {
    throw new Error('Topic not found.')
  }
  return topicId
}

function safeTopicId(value) {
  const topicId = sanitizePathSegment(value)
  if (!topicId) return null
  return db.prepare('SELECT id FROM topics WHERE id = ?').get(topicId) ? topicId : null
}

function createTopic({ name, emoji }) {
  const id = uniqueTopicId(name)
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO topics (id, name, emoji, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name.trim(), emoji.trim(), now, now)
  upsertTopicContext(id, {
    status: 'idle',
    generatedAt: null,
    injectedPrompt: '',
    error: null,
    jobId: null,
  })
  fs.mkdirSync(topicPath(id), { recursive: true })
  return publicTopic(id)
}

function uniqueTopicId(name) {
  const base = stableId(name, 'topic')
  let candidate = base
  let index = 2
  while (db.prepare('SELECT id FROM topics WHERE id = ?').get(candidate)) {
    candidate = `${base}-${index}`
    index += 1
  }
  return candidate
}

function updateTopic(topicId, patch) {
  const current = db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId)
  if (!current) throw new Error('Topic not found.')
  const name = typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim() : current.name
  const emoji = typeof patch.emoji === 'string' && patch.emoji.trim() ? patch.emoji.trim().slice(0, 8) : current.emoji
  db.prepare('UPDATE topics SET name = ?, emoji = ?, updated_at = ? WHERE id = ?')
    .run(name, emoji, new Date().toISOString(), topicId)
}

function deleteTopic(topicId) {
  db.prepare('DELETE FROM topics WHERE id = ?').run(topicId)
}

function listTopics() {
  return db.prepare('SELECT id FROM topics ORDER BY created_at ASC').all().map((row) => publicTopic(row.id))
}

function publicTopic(topicId) {
  const row = db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId)
  if (!row) throw new Error('Topic not found.')
  const sessionSummaries = Object.values(getTopicSessions(topicId)).map((session) => examSessionSummary(session))
  const seen = sessionSummaries.reduce((sum, summary) => sum + summary.seen, 0)
  const last25 = sessionSummaries.flatMap((summary) => summary.last25)
    .sort((a, b) => Number(b.answeredAt) - Number(a.answeredAt))
    .slice(0, 25)
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    examCount: db.prepare('SELECT COUNT(*) AS count FROM question_sets WHERE topic_id = ?').get(topicId).count,
    sourceCount: db.prepare('SELECT COUNT(*) AS count FROM topic_sources WHERE topic_id = ?').get(topicId).count,
    seen,
    last25,
    correctLast25: last25.filter((item) => item.isCorrect).length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function examSessionSummary(session) {
  const history = Array.isArray(session?.history) ? session.history : []
  const progress = session?.progress && typeof session.progress === 'object' ? session.progress : {}
  return {
    last25: history.slice(0, 25),
    seen: Object.keys(progress).length,
  }
}

function topicQuestionBank(topicId) {
  const baseBank = readJsonFile(questionBankPath, { schema: null, generatedAt: null, sets: [] })
  const baseOrder = new Map((baseBank.sets ?? []).map((set, index) => [set.id, index]))
  const sets = db.prepare(`
    SELECT id, title, description, source_type, source_path, questions_json, created_at
    FROM question_sets
    WHERE topic_id = ?
  `).all(topicId)
    .sort((a, b) => {
      const typeA = a.source_type === 'static' ? 0 : 1
      const typeB = b.source_type === 'static' ? 0 : 1
      if (typeA !== typeB) return typeA - typeB
      if (typeA === 0) return (baseOrder.get(a.id) ?? 9999) - (baseOrder.get(b.id) ?? 9999)
      const created = String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))
      return created || String(a.title ?? '').localeCompare(String(b.title ?? ''))
    })
    .map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      sourceType: row.source_type,
      sourcePath: row.source_path,
      questions: parseJson(row.questions_json, []),
    }))
  return {
    schema: baseBank.schema ?? null,
    generatedAt: new Date().toISOString(),
    sets,
  }
}

function topicQuestionSetIds(topicId) {
  const ids = new Set(db.prepare('SELECT id FROM question_sets WHERE topic_id = ?').all(topicId).map((row) => row.id))
  if (ids.size > 0) ids.add('all-questions')
  return ids
}

function getQuestionSet(topicId, setId) {
  if (setId === 'all-questions') {
    const sets = topicQuestionBank(topicId).sets
    const questions = sets.flatMap((set) => set.questions)
    return {
      id: 'all-questions',
      title: 'All Questions',
      description: 'Practice and last year exam questions mixed together.',
      questions,
    }
  }
  const row = db.prepare(`
    SELECT id, title, description, source_path, questions_json
    FROM question_sets
    WHERE topic_id = ? AND id = ?
  `).get(topicId, setId)
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    sourcePath: row.source_path,
    questions: parseJson(row.questions_json, []),
  }
}

function persistGeneratedExamSetForTopic(topicId, set) {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO question_sets (
      id, topic_id, title, description, source_type, source_path, questions_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(topic_id, id) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      questions_json = excluded.questions_json,
      updated_at = excluded.updated_at
  `).run(
    set.id,
    topicId,
    set.title,
    set.description ?? '',
    'generated',
    `.turbolearner/topics/${topicId}/generated-assets/${set.id}`,
    JSON.stringify(set.questions ?? []),
    now,
    now,
  )
}

function deleteGeneratedQuestionSet(topicId, setId) {
  if (!setId || setId === 'all-questions') throw new Error('Generated exam not found.')
  const row = db.prepare(`
    SELECT id, source_type, source_path
    FROM question_sets
    WHERE topic_id = ? AND id = ?
  `).get(topicId, setId)
  if (!row) throw new Error('Generated exam not found.')
  if (row.source_type !== 'generated') throw new Error('Only generated exams can be deleted.')

  const deleteSet = db.transaction(() => {
    db.prepare('DELETE FROM exam_sessions WHERE topic_id = ? AND set_id = ?').run(topicId, setId)
    db.prepare('DELETE FROM question_sets WHERE topic_id = ? AND id = ?').run(topicId, setId)
    db.prepare('UPDATE topics SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), topicId)
    const activeJob = getActiveGenerationJob(topicId, 'exam')
    if (activeJob?.resultId === setId) {
      db.prepare('DELETE FROM generation_jobs WHERE id = ?').run(activeJob.id)
    }
  })
  deleteSet()

  if (topicId === defaultTopicId || row.source_path === '.turbolearner/generated-exams.json') {
    deleteLegacyGeneratedExamSet(setId)
  }
  removeGeneratedQuestionSetAssets(topicId, setId)
}

function deleteLegacyGeneratedExamSet(setId) {
  const bank = loadGeneratedExamBank()
  const nextSets = bank.sets.filter((candidate) => candidate?.id !== setId)
  if (nextSets.length === bank.sets.length) return
  fs.mkdirSync(contextDir, { recursive: true })
  fs.writeFileSync(generatedExamsPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    sets: nextSets,
  }, null, 2))
}

function removeGeneratedQuestionSetAssets(topicId, setId) {
  for (const assetDir of [
    path.join(topicPath(topicId), 'generated-assets', setId),
    path.join(generatedAssetsDir, setId),
  ]) {
    fs.rmSync(assetDir, { recursive: true, force: true })
  }
}

function listTopicSources(topicId) {
  return db.prepare(`
    SELECT *
    FROM topic_sources
    WHERE topic_id = ?
    ORDER BY created_at ASC
  `).all(topicId).map(publicTopicSource)
}

function publicTopicSource(row) {
  return {
    id: row.id,
    name: row.original_name,
    size: Number(row.size) || 0,
    extension: row.extension,
    extractionStatus: row.extraction_status,
    extractionError: row.extraction_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function migrateLegacyContextSourcesForDefaultTopic() {
  const existingSourceCount = db.prepare('SELECT COUNT(*) AS count FROM topic_sources WHERE topic_id = ?').get(defaultTopicId).count
  if (existingSourceCount > 0 || contextState.status !== 'ready' || !Array.isArray(contextState.files) || contextState.files.length === 0) {
    return
  }

  const sourceDir = path.join(topicPath(defaultTopicId), 'sources')
  const extractedDir = path.join(topicPath(defaultTopicId), 'extracted')
  await fs.promises.mkdir(sourceDir, { recursive: true })
  await fs.promises.mkdir(extractedDir, { recursive: true })

  const rows = []
  for (const file of contextState.files.map(publicContextFile)) {
    const extension = String(file.extension || path.extname(file.name)).toLowerCase()
    const sourceId = randomUUID()
    const now = contextState.generatedAt || new Date().toISOString()
    const legacyPath = findLegacyContextUpload(file)
    const base = uploadSafeBasename(file.name, extension)
    const storedPath = path.join(sourceDir, `${sourceId}-${base}${extension}`)
    const extractedTextPath = path.join(extractedDir, `${sourceId}.txt`)

    let status = 'ready'
    let error = null
    let finalStoredPath = storedPath
    if (!legacyPath) {
      status = 'error'
      error = 'Legacy upload file was not found.'
      finalStoredPath = ''
    } else {
      await fs.promises.copyFile(legacyPath, storedPath)
      const extracted = await extractContextFile({
        originalName: file.name,
        path: storedPath,
        size: file.size,
        mimetype: extension === '.pdf' ? 'application/pdf' : 'text/plain',
        extension,
      })
      if (!extracted.text.trim()) {
        status = 'error'
        error = extracted.error || 'No text was extracted.'
      } else {
        await fs.promises.writeFile(extractedTextPath, extracted.text, 'utf8')
      }
    }

    rows.push({
      id: sourceId,
      topicId: defaultTopicId,
      originalName: file.name,
      storedPath: finalStoredPath,
      extractedTextPath: status === 'ready' ? extractedTextPath : null,
      size: file.size,
      extension,
      status,
      error,
      createdAt: now,
      updatedAt: now,
    })
  }

  const insert = db.prepare(`
    INSERT INTO topic_sources (
      id, topic_id, original_name, stored_path, extracted_text_path, size, extension,
      extraction_status, extraction_error, created_at, updated_at
    ) VALUES (
      @id, @topicId, @originalName, @storedPath, @extractedTextPath, @size, @extension,
      @status, @error, @createdAt, @updatedAt
    )
  `)
  db.transaction((sourceRows) => {
    for (const row of sourceRows) insert.run(row)
  })(rows)
  upsertTopicContext(defaultTopicId, {
    status: contextState.status,
    generatedAt: contextState.generatedAt,
    injectedPrompt: contextState.injectedPrompt,
    error: contextState.error,
    jobId: null,
  })
}

function findLegacyContextUpload(file) {
  if (!fs.existsSync(contextUploadsDir)) return null
  const extension = String(file.extension || path.extname(file.name)).toLowerCase()
  const expectedSuffix = `-${uploadSafeBasename(file.name, extension)}${extension}`
  const candidates = fs.readdirSync(contextUploadsDir)
    .filter((entry) => entry.endsWith(expectedSuffix))
    .map((entry) => {
      const filePath = path.join(contextUploadsDir, entry)
      const stats = fs.statSync(filePath)
      return { filePath, mtimeMs: stats.mtimeMs, size: stats.size }
    })
    .filter((candidate) => !file.size || candidate.size === file.size)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates[0]?.filePath ?? null
}

function uploadSafeBasename(name, extension = path.extname(name).toLowerCase()) {
  return path.basename(name, extension).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80) || 'file'
}

async function storeTopicSourceUpload(topicId, file) {
  const extension = path.extname(file.originalname).toLowerCase()
  const sourceId = randomUUID()
  const now = new Date().toISOString()
  const sourceDir = path.join(topicPath(topicId), 'sources')
  const extractedDir = path.join(topicPath(topicId), 'extracted')
  fs.mkdirSync(sourceDir, { recursive: true })
  fs.mkdirSync(extractedDir, { recursive: true })
  const base = uploadSafeBasename(file.originalname, extension)
  const storedPath = path.join(sourceDir, `${sourceId}-${base}${extension}`)
  const extractedTextPath = path.join(extractedDir, `${sourceId}.txt`)
  await fs.promises.writeFile(storedPath, file.buffer)

  let status = 'ready'
  let error = null
  try {
    const extracted = await extractContextFile({
      originalName: file.originalname,
      path: storedPath,
      size: file.size,
      mimetype: file.mimetype,
      extension,
    })
    if (!extracted.text.trim()) {
      status = 'error'
      error = extracted.error || 'No text was extracted.'
    } else {
      await fs.promises.writeFile(extractedTextPath, extracted.text, 'utf8')
    }
  } catch (extractError) {
    status = 'error'
    error = extractError instanceof Error ? extractError.message : String(extractError)
  }

  db.prepare(`
    INSERT INTO topic_sources (
      id, topic_id, original_name, stored_path, extracted_text_path, size, extension,
      extraction_status, extraction_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sourceId,
    topicId,
    file.originalname,
    storedPath,
    status === 'ready' ? extractedTextPath : null,
    file.size,
    extension,
    status,
    error,
    now,
    now,
  )
  upsertTopicContext(topicId, {
    status: 'idle',
    generatedAt: null,
    injectedPrompt: '',
    error: null,
    jobId: null,
  })
}

function deleteTopicSource(topicId, sourceId) {
  const row = db.prepare('SELECT * FROM topic_sources WHERE topic_id = ? AND id = ?').get(topicId, sourceId)
  if (!row) throw new Error('Source not found.')
  for (const filePath of [row.stored_path, row.extracted_text_path]) {
    if (filePath && fs.existsSync(filePath)) fs.rmSync(filePath, { force: true })
  }
  db.prepare('DELETE FROM topic_sources WHERE topic_id = ? AND id = ?').run(topicId, sourceId)
  upsertTopicContext(topicId, {
    status: 'idle',
    generatedAt: null,
    injectedPrompt: '',
    error: null,
    jobId: null,
  })
}

function queueTopicContextRefresh(topicId) {
  topicContextJobs.set(topicId, randomUUID())
  if (listTopicSources(topicId).length === 0) {
    upsertTopicContext(topicId, {
      status: 'idle',
      generatedAt: null,
      injectedPrompt: '',
      error: null,
      jobId: null,
    })
    tutorThreads.clear()
    return
  }

  const jobId = randomUUID()
  topicContextJobs.set(topicId, jobId)
  upsertTopicContext(topicId, {
    status: 'processing',
    generatedAt: null,
    injectedPrompt: '',
    error: null,
    jobId,
  })
  tutorThreads.clear()
  void generatePersistentContextForTopic(topicId, jobId)
}

function topicSourceFiles(topicId) {
  return db.prepare(`
    SELECT *
    FROM topic_sources
    WHERE topic_id = ? AND extraction_status = 'ready' AND extracted_text_path IS NOT NULL
    ORDER BY created_at ASC
  `).all(topicId).map((row) => ({
    name: row.original_name,
    text: fs.existsSync(row.extracted_text_path) ? fs.readFileSync(row.extracted_text_path, 'utf8') : '',
    error: null,
  })).filter((file) => file.text.trim())
}

function topicFailedSourceFiles(topicId) {
  return db.prepare(`
    SELECT *
    FROM topic_sources
    WHERE topic_id = ? AND extraction_status = 'error'
    ORDER BY created_at ASC
  `).all(topicId).map((row) => ({
    name: row.original_name,
    text: '',
    error: row.extraction_error || 'Extraction failed.',
  }))
}

function upsertTopicContext(topicId, { status, generatedAt, injectedPrompt, error, jobId }) {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO topic_contexts (
      topic_id, status, generated_at, injected_prompt, error, job_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(topic_id) DO UPDATE SET
      status = excluded.status,
      generated_at = excluded.generated_at,
      injected_prompt = excluded.injected_prompt,
      error = excluded.error,
      job_id = excluded.job_id,
      updated_at = excluded.updated_at
  `).run(topicId, status, generatedAt, injectedPrompt ?? '', error, jobId, now)
}

function getTopicContext(topicId) {
  const row = db.prepare('SELECT * FROM topic_contexts WHERE topic_id = ?').get(topicId)
  if (row) return row
  upsertTopicContext(topicId, {
    status: 'idle',
    generatedAt: null,
    injectedPrompt: '',
    error: null,
    jobId: null,
  })
  return db.prepare('SELECT * FROM topic_contexts WHERE topic_id = ?').get(topicId)
}

function publicTopicContextState(topicId) {
  const context = getTopicContext(topicId)
  const files = listTopicSources(topicId).map((source) => ({
    name: source.name,
    size: source.size,
    extension: source.extension,
  }))
  return {
    status: context.status,
    fileCount: files.length,
    files,
    generatedAt: context.generated_at ?? null,
    injectedPrompt: context.injected_prompt ?? '',
    error: context.error ?? null,
  }
}

function legacyContextFilesForTopic(topicId) {
  if (topicId !== defaultTopicId) return []
  const legacyContext = loadContextState()
  if (legacyContext.status !== 'ready' || !Array.isArray(legacyContext.files)) return []
  return legacyContext.files.map((file) => ({
    name: String(file?.name ?? 'Lecture file'),
    size: Number(file?.size) || 0,
    extension: String(file?.extension ?? path.extname(file?.name ?? '').toLowerCase()),
  }))
}

function upsertGenerationJob({ id, topicId, type, status, phase, log, startedAt, completedAt, error, resultId }) {
  db.prepare(`
    INSERT INTO generation_jobs (
      id, topic_id, type, status, phase, log_json, started_at, completed_at, error, result_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      phase = excluded.phase,
      log_json = excluded.log_json,
      completed_at = excluded.completed_at,
      error = excluded.error,
      result_id = excluded.result_id
  `).run(
    id,
    topicId,
    type,
    status,
    phase ?? '',
    JSON.stringify(normalizeExamGenerationLog(log)),
    startedAt,
    completedAt,
    error,
    resultId,
  )
}

function getActiveGenerationJob(topicId, type) {
  const row = db.prepare(`
    SELECT *
    FROM generation_jobs
    WHERE topic_id = ? AND type = ?
    ORDER BY COALESCE(started_at, '') DESC, id DESC
    LIMIT 1
  `).get(topicId, type)
  if (!row) return null
  return {
    id: row.id,
    topicId: row.topic_id,
    type: row.type,
    status: row.status,
    phase: row.phase,
    log: normalizeExamGenerationLog(parseJson(row.log_json, [])),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    resultId: row.result_id,
  }
}

function deleteActiveGenerationJob(topicId, type) {
  const job = getActiveGenerationJob(topicId, type)
  if (job) db.prepare('DELETE FROM generation_jobs WHERE id = ?').run(job.id)
}

function publicTopicExamGenerationState(topicId) {
  const job = getActiveGenerationJob(topicId, 'exam')
  if (!job) return emptyExamGenerationState()
  const set = job.resultId ? getQuestionSet(topicId, job.resultId) : null
  return {
    status: job.status,
    phase: job.phase || '',
    fileCount: listTopicSources(topicId).length,
    files: listTopicSources(topicId).map(({ name, size, extension }) => ({ name, size, extension })),
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    threadId: null,
    generatedExamId: job.resultId ?? null,
    generatedExamTitle: set?.title ?? null,
    questionCount: set?.questions?.length ?? 0,
    log: normalizeExamGenerationLog(job.log),
    error: job.error ?? null,
  }
}

function setTopicExamGenerationPhase(topicId, jobId, phase) {
  if (topicExamGenerationJobs.get(topicId) !== jobId) return
  const job = getActiveGenerationJob(topicId, 'exam')
  if (!job) return
  upsertGenerationJob({ ...job, status: 'processing', phase, log: [...job.log, examGenerationLogEntry('status', phase)] })
}

function appendTopicExamGenerationLog(topicId, jobId, kind, message, detail = '') {
  if (topicExamGenerationJobs.get(topicId) !== jobId) return
  const text = String(message || '').trim()
  if (!text) return
  const job = getActiveGenerationJob(topicId, 'exam')
  if (!job) return
  upsertGenerationJob({
    ...job,
    log: [...job.log, examGenerationLogEntry(kind, text, detail)].slice(-400),
  })
}

function completeTopicExamGenerationJob(topicId, jobId, patch) {
  if (topicExamGenerationJobs.get(topicId) !== jobId) return
  const job = getActiveGenerationJob(topicId, 'exam')
  if (!job) return
  upsertGenerationJob({
    ...job,
    ...patch,
    completedAt: patch.completedAt ?? new Date().toISOString(),
  })
}

function getTopicSessions(topicId) {
  return Object.fromEntries(
    db.prepare('SELECT set_id, state_json FROM exam_sessions WHERE topic_id = ?').all(topicId)
      .map((row) => [row.set_id, parseJson(row.state_json, null)])
      .filter(([, session]) => session && typeof session === 'object'),
  )
}

function saveTopicSession(topicId, setId, session) {
  db.prepare(`
    INSERT INTO exam_sessions (topic_id, set_id, state_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(topic_id, set_id) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  `).run(topicId, setId, JSON.stringify(session), new Date().toISOString())
}

function importLocalStorageSessions(topicId, sessions, activeSetId) {
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) {
    return { imported: 0, skipped: 0, activeSetId: null }
  }
  let imported = 0
  let skipped = 0
  let nextActiveSetId = null
  const validSetIds = topicQuestionSetIds(topicId)
  for (const [setId, session] of Object.entries(sessions)) {
    if (!validSetIds.has(setId)) {
      skipped += 1
      continue
    }
    const sanitized = sanitizeExamSessionForSet(topicId, setId, session)
    if (!sanitized) {
      skipped += 1
      continue
    }
    saveTopicSession(topicId, setId, sanitized)
    imported += 1
    if (setId === activeSetId) nextActiveSetId = setId
  }
  return { imported, skipped, activeSetId: nextActiveSetId }
}

function sanitizeExamSessionForSet(topicId, setId, session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return null
  const set = getQuestionSet(topicId, setId)
  if (!set) return null
  const unitIds = questionUnitIds(set.questions)
  const questionIds = new Set(set.questions.map((question) => question.id))
  const currentId = typeof session.currentId === 'string' && unitIds.has(session.currentId)
    ? session.currentId
    : unitIds.values().next().value ?? null
  return {
    currentId,
    questionQueue: Array.isArray(session.questionQueue)
      ? session.questionQueue.filter((id) => typeof id === 'string' && unitIds.has(id) && id !== currentId)
      : [],
    answersByQuestion: filterObjectByKeys(session.answersByQuestion, questionIds),
    result: session.result && typeof session.result === 'object' ? session.result : null,
    isAnswerKeyRevealed: Boolean(session.isAnswerKeyRevealed),
    revealedCorrectOptionIdsByQuestion: filterObjectByKeys(session.revealedCorrectOptionIdsByQuestion, questionIds),
    messages: Array.isArray(session.messages) ? session.messages.filter((message) => message && typeof message === 'object') : [],
    tutorSessionId: typeof session.tutorSessionId === 'string' && session.tutorSessionId.trim() ? session.tutorSessionId : randomUUID(),
    optionOrderSeed: typeof session.optionOrderSeed === 'string' && session.optionOrderSeed.trim() ? session.optionOrderSeed : randomUUID(),
    usedLearningBeforeAnswer: Boolean(session.usedLearningBeforeAnswer),
    progress: filterObjectByKeys(session.progress, questionIds),
    history: Array.isArray(session.history)
      ? session.history.filter((item) => item && typeof item === 'object' && typeof item.questionId === 'string')
      : [],
  }
}

function questionUnitIds(questions) {
  const ids = new Set()
  const groupIds = new Set()
  for (const question of questions) {
    if (question?.groupId) groupIds.add(question.groupId)
    else if (question?.id) ids.add(question.id)
  }
  for (const id of groupIds) ids.add(id)
  return ids
}

function filterObjectByKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([key]) => keys.has(key)))
}

function topicPath(topicId) {
  return path.join(topicsDir, sanitizePathSegment(topicId))
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
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

function loadExamGenerationState() {
  try {
    const rawState = JSON.parse(fs.readFileSync(examGenerationStatePath, 'utf8'))
    if (['processing', 'ready', 'error'].includes(rawState?.status)) {
      return {
        ...emptyExamGenerationState(),
        ...rawState,
        status: rawState.status === 'processing' ? 'error' : rawState.status,
        phase: rawState.status === 'processing' ? 'Interrupted by server restart' : String(rawState.phase || ''),
        error: rawState.status === 'processing'
          ? 'Exam generation was interrupted by a server restart.'
          : typeof rawState.error === 'string'
            ? rawState.error
            : null,
        log: normalizeExamGenerationLog(rawState.log),
        files: Array.isArray(rawState.files) ? rawState.files.map(publicContextFile) : [],
      }
    }
  } catch {
    // Missing local generation state is normal.
  }
  return emptyExamGenerationState()
}

function emptyExamGenerationState() {
  return {
    status: 'idle',
    phase: '',
    fileCount: 0,
    files: [],
    startedAt: null,
    completedAt: null,
    threadId: null,
    generatedExamId: null,
    generatedExamTitle: null,
    questionCount: 0,
    log: [],
    error: null,
  }
}

function persistExamGenerationState() {
  fs.mkdirSync(contextDir, { recursive: true })
  fs.writeFileSync(examGenerationStatePath, JSON.stringify(publicExamGenerationState(), null, 2))
}

function publicExamGenerationState() {
  return {
    status: examGenerationState.status,
    phase: examGenerationState.phase || '',
    fileCount: Number(examGenerationState.fileCount) || 0,
    files: Array.isArray(examGenerationState.files) ? examGenerationState.files.map(publicContextFile) : [],
    startedAt: examGenerationState.startedAt ?? null,
    completedAt: examGenerationState.completedAt ?? null,
    threadId: examGenerationState.threadId ?? null,
    generatedExamId: examGenerationState.generatedExamId ?? null,
    generatedExamTitle: examGenerationState.generatedExamTitle ?? null,
    questionCount: Number(examGenerationState.questionCount) || 0,
    log: normalizeExamGenerationLog(examGenerationState.log),
    error: typeof examGenerationState.error === 'string' ? examGenerationState.error : null,
  }
}

function setExamGenerationPhase(jobId, phase) {
  if (jobId !== examGenerationJobId) return
  examGenerationState = {
    ...examGenerationState,
    phase,
  }
  appendExamGenerationLog(jobId, 'status', phase)
}

function appendExamGenerationLog(jobId, kind, message, detail = '') {
  if (jobId !== examGenerationJobId) return
  const text = String(message || '').trim()
  if (!text) return
  examGenerationState = {
    ...examGenerationState,
    log: [
      ...(Array.isArray(examGenerationState.log) ? examGenerationState.log : []),
      examGenerationLogEntry(kind, text, detail),
    ].slice(-400),
  }
  persistExamGenerationState()
}

function examGenerationLogEntry(kind, message, detail = '') {
  return {
    id: randomUUID(),
    at: new Date().toISOString(),
    kind: ['assistant', 'tool', 'status', 'error'].includes(kind) ? kind : 'status',
    message: String(message || ''),
    detail: String(detail || ''),
  }
}

function normalizeExamGenerationLog(log) {
  if (!Array.isArray(log)) return []
  return log.slice(-400).map((entry) => {
    if (typeof entry === 'string') {
      return examGenerationLogEntry('status', entry)
    }
    return {
      id: typeof entry?.id === 'string' ? entry.id : randomUUID(),
      at: typeof entry?.at === 'string' ? entry.at : new Date().toISOString(),
      kind: ['assistant', 'tool', 'status', 'error'].includes(entry?.kind) ? entry.kind : 'status',
      message: typeof entry?.message === 'string' ? entry.message : '',
      detail: typeof entry?.detail === 'string' ? entry.detail : '',
    }
  }).filter((entry) => entry.message.trim())
}

function mergedQuestionBank() {
  const baseBank = readJsonFile(questionBankPath, { schema: null, generatedAt: null, sets: [] })
  const generatedBank = loadGeneratedExamBank()
  return {
    ...baseBank,
    generatedAt: new Date().toISOString(),
    sets: [
      ...(Array.isArray(baseBank.sets) ? baseBank.sets : []),
      ...(Array.isArray(generatedBank.sets) ? generatedBank.sets : []),
    ],
  }
}

function loadGeneratedExamBank() {
  const fallback = { generatedAt: null, sets: [] }
  const bank = readJsonFile(generatedExamsPath, fallback)
  return {
    generatedAt: typeof bank.generatedAt === 'string' ? bank.generatedAt : null,
    sets: Array.isArray(bank.sets) ? bank.sets : [],
  }
}

function persistGeneratedExamSet(set) {
  const bank = loadGeneratedExamBank()
  const nextSets = [
    ...bank.sets.filter((candidate) => candidate.id !== set.id),
    set,
  ]
  fs.mkdirSync(contextDir, { recursive: true })
  fs.writeFileSync(generatedExamsPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    sets: nextSets,
  }, null, 2))
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

async function generatePersistentExam(jobId, files) {
  const examId = `generated-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
  const examAssetDir = path.join(generatedAssetsDir, examId)
  try {
    setExamGenerationPhase(jobId, 'Extracting lecture text')
    const extractedFiles = await Promise.all(files.map(extractContextFile))
    if (jobId !== examGenerationJobId) return

    const usableFiles = extractedFiles.filter((file) => file.text.trim())
    const failedFiles = extractedFiles.filter((file) => file.error)
    if (usableFiles.length === 0) {
      throw new Error([
        'No usable text could be extracted from the selected files.',
        ...failedFiles.map((file) => `${file.name}: ${file.error}`),
      ].filter(Boolean).join('\n'))
    }

    fs.mkdirSync(examAssetDir, { recursive: true })
    const baseBank = mergedQuestionBank()
    setExamGenerationPhase(jobId, 'Starting Codex generation thread')
    const generatedMarkdown = await generateExamWithCodex(jobId, {
      examId,
      examAssetDir,
      usableFiles,
      failedFiles,
      baseBank,
    })
    if (jobId !== examGenerationJobId) return

    setExamGenerationPhase(jobId, 'Validating generated exam')
    const rawSet = extractGeneratedQuestionSet(generatedMarkdown)
    const normalizedSet = normalizeGeneratedQuestionSet(rawSet, examId)
    validateGeneratedExamAssets(normalizedSet, examId)
    persistGeneratedExamSet(normalizedSet)

    examGenerationState = {
      ...examGenerationState,
      status: 'ready',
      phase: 'Generated exam ready',
      completedAt: new Date().toISOString(),
      generatedExamId: normalizedSet.id,
      generatedExamTitle: normalizedSet.title,
      questionCount: normalizedSet.questions.length,
      error: failedFiles.length > 0
        ? `Skipped ${failedFiles.length} file${failedFiles.length === 1 ? '' : 's'} with extraction errors.`
        : null,
    }
    appendExamGenerationLog(jobId, 'status', `Generated "${normalizedSet.title}" with ${normalizedSet.questions.length} questions.`)
    persistExamGenerationState()
  } catch (error) {
    if (jobId !== examGenerationJobId) return
    examGenerationState = {
      ...examGenerationState,
      status: 'error',
      phase: 'Generation failed',
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }
    appendExamGenerationLog(jobId, 'error', examGenerationState.error)
    persistExamGenerationState()
  }
}

async function generatePersistentContextForTopic(topicId, jobId) {
  try {
    const usableFiles = topicSourceFiles(topicId)
    const failedFiles = topicFailedSourceFiles(topicId)
    if (usableFiles.length === 0) {
      throw new Error([
        'No usable text could be extracted from this topic source list.',
        ...failedFiles.map((file) => `${file.name}: ${file.error}`),
      ].filter(Boolean).join('\n'))
    }

    const injectedPrompt = await summarizeCourseContextWithCodex(usableFiles, failedFiles)
    if (topicContextJobs.get(topicId) !== jobId) return

    upsertTopicContext(topicId, {
      status: 'ready',
      generatedAt: new Date().toISOString(),
      injectedPrompt,
      error: failedFiles.length > 0
        ? `Skipped ${failedFiles.length} source${failedFiles.length === 1 ? '' : 's'} with extraction errors.`
        : null,
      jobId,
    })
    tutorThreads.clear()
  } catch (error) {
    if (topicContextJobs.get(topicId) !== jobId) return
    upsertTopicContext(topicId, {
      status: 'error',
      generatedAt: null,
      injectedPrompt: '',
      error: error instanceof Error ? error.message : String(error),
      jobId,
    })
  }
}

async function generatePersistentExamForTopic(topicId, jobId) {
  const examId = `generated-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
  const examAssetDir = path.join(topicPath(topicId), 'generated-assets', examId)
  try {
    setTopicExamGenerationPhase(topicId, jobId, 'Reading topic lecture sources')
    const usableFiles = topicSourceFiles(topicId)
    const failedFiles = topicFailedSourceFiles(topicId)
    if (topicExamGenerationJobs.get(topicId) !== jobId) return
    if (usableFiles.length === 0) {
      throw new Error([
        'No usable extracted lecture text exists for this topic.',
        ...failedFiles.map((file) => `${file.name}: ${file.error}`),
      ].filter(Boolean).join('\n'))
    }

    fs.mkdirSync(examAssetDir, { recursive: true })
    const baseBank = topicQuestionBank(topicId)
    setTopicExamGenerationPhase(topicId, jobId, 'Starting Codex generation thread')
    const generatedMarkdown = await generateExamWithCodex(jobId, {
      topicId,
      examId,
      examAssetDir,
      usableFiles,
      failedFiles,
      baseBank,
    })
    if (topicExamGenerationJobs.get(topicId) !== jobId) return

    setTopicExamGenerationPhase(topicId, jobId, 'Validating generated exam')
    const rawSet = extractGeneratedQuestionSet(generatedMarkdown)
    const normalizedSet = normalizeGeneratedQuestionSet(rawSet, examId, topicId)
    validateGeneratedExamAssets(normalizedSet, examId, topicId)
    persistGeneratedExamSetForTopic(topicId, normalizedSet)

    completeTopicExamGenerationJob(topicId, jobId, {
      status: 'ready',
      phase: 'Generated exam ready',
      completedAt: new Date().toISOString(),
      error: failedFiles.length > 0
        ? `Skipped ${failedFiles.length} source${failedFiles.length === 1 ? '' : 's'} with extraction errors.`
        : null,
      resultId: normalizedSet.id,
    })
    appendTopicExamGenerationLog(topicId, jobId, 'status', `Generated "${normalizedSet.title}" with ${normalizedSet.questions.length} questions.`)
  } catch (error) {
    if (topicExamGenerationJobs.get(topicId) !== jobId) return
    completeTopicExamGenerationJob(topicId, jobId, {
      status: 'error',
      phase: 'Generation failed',
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    })
    appendTopicExamGenerationLog(topicId, jobId, 'error', error instanceof Error ? error.message : String(error))
  }
}

async function generateExamWithCodex(jobId, { topicId = null, examId, examAssetDir, usableFiles, failedFiles, baseBank }) {
  const thread = await codex.request('thread/start', {
    cwd: appRoot,
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    ephemeral: true,
    developerInstructions: `
You generate high-quality TurboLearner exam question sets from course lecture material.
For image-based questions, use Codex's built-in image generation capability through the imagegen skill / image_gen tool when available.
Built-in image generation saves images under $CODEX_HOME/generated_images by default; copy the selected PNG/JPEG into the requested exam asset directory before returning JSON.
You may run local commands to inspect/copy generated images and verify generated assets, but do not browse the web and do not call third-party APIs from shell scripts.
Return the final question set JSON in one fenced json block after any work is complete.
`.trim(),
  })
  if (!isExamJobCurrent(topicId, jobId)) return ''
  if (topicId) appendTopicExamGenerationLog(topicId, jobId, 'status', `Codex thread: ${thread.thread.id}`)
  else {
    examGenerationState = {
      ...examGenerationState,
      threadId: thread.thread.id,
    }
    persistExamGenerationState()
    appendExamGenerationLog(jobId, 'status', `Codex thread: ${thread.thread.id}`)
  }

  let markdown = ''
  await codex.startTurn({
    threadId: thread.thread.id,
    input: [{ type: 'text', text: buildExamGenerationPrompt({ topicId, examId, examAssetDir, usableFiles, failedFiles, baseBank }), text_elements: [] }],
    cwd: appRoot,
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    timeoutMs: examGenerationTurnTimeoutMs,
    onNotification: (message) => {
      if (message.method === 'item/agentMessage/delta') {
        const delta = message.params?.delta ?? ''
        markdown += delta
        if (topicId) appendTopicExamGenerationLog(topicId, jobId, 'assistant', delta)
        else appendExamGenerationLog(jobId, 'assistant', delta)
      }
      if (message.method === 'item/started') {
        if (topicId) appendTopicExamGenerationLog(topicId, jobId, 'tool', summarizeCodexItem(message.params?.item, 'Started'), summarizeCodexItemDetail(message.params?.item))
        else appendExamGenerationLog(jobId, 'tool', summarizeCodexItem(message.params?.item, 'Started'), summarizeCodexItemDetail(message.params?.item))
      }
      if (message.method === 'item/completed') {
        if (topicId) appendTopicExamGenerationLog(topicId, jobId, 'tool', summarizeCodexItem(message.params?.item, 'Completed'), summarizeCodexItemDetail(message.params?.item))
        else appendExamGenerationLog(jobId, 'tool', summarizeCodexItem(message.params?.item, 'Completed'), summarizeCodexItemDetail(message.params?.item))
      }
    },
  })

  const finalMarkdown = markdown.trim()
  if (!finalMarkdown) throw new Error('Codex generated an empty exam response.')
  return finalMarkdown
}

function isExamJobCurrent(topicId, jobId) {
  if (topicId) return topicExamGenerationJobs.get(topicId) === jobId
  return jobId === examGenerationJobId
}

function summarizeCodexItem(item, prefix) {
  const title = item?.title || item?.name || item?.type || 'Codex item'
  return `${prefix}: ${title}`
}

function summarizeCodexItemDetail(item) {
  if (!item || typeof item !== 'object') return ''
  const parts = []
  if (typeof item.command === 'string') parts.push(item.command)
  if (Array.isArray(item.args)) parts.push(item.args.join(' '))
  if (typeof item.path === 'string') parts.push(item.path)
  if (typeof item.status === 'string') parts.push(item.status)
  return parts.filter(Boolean).join(' · ')
}

function buildExamGenerationPrompt({ topicId = null, examId, examAssetDir, usableFiles, failedFiles, baseBank }) {
  const styleBank = {
    schema: baseBank.schema,
    sets: (baseBank.sets ?? []).map((set) => ({
      id: set.id,
      title: set.title,
      description: set.description,
      questions: set.questions,
    })),
  }
  const extractionNotes = failedFiles.length > 0
    ? failedFiles.map((file) => `- ${file.name}: ${file.error}`).join('\n')
    : 'none'
  const imageUrlPrefix = topicId
    ? `/api/generated-assets/${topicId}/${examId}/`
    : `/api/generated-assets/${examId}/`

  return `
Generate one new TurboLearner exam question set.

Exam id to use exactly: ${examId}
Asset directory for any generated PNG/JPEG images: ${examAssetDir}
Image URL prefix for generated images: ${imageUrlPrefix}

Output contract:
- Return exactly one JSON object for a TurboLearner question set, not a full bank.
- Put the final JSON inside a fenced \`\`\`json block.
- The object must have: id, title, description, sourcePath, questions.
- Use a concise title, preferably "Generated Exam N" or "Generated ML Exam".
- Use a very short description, maximum 8 words. Do not enumerate all topics in the description.
- Every question must follow schema version 2 from the examples.
- Use setId "${examId}" on every question.
- Use source "Generated Exam".
- Use answer.source "inferred" for every generated answer.
- For open questions, options must be [] and answer.expectedText must contain the rubric/model answer.
- For normal single-choice MCQs, use exactly 4 options.
- For true/false or yes/no single-choice questions, use exactly 2 options.
- Do not force true/false questions into 4 options.
- For multi-select questions, use 3-5 options.
- For single/multiple questions, answer.correctOptionIds must contain canonical option ids.
- Include correctOptionIds legacy mirror for choice questions.
- Avoid making correct answers longer, more specific, or stylistically different than distractors.
- Make questions non-trivial, course-grounded, and hard to guess.
- Include grouped questions where the source exam style supports them.
- Include code examples and image-based questions where course material supports them.

Image requirements:
- Do not output SVG.
- If a question needs a diagram/chart/graph, use the built-in imagegen skill / image_gen tool to create a polished raster PNG/JPEG.
- Do not use Matplotlib for generated exam images unless imagegen is unavailable and the question would otherwise have to be dropped.
- After imagegen creates an image under $CODEX_HOME/generated_images, copy the selected output into the asset directory.
- Use local shell commands only to create directories, copy imagegen output, inspect files, and verify that referenced PNG/JPEG assets exist.
- Reference images in prompts as <image>${imageUrlPrefix}filename.png</image>.
- Include the same URL in imagePaths.
- Filenames must not reveal the answer.

Quality requirements:
- Match the existing exams' style, phrasing, grouping, point values, and difficulty.
- Infer exam length and type mix from all style examples.
- Cover the selected lecture material broadly without adding topics not evidenced by lectures.
- Repeating important concepts is allowed and useful for spaced practice.
- When repeating a concept from an existing exam, test it from a fresh angle with different phrasing, scenario, code bug, numeric setup, diagram, or option pattern.
- Use existing exams as schema/style references, not as templates to paraphrase.
- Do not clone the same surface scenario, code bug, diagram concept, numeric setup, or option pattern from the examples.
- Prefer lecture-covered concepts and angles that are underrepresented in the existing examples.
- Code questions should vary the implementation mistakes they test; do not repeatedly use the same precision/recall/F1 bug unless the lecture material makes that repetition necessary.
- Before finalizing each question, check whether it is testing a new angle or merely rewording an example; replace it if it is merely a rewording.
- Include math/code tags using TurboLearner syntax when useful.

Extraction notes:
${extractionNotes}

Existing style/schema examples:
${JSON.stringify(styleBank, null, 2)}

Selected lecture text:
${usableFiles.map((file) => `
--- BEGIN FILE: ${file.name} ---
${file.text}
--- END FILE: ${file.name} ---
`).join('\n')}
`.trim()
}

function extractGeneratedQuestionSet(markdown) {
  const fenced = [...markdown.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((match) => match[1].trim())
    .reverse()
    .find((block) => block.startsWith('{'))
  const rawJson = fenced || markdown.slice(markdown.indexOf('{'), markdown.lastIndexOf('}') + 1)
  if (!rawJson.trim()) throw new Error('Could not find generated exam JSON in Codex response.')
  try {
    const parsed = JSON.parse(rawJson)
    if (Array.isArray(parsed?.sets)) return parsed.sets[0]
    return parsed
  } catch (error) {
    throw new Error(`Generated exam JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function normalizeGeneratedQuestionSet(rawSet, examId, topicId = null) {
  if (!rawSet || typeof rawSet !== 'object') throw new Error('Generated exam is not an object.')
  const questions = Array.isArray(rawSet.questions) ? rawSet.questions : []
  if (questions.length === 0) throw new Error('Generated exam contains no questions.')

  const set = {
    id: examId,
    title: nonEmptyString(rawSet.title, 'Generated Exam'),
    description: nonEmptyString(rawSet.description, 'Codex-generated practice exam.'),
    sourcePath: topicId
      ? `.turbolearner/topics/${topicId}/generated-assets/${examId}`
      : '.turbolearner/generated-exams.json',
    questions: questions.map((question, index) => normalizeGeneratedQuestion(question, examId, index)),
  }
  validateQuestionSetShape(set)
  return set
}

function normalizeGeneratedQuestion(question, examId, index) {
  if (!question || typeof question !== 'object') throw new Error(`Question ${index + 1} is not an object.`)
  const type = ['single', 'multiple', 'open'].includes(question.type) ? question.type : null
  if (!type) throw new Error(`Question ${index + 1} has invalid type.`)
  const number = nonEmptyString(question.number, String(index + 1))
  const id = stableId(question.id, `${examId}-q${slugQuestionNumber(number) || index + 1}`)
  const options = type === 'open'
    ? []
    : normalizeOptions(question.options, id, type)
  const answer = normalizeGeneratedAnswer(question.answer, question, options, type, id)

  return {
    id,
    setId: examId,
    source: 'Generated Exam',
    number,
    title: nonEmptyString(question.title, `Question ${number}`),
    type,
    prompt: nonEmptyString(question.prompt, ''),
    ...(Number.isFinite(Number(question.points)) ? { points: Number(question.points) } : {}),
    options,
    answer,
    ...(answer.correctOptionIds ? { correctOptionIds: answer.correctOptionIds } : {}),
    ...(typeof question.expectedAnswer === 'string' ? { expectedAnswer: question.expectedAnswer } : {}),
    ...(Array.isArray(question.imagePaths) ? { imagePaths: question.imagePaths.map(String) } : {}),
    ...(question.groupId ? { groupId: stableId(question.groupId, `${examId}-group-${index + 1}`) } : {}),
    ...(typeof question.groupTitle === 'string' ? { groupTitle: question.groupTitle } : {}),
    ...(typeof question.groupPrompt === 'string' ? { groupPrompt: question.groupPrompt } : {}),
    ...(Number.isInteger(question.groupOrder) ? { groupOrder: question.groupOrder } : {}),
    ...(Array.isArray(question.concepts) ? { concepts: question.concepts.map((concept) => stableId(concept, 'concept')).filter(Boolean) } : { concepts: [] }),
  }
}

function normalizeOptions(options, questionId, type) {
  if (!Array.isArray(options)) throw new Error(`${questionId} is missing options.`)
  if (type === 'single' && options.length !== 4 && !(options.length === 2 && isBinaryChoiceOptions(options))) {
    throw new Error(`${questionId} must have exactly 4 options, or 2 options for true/false or yes/no questions.`)
  }
  if (type === 'multiple' && (options.length < 3 || options.length > 5)) {
    throw new Error(`${questionId} must have 3-5 options.`)
  }
  return options.map((option, index) => ({
    id: nonEmptyString(option?.id, String.fromCharCode(65 + index)),
    text: nonEmptyString(option?.text, ''),
  }))
}

function normalizeGeneratedAnswer(answer, question, options, type, questionId) {
  const rawCorrectIds =
    Array.isArray(answer?.correctOptionIds) ? answer.correctOptionIds :
      Array.isArray(question.correctOptionIds) ? question.correctOptionIds :
        null
  const correctOptionIds = type === 'open'
    ? null
    : uniqueStrings(rawCorrectIds?.map(String) ?? []).filter((id) => options.some((option) => option.id === id))
  if (type !== 'open' && correctOptionIds.length === 0) {
    throw new Error(`${questionId} is missing a valid answer.correctOptionIds array.`)
  }

  return {
    correctOptionIds: type === 'open' ? null : correctOptionIds,
    expectedText: type === 'open'
      ? nonEmptyString(answer?.expectedText ?? question.expectedAnswer, '')
      : (typeof answer?.expectedText === 'string' ? answer.expectedText : null),
    source: 'inferred',
  }
}

function validateQuestionSetShape(set) {
  for (const question of set.questions) {
    const required = ['id', 'setId', 'source', 'number', 'title', 'type', 'prompt', 'options', 'answer']
    for (const field of required) {
      if (!(field in question)) throw new Error(`${question.id || 'Question'} is missing ${field}.`)
    }
    if (question.type === 'open' && question.options.length !== 0) {
      throw new Error(`${question.id} is open but has options.`)
    }
    if (question.type === 'single' && question.options.length !== 4 && !(question.options.length === 2 && isBinaryChoiceOptions(question.options))) {
      throw new Error(`${question.id} must have exactly 4 options, or 2 options for true/false or yes/no questions.`)
    }
    if (question.type === 'multiple' && (question.options.length < 3 || question.options.length > 5)) {
      throw new Error(`${question.id} must have 3-5 options.`)
    }
  }
}

function isBinaryChoiceOptions(options) {
  const labels = options.map((option) => String(option?.text ?? '').trim().toLowerCase())
  const normalized = new Set(labels)
  return (
    normalized.size === 2 &&
    (
      (normalized.has('true') && normalized.has('false')) ||
      (normalized.has('yes') && normalized.has('no'))
    )
  )
}

function validateGeneratedExamAssets(set, examId, topicId = null) {
  const expectedPrefix = topicId
    ? `/api/generated-assets/${topicId}/${examId}/`
    : `/api/generated-assets/${examId}/`
  for (const question of set.questions) {
    const paths = [
      ...extractImageTags(question.prompt),
      ...(Array.isArray(question.imagePaths) ? question.imagePaths : []),
      ...(question.groupPrompt ? extractImageTags(question.groupPrompt) : []),
    ]
    for (const imagePath of paths) {
      if (!imagePath.startsWith(expectedPrefix)) continue
      const file = sanitizePathSegment(imagePath.slice(expectedPrefix.length))
      const diskPath = topicId
        ? path.join(topicPath(topicId), 'generated-assets', examId, file)
        : path.join(generatedAssetsDir, examId, file)
      if (!/\.(png|jpe?g)$/i.test(file)) throw new Error(`${question.id} references a non-PNG/JPEG generated image.`)
      if (!fs.existsSync(diskPath)) throw new Error(`${question.id} references missing generated image: ${imagePath}`)
    }
  }
}

function nonEmptyString(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text) return text
  if (fallback) return fallback
  throw new Error('Generated exam contains an empty required string.')
}

function stableId(value, fallback) {
  const text = String(value || fallback || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
  return text || fallback
}

function slugQuestionNumber(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function sanitizePathSegment(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '')
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

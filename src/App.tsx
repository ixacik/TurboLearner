import {
  createElement,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  ComponentProps,
  ComponentType,
  CSSProperties,
  FormEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
  SetStateAction,
} from 'react'
import Markdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import mermaid from 'mermaid'
import {
  Braces,
  File,
  FileCode2,
  FilePlus,
  FileJson,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FolderOpen,
  FolderPlus,
  NotebookText,
} from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import { Link, useLoaderData, useNavigate, useParams, useSearchParams } from 'react-router'
import type { LoaderFunctionArgs } from 'react-router'
import 'katex/dist/katex.min.css'
import './App.css'

type QuestionType = 'single' | 'multiple' | 'open'

type Option = {
  id: string
  text: string
  visibleLabel?: string
}

type Question = {
  id: string
  setId: string
  source: string
  number: string
  title: string
  type: QuestionType
  prompt: string
  points?: number
  options: Option[]
  answer?: {
    correctOptionIds: string[] | null
    expectedText: string | null
    source: 'provided' | 'inferred' | 'missing'
  }
  correctOptionIds?: string[]
  expectedAnswer?: string
  imagePaths?: string[]
  groupId?: string
  groupTitle?: string
  groupPrompt?: string
  groupOrder?: number
  concepts?: string[]
}

type QuestionSet = {
  id: string
  title: string
  description: string
  sourceType: 'static' | 'generated'
  sourcePath?: string
  questions: Question[]
}

type QuestionBank = {
  schema: unknown
  generatedAt: string
  sets: QuestionSet[]
}

type AnswerPayload = {
  selectedOptionIds?: string[]
  text?: string
}

type GroupAnswerPayload = {
  subAnswers: Array<{
    questionId: string
    number: string
    type: QuestionType
    selectedOptionIds?: string[]
    text?: string
  }>
}

type QuestionUnit = {
  id: string
  source: string
  title: string
  questions: Question[]
  sharedPrompt?: string
  concepts: string[]
}

type TutorResponse = {
  isCorrect: boolean
  score: number
  verdict: string
  explanation: string
  concepts: string[]
  nextPrompt: string
  correctOptionIds?: string[]
  correctOptionIdsByQuestion?: Record<string, string[]>
  questionScores?: Record<string, number>
  questionCorrectness?: Record<string, boolean>
}

type TutorStreamEvent =
  | { type: 'status'; message: string }
  | { type: 'delta'; delta: string }
  | { type: 'final'; response: TutorResponse }
  | { type: 'done' }

type ContextStatus = 'idle' | 'processing' | 'ready' | 'error'

type ContextFile = {
  name: string
  sourceKind?: SourceKind
  relativePath?: string
  size: number
  extension: string
}

type CourseContextState = {
  status: ContextStatus
  fileCount: number
  files: ContextFile[]
  generatedAt: string | null
  startedAt: string | null
  completedAt: string | null
  threadId: string | null
  log: ExamGenerationLogEntry[]
  injectedPrompt: string
  error: string | null
}

type Topic = {
  id: string
  name: string
  emoji: string
  examCount: number
  sourceCount: number
  seen: number
  last25: HistoryItem[]
  correctLast25: number
  createdAt: string
  updatedAt: string
}

type TopicSource = {
  id: string
  name: string
  sourceKind: SourceKind
  relativePath: string
  size: number
  extension: string
  extractionStatus: 'pending' | 'ready' | 'error'
  extractionError: string | null
  createdAt: string
  updatedAt: string
}

type SourceSidebarItem = {
  key: string
  name: string
  size: number
  extractionStatus: TopicSource['extractionStatus']
  extractionError: string | null
  sourceIds: string[]
} & ({
  kind: 'source'
  source: TopicSource
} | {
  kind: 'folder'
  fileCount: number
  sortDate: string
})

type SourceKind = 'lecture' | 'code-example'
type SourceUploadKind = SourceKind | 'auto'

type SourceUploadInput = File | {
  file: File
  relativePath?: string
}

type SourceFileSystemFileHandle = {
  kind: 'file'
  name: string
  getFile: () => Promise<File>
}

type SourceFileSystemDirectoryHandle = {
  kind: 'directory'
  name: string
  values: () => AsyncIterable<SourceFileSystemFileHandle | SourceFileSystemDirectoryHandle>
}

type SourceDirectoryPickerWindow = Window & {
  showDirectoryPicker?: () => Promise<SourceFileSystemDirectoryHandle>
}

const assignmentFolderExtensions = new Set([
  '.pdf',
  '.py',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.ipynb',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.go',
  '.rs',
  '.rb',
  '.php',
  '.html',
  '.css',
  '.sql',
  '.sh',
  '.yml',
  '.yaml',
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.log',
])

const ignoredAssignmentFolderSegments = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.venv',
  'venv',
  '__pycache__',
])

const ignoredAssignmentFolderFiles = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'poetry.lock',
  'pipfile.lock',
  'cargo.lock',
  'composer.lock',
])

type TopicRouteState = {
  topicId: string
  bank: QuestionBank
  context: CourseContextState
  generation: ExamGenerationState
  sessions: Record<string, ExamSession>
  sources: TopicSource[]
}

type AppLoaderData = {
  topics: Topic[]
  topicState: TopicRouteState | null
}

type ExamGenerationStatus = 'idle' | 'processing' | 'ready' | 'error'

type ExamGenerationLogEntry = {
  id: string
  at: string
  kind: 'assistant' | 'tool' | 'status' | 'error'
  message: string
  detail?: string
}

type ExamGenerationState = {
  status: ExamGenerationStatus
  phase: string
  fileCount: number
  files: ContextFile[]
  startedAt: string | null
  completedAt: string | null
  threadId: string | null
  generatedExamId: string | null
  generatedExamTitle: string | null
  questionCount: number
  log: ExamGenerationLogEntry[]
  error: string | null
}

type ProgressRecord = {
  attempts: number
  correct: number
  wrong: number
  streak: number
  dueAt: number
  ease: number
  lastSeenAt?: number
}

type HistoryItem = {
  questionId: string
  title: string
  isCorrect: boolean
  answeredAt: number
}

type TutorMessage = {
  role: 'learner' | 'tutor'
  content: string
  kind?: 'chat' | 'grading' | 'learning' | 'pending' | 'grading-pending' | 'learning-pending'
}

type ExamSession = {
  currentId: string | null
  questionQueue: string[]
  answersByQuestion: Record<string, AnswerPayload>
  result: TutorResponse | null
  isAnswerKeyRevealed: boolean
  revealedCorrectOptionIdsByQuestion: Record<string, string[]>
  messages: TutorMessage[]
  tutorSessionId: string
  optionOrderSeed: string
  usedLearningBeforeAnswer: boolean
  progress: Record<string, ProgressRecord>
  history: HistoryItem[]
}

type MarkdownCopyPopup = {
  markdown: string
  status: 'idle' | 'copied' | 'failed'
  x: number
  y: number
}

type ChatComposerHandle = {
  focus: () => void
}

function persistedTutorMessages(messages: TutorMessage[]) {
  return messages.filter((message) => {
    if (
      message.kind === 'pending' ||
      message.kind === 'grading-pending' ||
      message.kind === 'learning-pending'
    ) return false
    return message.content.trim()
  })
}

function identity<T>(value: T) {
  return value
}

const activeSetKey = 'turbolearner.activeSet.v1'
const activeTopicKey = 'turbolearner.activeTopic.v1'
const examSessionsKey = 'turbolearner.examSessions.v1'
const sqliteMigrationKey = 'turbolearner.sqliteMigration.v1'
const codexSidebarWidthKey = 'turbolearner.codexSidebarWidth.v1'
const defaultCodexSidebarWidth = 480
const minCodexSidebarWidth = 360
const maxCodexSidebarWidth = 760
const codexAutoScrollThreshold = 32
const localStatePersistenceDelayMs = 250
const emptyCourseContextState: CourseContextState = {
  status: 'idle',
  fileCount: 0,
  files: [],
  generatedAt: null,
  startedAt: null,
  completedAt: null,
  threadId: null,
  log: [],
  injectedPrompt: '',
  error: null,
}
const emptyProgressRecords: Record<string, ProgressRecord> = {}
const emptyHistoryItems: HistoryItem[] = []
const emptyQuestionQueue: string[] = []
const emptyAnswersByQuestion: Record<string, AnswerPayload> = {}
const emptyRevealedCorrectOptionIdsByQuestion: Record<string, string[]> = {}
const emptyTutorMessages: TutorMessage[] = []
const emptyExamGenerationState: ExamGenerationState = {
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
const codeLanguageAliases: Record<string, string> = {
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  tsx: 'tsx',
}

const markdownRemarkPlugins = [remarkGfm, remarkMath]
const markdownRehypePlugins = [rehypeSourceSpans, rehypeKatex]
const markdownComponents = {
  table(props: ComponentProps<'table'>) {
    const { node, ...tableProps } = props as ComponentProps<'table'> & MarkdownNodeProps
    return (
      <div className="markdown-table-wrap" {...markdownSourceProps(node)}>
        <table {...tableProps} />
      </div>
    )
  },
  code(props: ComponentProps<'code'>) {
    const { children: codeChildren, className, node } = props as ComponentProps<'code'> & MarkdownNodeProps
    const match = /language-([\w-]+)/.exec(className || '')
    const code = String(codeChildren).replace(/\n$/, '')
    const rawLanguage = match?.[1]?.toLowerCase()
    const language = rawLanguage ? codeLanguageAliases[rawLanguage] ?? rawLanguage : null

    if (language === 'mermaid') return <MermaidDiagram chart={code} />
    if (language) {
      return (
        <SyntaxHighlighter
          className="markdown-code-block"
          codeTagProps={{ className: 'markdown-code' }}
          customStyle={{
            margin: 0,
            padding: '16px',
            borderRadius: '6px',
            background: 'var(--code-bg)',
            fontSize: '0.95em',
            lineHeight: 1.55,
          }}
          language={language}
          PreTag="div"
          style={oneDark}
          wrapLongLines
        >
          {code}
        </SyntaxHighlighter>
      )
    }

    return (
      <code className={className} {...markdownSourceProps(node)}>
        {codeChildren}
      </code>
    )
  },
  img(props: ComponentProps<'img'>) {
    const { src, alt } = props
    return (
      <img
        src={resolveImageSource(src)}
        alt={alt || 'Question attachment'}
        loading="lazy"
      />
    )
  },
  p: markdownElement('p'),
  li: markdownElement('li'),
  h1: markdownElement('h1'),
  h2: markdownElement('h2'),
  h3: markdownElement('h3'),
  h4: markdownElement('h4'),
  h5: markdownElement('h5'),
  h6: markdownElement('h6'),
}

type MarkdownNodeProps = {
  node?: {
    position?: {
      start?: { offset?: number }
      end?: { offset?: number }
    }
  }
}

function markdownSourceProps(node: MarkdownNodeProps['node']) {
  const start = node?.position?.start?.offset
  const end = node?.position?.end?.offset
  if (typeof start !== 'number' || typeof end !== 'number') return {}
  return {
    'data-md-start': String(start),
    'data-md-end': String(end),
  }
}

function markdownElement(tag: keyof HTMLElementTagNameMap) {
  return function MarkdownElement(props: unknown) {
    const { node, ...elementProps } = props as Record<string, unknown> & MarkdownNodeProps
    return createElement(tag, {
      ...elementProps,
      ...markdownSourceProps(node),
    })
  }
}

type HastNode = {
  type?: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
  position?: {
    start?: { offset?: number }
    end?: { offset?: number }
  }
}

function rehypeSourceSpans() {
  return function transform(tree: HastNode) {
    wrapSourceTextNodes(tree)
  }
}

function wrapSourceTextNodes(node: HastNode, parentTag = '') {
  if (!node.children || shouldSkipSourceSpanChildren(parentTag)) return

  node.children = node.children.map((child) => {
    if (child.type === 'text' && child.value) {
      const sourceProps = markdownSourceProps(child)
      if (Object.keys(sourceProps).length === 0) return child
      return {
        type: 'element',
        tagName: 'span',
        properties: sourceProps,
        children: [child],
        position: child.position,
      }
    }

    if (child.type === 'element') wrapSourceTextNodes(child, child.tagName ?? '')
    return child
  })
}

function shouldSkipSourceSpanChildren(tagName: string) {
  return tagName === 'code' || tagName === 'pre' || tagName === 'script' || tagName === 'style'
}

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' })

export async function rootLoader(): Promise<AppLoaderData> {
  return {
    topics: await loadTopicsFromApi(),
    topicState: null,
  }
}

export async function topicLoader({ params }: LoaderFunctionArgs): Promise<AppLoaderData> {
  const topicId = params.topicId
  if (!topicId) throw new Error('Topic not found.')
  const [
    topics,
    bank,
    context,
    generation,
    sessionsPayload,
    sourcesPayload,
  ] = await Promise.all([
    loadTopicsFromApi(),
    fetch(`/api/topics/${encodeURIComponent(topicId)}/question-bank`).then(jsonResponse<QuestionBank>),
    fetch(`/api/topics/${encodeURIComponent(topicId)}/context`).then(jsonResponse<CourseContextState>),
    fetch(`/api/topics/${encodeURIComponent(topicId)}/exam-generation`).then(jsonResponse<ExamGenerationState>),
    fetch(`/api/topics/${encodeURIComponent(topicId)}/sessions`).then(jsonResponse<{ sessions: Record<string, ExamSession> }>),
    fetch(`/api/topics/${encodeURIComponent(topicId)}/sources`).then(jsonResponse<{ sources: TopicSource[] }>),
  ])

  return {
    topics,
    topicState: {
      topicId,
      bank,
      context,
      generation,
      sessions: sessionsPayload.sessions,
      sources: sourcesPayload.sources,
    },
  }
}

function App() {
  const loaderData = useLoaderData() as AppLoaderData
  const navigate = useNavigate()
  const routeParams = useParams<{ topicId?: string; setId?: string }>()
  const [searchParams] = useSearchParams()
  const selectedTopicId = routeParams.topicId ?? null
  const selectedSetId = routeParams.setId ?? null
  const [topics, setTopics] = useState<Topic[]>(loaderData.topics)
  const [loadedTopicId, setLoadedTopicId] = useState<string | null>(loaderData.topicState?.topicId ?? null)
  const [bank, setBank] = useState<QuestionBank | null>(loaderData.topicState?.bank ?? null)
  const [examSessions, setExamSessions] = useState<Record<string, ExamSession>>(loaderData.topicState?.sessions ?? {})
  const [topicSources, setTopicSources] = useState<TopicSource[]>(loaderData.topicState?.sources ?? [])
  const [hasRunLocalStorageMigration, setHasRunLocalStorageMigration] = useState(false)
  const [isGrading, setIsGrading] = useState(false)
  const [isSubmittingAnswer, setIsSubmittingAnswer] = useState(false)
  const [codexStatus, setCodexStatus] = useState('')
  const [codexSidebarWidth, setCodexSidebarWidth] = useLocalState(
    codexSidebarWidthKey,
    defaultCodexSidebarWidth,
  )
  const [isResizingSidebar, setIsResizingSidebar] = useState(false)
  const {
    text: streamingTutorMessage,
    append: appendStreamingTutorMessage,
    clear: clearStreamingTutorMessage,
  } = useBatchedStreamingText()
  const [streamingMessageKind, setStreamingMessageKind] = useState<TutorMessage['kind'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [courseContext, setCourseContext] = useState<CourseContextState>(loaderData.topicState?.context ?? emptyCourseContextState)
  const [isContextModalOpen, setIsContextModalOpen] = useState(false)
  const [examGeneration, setExamGeneration] = useState<ExamGenerationState>(loaderData.topicState?.generation ?? emptyExamGenerationState)
  const [isExamGenerationModalOpen, setIsExamGenerationModalOpen] = useState(false)
  const [examGenerationToast, setExamGenerationToast] = useState<string | null>(null)
  const chatComposerRef = useRef<ChatComposerHandle>(null)
  const codexLogRef = useRef<HTMLDivElement>(null)
  const shouldFollowCodexStreamRef = useRef(true)
  const isUserScrollingCodexRef = useRef(false)
  const codexScrollIntentResetRef = useRef<number | null>(null)
  const courseContextSignatureRef = useRef<string | null>(null)
  const examGenerationStatusRef = useRef<ExamGenerationStatus>('idle')
  const activeTopic = topics.find((topic) => topic.id === selectedTopicId) ?? null
  const activeSession = selectedSetId ? examSessions[selectedSetId] ?? null : null
  const progress = activeSession?.progress ?? emptyProgressRecords
  const history = activeSession?.history ?? emptyHistoryItems
  const currentId = activeSession?.currentId ?? null
  const questionQueue = activeSession?.questionQueue ?? emptyQuestionQueue
  const answersByQuestion = activeSession?.answersByQuestion ?? emptyAnswersByQuestion
  const result = activeSession?.result ?? null
  const isAnswerKeyRevealed = activeSession?.isAnswerKeyRevealed ?? false
  const revealedCorrectOptionIdsByQuestion =
    activeSession?.revealedCorrectOptionIdsByQuestion ?? emptyRevealedCorrectOptionIdsByQuestion
  const messages = activeSession?.messages ?? emptyTutorMessages
  const tutorSessionId = activeSession?.tutorSessionId ?? ''
  const optionOrderSeed = activeSession?.optionOrderSeed ?? ''
  const usedLearningBeforeAnswer = activeSession?.usedLearningBeforeAnswer ?? false

  const updateActiveSession = useCallback((updater: (session: ExamSession) => ExamSession) => {
    if (!selectedSetId) return

    setExamSessions((sessions) => {
      const session = sessions[selectedSetId]
      if (!session) return sessions
      const nextSession = updater(session)
      if (nextSession === session) return sessions
      return { ...sessions, [selectedSetId]: nextSession }
    })
  }, [selectedSetId, setExamSessions])

  const updateActiveSessionField = useCallback(<K extends keyof ExamSession>(
    key: K,
    value: SetStateAction<ExamSession[K]>,
  ) => {
    updateActiveSession((session) => ({
      ...session,
      [key]: typeof value === 'function'
        ? (value as (current: ExamSession[K]) => ExamSession[K])(session[key])
        : value,
    }))
  }, [updateActiveSession])

  const setCurrentId = useCallback((value: SetStateAction<string | null>) => {
    updateActiveSessionField('currentId', value)
  }, [updateActiveSessionField])
  const setQuestionQueue = useCallback((value: SetStateAction<string[]>) => {
    updateActiveSessionField('questionQueue', value)
  }, [updateActiveSessionField])
  const setAnswersByQuestion = useCallback((value: SetStateAction<Record<string, AnswerPayload>>) => {
    updateActiveSessionField('answersByQuestion', value)
  }, [updateActiveSessionField])
  const setResult = useCallback((value: SetStateAction<TutorResponse | null>) => {
    updateActiveSessionField('result', value)
  }, [updateActiveSessionField])
  const setIsAnswerKeyRevealed = useCallback((value: SetStateAction<boolean>) => {
    updateActiveSessionField('isAnswerKeyRevealed', value)
  }, [updateActiveSessionField])
  const setRevealedCorrectOptionIdsByQuestion = useCallback((
    value: SetStateAction<Record<string, string[]>>,
  ) => {
    updateActiveSessionField('revealedCorrectOptionIdsByQuestion', value)
  }, [updateActiveSessionField])
  const setMessages = useCallback((value: SetStateAction<TutorMessage[]>) => {
    updateActiveSessionField('messages', value)
  }, [updateActiveSessionField])
  const setTutorSessionId = useCallback((value: SetStateAction<string>) => {
    updateActiveSessionField('tutorSessionId', value)
  }, [updateActiveSessionField])
  const setOptionOrderSeed = useCallback((value: SetStateAction<string>) => {
    updateActiveSessionField('optionOrderSeed', value)
  }, [updateActiveSessionField])
  const setUsedLearningBeforeAnswer = useCallback((value: SetStateAction<boolean>) => {
    updateActiveSessionField('usedLearningBeforeAnswer', value)
  }, [updateActiveSessionField])

  const applyCourseContextState = useCallback((nextContext: CourseContextState) => {
    setCourseContext(nextContext)
    const nextSignature = courseContextSignature(nextContext)
    const previousSignature = courseContextSignatureRef.current
    courseContextSignatureRef.current = nextSignature
    if (
      previousSignature !== null &&
      previousSignature !== nextSignature &&
      (nextContext.status === 'ready' || nextContext.status === 'idle')
    ) {
      setTutorSessionId(crypto.randomUUID())
    }
  }, [setTutorSessionId])

  const refreshTopics = useCallback(async () => {
    const nextTopics = await loadTopicsFromApi()
    setTopics(nextTopics)
    return nextTopics
  }, [])

  const refreshCourseContext = useCallback(async () => {
    if (!selectedTopicId) return
    const response = await fetch(`/api/topics/${selectedTopicId}/context`)
    if (!response.ok) throw new Error(await response.text())
    applyCourseContextState(await response.json() as CourseContextState)
  }, [applyCourseContextState, selectedTopicId])

  const refreshQuestionBank = useCallback(async () => {
    if (!selectedTopicId) return null
    const response = await fetch(`/api/topics/${selectedTopicId}/question-bank`)
    if (!response.ok) throw new Error(await response.text())
    const loadedBank = await response.json() as QuestionBank
    setBank(loadedBank)
    return loadedBank
  }, [selectedTopicId])

  const applyExamGenerationState = useCallback((nextGeneration: ExamGenerationState) => {
    const previousStatus = examGenerationStatusRef.current
    examGenerationStatusRef.current = nextGeneration.status
    setExamGeneration(nextGeneration)

    if (previousStatus === 'processing' && nextGeneration.status === 'ready') {
      setExamGenerationToast(`Generated ${nextGeneration.generatedExamTitle || 'exam'}.`)
      void refreshQuestionBank()
    }
    if (previousStatus === 'processing' && nextGeneration.status === 'error') {
      setExamGenerationToast(nextGeneration.error || 'Exam generation failed.')
    }
  }, [refreshQuestionBank])

  const refreshExamGeneration = useCallback(async () => {
    if (!selectedTopicId) return
    const response = await fetch(`/api/topics/${selectedTopicId}/exam-generation`)
    if (!response.ok) throw new Error(await response.text())
    applyExamGenerationState(await response.json() as ExamGenerationState)
  }, [applyExamGenerationState, selectedTopicId])

  const importLegacyLocalStorageSessions = useCallback(async (topicId: string) => {
    if (localStorage.getItem(sqliteMigrationKey)) return
    const rawSessions = localStorage.getItem(examSessionsKey)
    if (!rawSessions) {
      localStorage.setItem(sqliteMigrationKey, JSON.stringify({ importedAt: Date.now(), imported: 0, skipped: 0 }))
      return
    }
    const sessions = JSON.parse(rawSessions) as Record<string, ExamSession>
    const activeSetId = localStorage.getItem(activeSetKey)
      ? JSON.parse(localStorage.getItem(activeSetKey) || 'null') as string | null
      : null
    const response = await fetch(`/api/topics/${topicId}/sessions/import-localstorage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessions, activeSetId }),
    })
    if (!response.ok) throw new Error(await response.text())
    const result = await response.json() as { imported: number; skipped: number; activeSetId: string | null }
    localStorage.setItem(sqliteMigrationKey, JSON.stringify({ ...result, importedAt: Date.now() }))
    if (result.activeSetId && !selectedTopicId) {
      navigate(`/topics/${encodeURIComponent(topicId)}/exams/${encodeURIComponent(result.activeSetId)}`, {
        replace: true,
      })
    }
  }, [navigate, selectedTopicId])

  const applyQuestionOverride = useCallback((loadedBank: QuestionBank, questionOverrideId: string) => {
    const override = findQuestionOverride(loadedBank, questionOverrideId)
    if (!override) {
      setError(`Question not found: ${questionOverrideId}`)
      return
    }

    setExamSessions((sessions) => {
      const existingSession = sessions[override.setId] ?? createExamSession({
        currentId: override.unitId,
        queue: [],
      })
      return {
        ...sessions,
        [override.setId]: resetExamSessionQuestionState(existingSession, {
          currentId: override.unitId,
          questionQueue: [],
        }),
      }
    })
    if (selectedTopicId) {
      navigate(`/topics/${encodeURIComponent(selectedTopicId)}/exams/${encodeURIComponent(override.setId)}`, {
        replace: true,
      })
    }
    setIsSubmittingAnswer(false)
    setCodexStatus('')
    clearStreamingTutorMessage()
    setStreamingMessageKind(null)
    setError(null)
  }, [clearStreamingTutorMessage, navigate, selectedTopicId])

  useEffect(() => {
    let isCancelled = false
    async function boot() {
      try {
        const loadedTopics = loaderData.topics
        if (isCancelled) return
        const defaultTopic = loadedTopics[0]
        if (defaultTopic && !hasRunLocalStorageMigration) {
          await importLegacyLocalStorageSessions(defaultTopic.id)
          if (!isCancelled) await refreshTopics()
          if (!isCancelled) setHasRunLocalStorageMigration(true)
        }
      } catch (bootError) {
        if (!isCancelled) setError(String(bootError))
      }
    }
    void boot()
    return () => {
      isCancelled = true
    }
  }, [hasRunLocalStorageMigration, importLegacyLocalStorageSessions, loaderData.topics, refreshTopics])

  useLayoutEffect(() => {
    setTopics(loaderData.topics)
    const topicState = loaderData.topicState
    if (!topicState) {
      setLoadedTopicId(null)
      setBank(null)
      setExamSessions({})
      setTopicSources([])
      setCourseContext(emptyCourseContextState)
      courseContextSignatureRef.current = null
      examGenerationStatusRef.current = 'idle'
      setExamGeneration(emptyExamGenerationState)
      return
    }

    setLoadedTopicId(topicState.topicId)
    setBank(topicState.bank)
    setCourseContext(topicState.context)
    courseContextSignatureRef.current = courseContextSignature(topicState.context)
    examGenerationStatusRef.current = topicState.generation.status
    setExamGeneration(topicState.generation)
    setExamSessions(topicState.sessions)
    setTopicSources(topicState.sources)

    const questionOverrideId = searchParams.get('question')
    if (questionOverrideId) applyQuestionOverride(topicState.bank, questionOverrideId)
  }, [applyQuestionOverride, loaderData, searchParams])

  useEffect(() => {
    if (courseContext.status !== 'processing') return
    const interval = window.setInterval(() => {
      refreshCourseContext().catch((contextError) => {
        setCourseContext((currentContext) => ({
          ...currentContext,
          status: 'error',
          error: String(contextError),
        }))
      })
    }, 1500)
    return () => window.clearInterval(interval)
  }, [courseContext.status, refreshCourseContext])

  useEffect(() => {
    if (examGeneration.status !== 'processing') return
    const interval = window.setInterval(() => {
      refreshExamGeneration().catch((generationError) => {
        setExamGeneration((currentGeneration) => ({
          ...currentGeneration,
          status: 'error',
          phase: 'Status refresh failed',
          error: String(generationError),
        }))
      })
    }, 1500)
    return () => window.clearInterval(interval)
  }, [examGeneration.status, refreshExamGeneration])

  useEffect(() => {
    if (!selectedTopicId || loadedTopicId !== selectedTopicId) return
    const timeout = window.setTimeout(() => {
      for (const [setId, session] of Object.entries(prepareExamSessionsForStorage(examSessions))) {
        void fetch(`/api/topics/${selectedTopicId}/sessions/${encodeURIComponent(setId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session }),
        }).catch((syncError) => setError(String(syncError)))
      }
    }, localStatePersistenceDelayMs)
    return () => window.clearTimeout(timeout)
  }, [examSessions, loadedTopicId, selectedTopicId])

  useEffect(() => {
    if (!examGenerationToast) return
    const timeout = window.setTimeout(() => setExamGenerationToast(null), 5200)
    return () => window.clearTimeout(timeout)
  }, [examGenerationToast])

  const allSets = useMemo(() => {
    const baseSets = bank?.sets ?? []
    const allQuestions = baseSets.flatMap((set) => set.questions)
    const combinedSet: QuestionSet | null =
      allQuestions.length > 0
        ? {
            id: 'all-questions',
            title: 'All Questions',
            description: 'Practice and last year exam questions mixed together.',
            sourceType: 'static',
            questions: allQuestions,
          }
        : null
    return [...baseSets, ...(combinedSet ? [combinedSet] : [])]
  }, [bank])

  const activeSet = allSets.find((set) => set.id === selectedSetId) ?? null
  const questions = useMemo(() => {
    if (!activeSet) return []
    return activeSet.questions.map((question) => shuffleQuestionOptions(question, optionOrderSeed))
  }, [activeSet, optionOrderSeed])
  const units = useMemo(() => buildQuestionUnits(questions), [questions])
  const currentUnit = units.find((unit) => unit.id === currentId) ?? null

  const last25 = useMemo(() => history.slice(0, 25), [history])
  const correctLast25 = useMemo(
    () => last25.filter((item) => item.isCorrect).length,
    [last25],
  )
  const seenQuestionCount = useMemo(() => Object.keys(progress).length, [progress])
  const canSubmitAnswer = currentUnit ? isUnitAnswered(currentUnit, answersByQuestion) : false
  const boundedCodexSidebarWidth = clamp(
    codexSidebarWidth,
    minCodexSidebarWidth,
    maxCodexSidebarWidth,
  )
  const appShellStyle = {
    '--codex-sidebar-width': `${boundedCodexSidebarWidth}px`,
  } as CSSProperties

  useEffect(() => {
    localStorage.setItem(activeTopicKey, JSON.stringify(selectedTopicId))
    localStorage.setItem(activeSetKey, JSON.stringify(selectedSetId))
  }, [selectedSetId, selectedTopicId])

  useLayoutEffect(() => {
    if (!selectedSetId || loadedTopicId !== selectedTopicId) return
    const nextSet = allSets.find((set) => set.id === selectedSetId)
    if (!nextSet) {
      if (selectedTopicId) navigate(`/topics/${encodeURIComponent(selectedTopicId)}`, { replace: true })
      return
    }

    const nextUnits = buildQuestionUnits(nextSet.questions)
    setExamSessions((sessions) => {
      const existingSession = sessions[selectedSetId]
      if (isExamSessionValid(existingSession, nextUnits)) return sessions
      return {
        ...sessions,
        [selectedSetId]: createExamSession(buildInitialQuestionDeck(nextUnits)),
      }
    })
    setIsSubmittingAnswer(false)
    setCodexStatus('')
    clearStreamingTutorMessage()
    setStreamingMessageKind(null)
    setError(null)
  }, [
    allSets,
    clearStreamingTutorMessage,
    loadedTopicId,
    navigate,
    selectedSetId,
    selectedTopicId,
    setExamSessions,
  ])

  const scrollCodexLogToBottom = useCallback(() => {
    const log = codexLogRef.current
    if (!log) return
    log.scrollTop = log.scrollHeight
  }, [])

  const followCodexStream = useCallback(() => {
    shouldFollowCodexStreamRef.current = true
    requestAnimationFrame(scrollCodexLogToBottom)
  }, [scrollCodexLogToBottom])

  const markCodexLogUserScroll = useCallback(() => {
    isUserScrollingCodexRef.current = true
    if (codexScrollIntentResetRef.current !== null) {
      window.clearTimeout(codexScrollIntentResetRef.current)
    }
    codexScrollIntentResetRef.current = window.setTimeout(() => {
      isUserScrollingCodexRef.current = false
      codexScrollIntentResetRef.current = null
    }, 200)
  }, [])

  const handleCodexLogScroll = useCallback(() => {
    const log = codexLogRef.current
    if (!log) return
    if (!isUserScrollingCodexRef.current) {
      if (isScrolledNearBottom(log)) shouldFollowCodexStreamRef.current = true
      return
    }
    shouldFollowCodexStreamRef.current = isScrolledNearBottom(log)
  }, [])

  useLayoutEffect(() => {
    if (!shouldFollowCodexStreamRef.current) return
    scrollCodexLogToBottom()
  }, [codexStatus, isGrading, messages, result, scrollCodexLogToBottom, streamingTutorMessage])

  useEffect(() => {
    if (!isResizingSidebar) return

    function handlePointerMove(event: PointerEvent) {
      const nextWidth = clamp(
        window.innerWidth - event.clientX,
        minCodexSidebarWidth,
        Math.min(maxCodexSidebarWidth, window.innerWidth - 320),
      )
      setCodexSidebarWidth(nextWidth)
    }

    function stopResizing() {
      setIsResizingSidebar(false)
    }

    document.body.classList.add('resizing-codex-sidebar')
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResizing)
    window.addEventListener('pointercancel', stopResizing)

    return () => {
      document.body.classList.remove('resizing-codex-sidebar')
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResizing)
      window.removeEventListener('pointercancel', stopResizing)
    }
  }, [isResizingSidebar, setCodexSidebarWidth])

  useEffect(() => {
    return () => {
      if (codexScrollIntentResetRef.current !== null) {
        window.clearTimeout(codexScrollIntentResetRef.current)
      }
    }
  }, [])

  const resetQuestionState = useCallback(() => {
    followCodexStream()
    setAnswersByQuestion({})
    setResult(null)
    setIsAnswerKeyRevealed(false)
    setRevealedCorrectOptionIdsByQuestion({})
    setMessages([])
    setIsSubmittingAnswer(false)
    setCodexStatus('')
    clearStreamingTutorMessage()
    setStreamingMessageKind(null)
    setTutorSessionId(crypto.randomUUID())
    setOptionOrderSeed(crypto.randomUUID())
    setUsedLearningBeforeAnswer(false)
    setError(null)
  }, [
    followCodexStream,
    clearStreamingTutorMessage,
    setAnswersByQuestion,
    setIsAnswerKeyRevealed,
    setRevealedCorrectOptionIdsByQuestion,
    setMessages,
    setOptionOrderSeed,
    setResult,
    setTutorSessionId,
    setUsedLearningBeforeAnswer,
  ])

  const showNextQuestion = useCallback((requeueCurrent = false) => {
    const next = getNextQuestionFromQueue(
      units.map((unit) => unit.id),
      currentUnit?.id ?? currentId,
      questionQueue,
      requeueCurrent,
    )
    if (!next) return

    setCurrentId(next.currentId)
    setQuestionQueue(next.queue)
    resetQuestionState()
  }, [
    currentId,
    currentUnit,
    questionQueue,
    resetQuestionState,
    setCurrentId,
    setQuestionQueue,
    units,
  ])

  const handleNextQuestionAfterResult = useCallback(() => {
    if (result) showNextQuestion(!result.isCorrect)
  }, [result, showNextQuestion])

  const handleSkipQuestion = useCallback(() => {
    showNextQuestion()
  }, [showNextQuestion])

  const toggleOption = useCallback((question: Question, optionId: string) => {
    if (result) return
    if (question.type === 'single') {
      setAnswersByQuestion((answers) => ({
        ...answers,
        [question.id]: { selectedOptionIds: [optionId] },
      }))
      return
    }
    setAnswersByQuestion((answers) => ({
      ...answers,
      [question.id]: {
        selectedOptionIds: (answers[question.id]?.selectedOptionIds ?? []).includes(optionId)
          ? (answers[question.id]?.selectedOptionIds ?? []).filter((id) => id !== optionId)
          : [...(answers[question.id]?.selectedOptionIds ?? []), optionId],
      },
    }))
  }, [result, setAnswersByQuestion])

  const updateOpenAnswer = useCallback((questionId: string, text: string) => {
    setAnswersByQuestion((answers) => ({
      ...answers,
      [questionId]: { text },
    }))
  }, [setAnswersByQuestion])

  const recordAnswer = useCallback((unit: QuestionUnit, tutorResponse: TutorResponse) => {
    const now = Date.now()
    setExamSessions((sessions) => {
      if (!selectedSetId) return sessions
      const activeSession = sessions[selectedSetId]
      if (!activeSession) return sessions

      const nextSessions = {
        ...sessions,
        [selectedSetId]: applyAnsweredUnitToSession(activeSession, unit, tutorResponse.isCorrect, now),
      }

      if (selectedSetId !== 'all-questions') return nextSessions

      for (const [sourceSetId, sourceUnit] of sourceQuestionUnitsBySet(unit)) {
        if (sourceSetId === selectedSetId) continue
        const sourceSet = allSets.find((set) => set.id === sourceSetId && set.id !== 'all-questions')
        if (!sourceSet) continue

        const sourceSession =
          nextSessions[sourceSetId] ??
          createExamSession(buildInitialQuestionDeck(buildQuestionUnits(sourceSet.questions)))

        nextSessions[sourceSetId] = applyAnsweredUnitToSession(
          sourceSession,
          sourceUnit,
          tutorResponse.isCorrect,
          now,
        )
      }

      return nextSessions
    })
  }, [allSets, selectedSetId, setExamSessions])

  const submitAnswer = useCallback(async () => {
    if (!currentUnit || isGrading) return
    if (!isUnitAnswered(currentUnit, answersByQuestion)) return

    setIsGrading(true)
    setIsSubmittingAnswer(true)
    followCodexStream()
    setCodexStatus('Asking Codex...')
    clearStreamingTutorMessage()
    setStreamingMessageKind('grading-pending')
    setError(null)
    const previousMessages = persistedTutorMessages(messages)
    try {
      const tutorQuestion = buildTutorQuestion(currentUnit)
      const tutorResponse = await postTutorStream(
        '/api/explain',
        {
          topicId: selectedTopicId,
          sessionId: tutorSessionId,
          mode: 'submit',
          question: tutorQuestion,
          answer: buildTutorAnswerPayload(currentUnit, answersByQuestion),
          messages: previousMessages,
        },
        {
          onStatus: setCodexStatus,
          onDelta: appendStreamingTutorMessage,
        },
      )
      const responseCorrectOptionIdsByQuestion = getResponseCorrectOptionIdsByQuestion(
        currentUnit,
        tutorResponse,
      )
      const nextRevealedCorrectOptionIds = buildRevealedCorrectOptionIds(
        revealedCorrectOptionIdsByQuestion,
        responseCorrectOptionIdsByQuestion,
      )
      if (nextRevealedCorrectOptionIds !== revealedCorrectOptionIdsByQuestion) {
        setRevealedCorrectOptionIdsByQuestion(nextRevealedCorrectOptionIds)
      }
      const recordedResponse = usedLearningBeforeAnswer
        ? forceLearningAttemptRetry(tutorResponse)
        : tutorResponse
      setResult(recordedResponse)
      setIsAnswerKeyRevealed(true)
      setMessages([
        ...previousMessages,
        { role: 'tutor', content: recordedResponse.explanation, kind: 'grading' },
      ])
      recordAnswer(currentUnit, recordedResponse)
    } catch (submitError) {
      setMessages(previousMessages)
      setError(String(submitError))
    } finally {
      setIsGrading(false)
      setIsSubmittingAnswer(false)
      setCodexStatus('')
      clearStreamingTutorMessage()
      setStreamingMessageKind(null)
    }
  }, [
    appendStreamingTutorMessage,
    answersByQuestion,
    clearStreamingTutorMessage,
    currentUnit,
    followCodexStream,
    isGrading,
    messages,
    recordAnswer,
    setIsAnswerKeyRevealed,
    setMessages,
    setRevealedCorrectOptionIdsByQuestion,
    setResult,
    setStreamingMessageKind,
    selectedTopicId,
    tutorSessionId,
    revealedCorrectOptionIdsByQuestion,
    usedLearningBeforeAnswer,
  ])

  const explainConceptBeforeAnswering = useCallback(async () => {
    if (!currentUnit || isGrading) return

    setIsGrading(true)
    followCodexStream()
    setCodexStatus('Teaching the concept...')
    clearStreamingTutorMessage()
    setStreamingMessageKind('learning-pending')
    setError(null)
    const learningPrompt = [
      'I do not know this yet.',
      'Teach me the underlying concept from zero like a textbook, but do not answer this question for me.',
      'Do not reveal the correct option, eliminate options, give the final formula for this exact question, or make the answer immediately inferable.',
      'Leave me with desirable difficulty so I still have to reason and submit an answer myself.',
    ].join(' ')
    const previousMessages = persistedTutorMessages(messages)
    try {
      const tutorResponse = await postTutorStream(
        '/api/explain',
        {
          topicId: selectedTopicId,
          sessionId: tutorSessionId,
          mode: 'chat',
          phase: 'pre_submit',
          request: learningPrompt,
          question: buildTutorQuestion(currentUnit),
          answer: buildTutorAnswerPayload(currentUnit, answersByQuestion),
          messages: previousMessages,
        },
        {
          onStatus: setCodexStatus,
          onDelta: appendStreamingTutorMessage,
        },
      )
      setUsedLearningBeforeAnswer(true)
      setMessages([
        ...previousMessages,
        { role: 'tutor', content: tutorResponse.explanation, kind: 'learning' },
      ])
    } catch (learnError) {
      setMessages(previousMessages)
      setError(String(learnError))
    } finally {
      setIsGrading(false)
      setCodexStatus('')
      clearStreamingTutorMessage()
      setStreamingMessageKind(null)
    }
  }, [
    appendStreamingTutorMessage,
    answersByQuestion,
    clearStreamingTutorMessage,
    currentUnit,
    followCodexStream,
    isGrading,
    messages,
    setMessages,
    setStreamingMessageKind,
    setUsedLearningBeforeAnswer,
    selectedTopicId,
    tutorSessionId,
  ])

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (
        event.key === 'Escape' &&
        event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault()
        chatComposerRef.current?.focus()
        return
      }

      if (event.key !== 'Enter' || !event.metaKey || event.shiftKey || event.isComposing) return
      if (!currentUnit || isGrading) return

      if (result) {
        event.preventDefault()
        showNextQuestion(!result.isCorrect)
        return
      }

      if (canSubmitAnswer) {
        event.preventDefault()
        submitAnswer()
      }
    }

    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [canSubmitAnswer, currentUnit, isGrading, result, showNextQuestion, submitAnswer])

  const sendChat = useCallback(async (input: string) => {
    const trimmedInput = input.trim()
    if (!currentUnit || !trimmedInput || isGrading) return
    const nextMessages: TutorMessage[] = [
      ...persistedTutorMessages(messages),
      { role: 'learner', content: trimmedInput },
    ]
    followCodexStream()
    setMessages(nextMessages)
    setIsGrading(true)
    setCodexStatus('Asking Codex...')
    clearStreamingTutorMessage()
    setStreamingMessageKind('pending')
    try {
      const tutorResponse = await postTutorStream(
        '/api/explain',
        {
          topicId: selectedTopicId,
          sessionId: tutorSessionId,
          mode: 'chat',
          phase: result ? 'post_submit' : 'pre_submit',
          question: buildTutorQuestion(currentUnit),
          answer: buildTutorAnswerPayload(currentUnit, answersByQuestion),
          messages: nextMessages,
        },
        {
          onStatus: setCodexStatus,
          onDelta: appendStreamingTutorMessage,
        },
      )
      setMessages([...nextMessages, { role: 'tutor', content: tutorResponse.explanation }])
    } catch (chatError) {
      setMessages(nextMessages)
      setError(String(chatError))
    } finally {
      setIsGrading(false)
      setCodexStatus('')
      clearStreamingTutorMessage()
      setStreamingMessageKind(null)
    }
  }, [
    answersByQuestion,
    appendStreamingTutorMessage,
    clearStreamingTutorMessage,
    currentUnit,
    followCodexStream,
    isGrading,
    messages,
    result,
    setMessages,
    setStreamingMessageKind,
    selectedTopicId,
    tutorSessionId,
  ])

  const uploadTopicSourceFiles = useCallback(async (files: FileList | SourceUploadInput[], sourceKind: SourceUploadKind = 'auto') => {
    if (!selectedTopicId) return
    const selectedFiles = Array.from(files)
    if (selectedFiles.length === 0) return
    const formData = new FormData()
    formData.append('kind', sourceKind)
    for (const item of selectedFiles) {
      const hasExplicitPath = isSourceUploadEntry(item)
      const file = hasExplicitPath ? item.file : item
      const relativePath = hasExplicitPath
        ? item.relativePath
        : (item as File & { webkitRelativePath?: string }).webkitRelativePath
      formData.append('files', file, relativePath || file.name)
    }

    try {
      const response = await fetch(`/api/topics/${selectedTopicId}/sources/files`, {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) throw new Error(await response.text())
      const payload = await response.json() as { sources: TopicSource[]; context: CourseContextState }
      setTopicSources(payload.sources)
      applyCourseContextState(payload.context)
      await refreshTopics()
    } catch (uploadError) {
      setCourseContext({
        ...emptyCourseContextState,
        status: 'error',
        error: String(uploadError),
      })
    }
  }, [applyCourseContextState, refreshTopics, selectedTopicId])

  const startExamGeneration = useCallback(async () => {
    if (!selectedTopicId) return
    try {
      setIsExamGenerationModalOpen(true)
      const response = await fetch(`/api/topics/${selectedTopicId}/exam-generation`, { method: 'POST' })
      if (!response.ok) throw new Error(await response.text())
      applyExamGenerationState(await response.json() as ExamGenerationState)
    } catch (uploadError) {
      applyExamGenerationState({
        ...emptyExamGenerationState,
        status: 'error',
        phase: 'Upload failed',
        error: String(uploadError),
        log: [{
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          kind: 'error',
          message: String(uploadError),
        }],
      })
      setIsExamGenerationModalOpen(true)
    }
  }, [applyExamGenerationState, selectedTopicId])

  const clearCourseContext = useCallback(async () => {
    if (!selectedTopicId) return
    const response = await fetch(`/api/topics/${selectedTopicId}/context`, { method: 'DELETE' })
    if (!response.ok) throw new Error(await response.text())
    applyCourseContextState(await response.json() as CourseContextState)
    setIsContextModalOpen(false)
  }, [applyCourseContextState, selectedTopicId])

  const restartCourseContext = useCallback(async () => {
    if (!selectedTopicId) return
    setIsContextModalOpen(true)
    const response = await fetch(`/api/topics/${selectedTopicId}/context/generate`, { method: 'POST' })
    if (!response.ok) throw new Error(await response.text())
    applyCourseContextState(await response.json() as CourseContextState)
  }, [applyCourseContextState, selectedTopicId])

  const stopCourseContext = useCallback(async () => {
    if (!selectedTopicId) return
    const response = await fetch(`/api/topics/${selectedTopicId}/context/stop`, { method: 'POST' })
    if (!response.ok) throw new Error(await response.text())
    applyCourseContextState(await response.json() as CourseContextState)
  }, [applyCourseContextState, selectedTopicId])

  const clearExamGeneration = useCallback(async () => {
    if (!selectedTopicId) return
    const response = await fetch(`/api/topics/${selectedTopicId}/exam-generation`, { method: 'DELETE' })
    if (!response.ok) throw new Error(await response.text())
    applyExamGenerationState(await response.json() as ExamGenerationState)
    setIsExamGenerationModalOpen(false)
  }, [applyExamGenerationState, selectedTopicId])

  const createTopic = useCallback(async (name: string, emoji: string) => {
    const response = await fetch('/api/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, emoji }),
    })
    if (!response.ok) throw new Error(await response.text())
    const topic = await response.json() as Topic
    await refreshTopics()
    navigate(`/topics/${encodeURIComponent(topic.id)}`)
    setError(null)
  }, [navigate, refreshTopics])

  const deleteTopicSourceById = useCallback(async (sourceId: string) => {
    if (!selectedTopicId) return
    const response = await fetch(`/api/topics/${selectedTopicId}/sources/${sourceId}`, { method: 'DELETE' })
    if (!response.ok) throw new Error(await response.text())
    const payload = await response.json() as { sources: TopicSource[]; context: CourseContextState }
    setTopicSources(payload.sources)
    applyCourseContextState(payload.context)
    await refreshTopics()
  }, [applyCourseContextState, refreshTopics, selectedTopicId])

  const deleteGeneratedExamById = useCallback(async (setId: string) => {
    if (!selectedTopicId) return
    const response = await fetch(
      `/api/topics/${encodeURIComponent(selectedTopicId)}/question-sets/${encodeURIComponent(setId)}`,
      { method: 'DELETE' },
    )
    if (!response.ok) throw new Error(await response.text())
    const payload = await response.json() as {
      bank: QuestionBank
      generation: ExamGenerationState
    }
    setBank(payload.bank)
    applyExamGenerationState(payload.generation)
    setExamSessions((sessions) => {
      const remainingSessions = { ...sessions }
      delete remainingSessions[setId]
      return remainingSessions
    })
    await refreshTopics()
  }, [applyExamGenerationState, refreshTopics, selectedTopicId])

  if (!selectedTopicId) {
    return (
      <main className="app-shell">
        <TopicMenu
          topics={topics}
          onCreateTopic={createTopic}
          error={error}
        />
      </main>
    )
  }

  if (!bank || loadedTopicId !== selectedTopicId || !activeTopic) {
    return (
      <main className="app-shell centered">
        <div className="loading-panel">Loading topic...</div>
      </main>
    )
  }

  if (!activeSet || !currentUnit) {
    return (
      <main className="app-shell">
        <ExamMenu
          topic={activeTopic}
          sets={allSets}
          examSessions={examSessions}
          examGeneration={examGeneration}
          sources={topicSources}
          context={courseContext}
          onDeleteSource={deleteTopicSourceById}
          onDeleteExam={deleteGeneratedExamById}
          onGenerateExam={startExamGeneration}
          onUploadSourceFiles={uploadTopicSourceFiles}
          onOpenContextModal={() => setIsContextModalOpen(true)}
          onOpenExamGenerationModal={() => setIsExamGenerationModalOpen(true)}
          error={error}
        />
        {isContextModalOpen && (
          <ContextModal
            context={courseContext}
            onClear={() => void clearCourseContext()}
            onClose={() => setIsContextModalOpen(false)}
            onRestart={() => void restartCourseContext()}
            onStop={() => void stopCourseContext()}
          />
        )}
        {isExamGenerationModalOpen && (
          <ExamGenerationModal
            generation={examGeneration}
            onClear={() => void clearExamGeneration()}
            onClose={() => setIsExamGenerationModalOpen(false)}
          />
        )}
        {examGenerationToast && (
          <Toast message={examGenerationToast} onClose={() => setExamGenerationToast(null)} />
        )}
      </main>
    )
  }

  return (
    <main
      className={`app-shell ${isResizingSidebar ? 'resizing-sidebar' : ''}`}
      style={appShellStyle}
    >
      <TrainerPanel
        title={activeSet.title}
        currentUnit={currentUnit}
        answersByQuestion={answersByQuestion}
        canSubmitAnswer={canSubmitAnswer}
        correctLast25={correctLast25}
        error={error}
        isAnswerKeyRevealed={isAnswerKeyRevealed}
        isGrading={isGrading}
        isSubmittingAnswer={isSubmittingAnswer}
        last25={last25}
        onExplainConcept={explainConceptBeforeAnswering}
        onNextAfterResult={handleNextQuestionAfterResult}
        onOpenAnswerChange={updateOpenAnswer}
        menuHref={`/topics/${encodeURIComponent(activeTopic.id)}`}
        onSkipQuestion={handleSkipQuestion}
        onSubmitAnswer={submitAnswer}
        onToggleOption={toggleOption}
        result={result}
        revealedCorrectOptionIdsByQuestion={revealedCorrectOptionIdsByQuestion}
        seenQuestionCount={seenQuestionCount}
      />

      <div
        className="sidebar-resizer"
        role="separator"
        aria-label="Resize Codex sidebar. Double click to reset width."
        aria-orientation="vertical"
        aria-valuemin={minCodexSidebarWidth}
        aria-valuemax={maxCodexSidebarWidth}
        aria-valuenow={boundedCodexSidebarWidth}
        tabIndex={0}
        title="Drag to resize. Double click to reset."
        onDoubleClick={(event) => {
          event.preventDefault()
          setIsResizingSidebar(false)
          setCodexSidebarWidth(defaultCodexSidebarWidth)
        }}
        onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
          if (event.button !== 0) return
          if (event.detail > 1) return
          event.preventDefault()
          setIsResizingSidebar(true)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Home' || event.key === 'Escape') {
            event.preventDefault()
            setCodexSidebarWidth(defaultCodexSidebarWidth)
            return
          }
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          const direction = event.key === 'ArrowLeft' ? 1 : -1
          const step = event.shiftKey ? 48 : 16
          setCodexSidebarWidth((width) =>
            clamp(width + direction * step, minCodexSidebarWidth, maxCodexSidebarWidth),
          )
        }}
      />

      <CodexPanel
        ref={chatComposerRef}
        codexLogRef={codexLogRef}
        codexStatus={codexStatus}
        courseContext={courseContext}
        isGrading={isGrading}
        isContextModalOpen={isContextModalOpen}
        messages={messages}
        onClearContext={clearCourseContext}
        onCodexLogScroll={handleCodexLogScroll}
        onCloseContextModal={() => setIsContextModalOpen(false)}
        onMarkCodexLogUserScroll={markCodexLogUserScroll}
        onOpenContextModal={() => setIsContextModalOpen(true)}
        onRestartContext={restartCourseContext}
        onSendChat={sendChat}
        onStopContext={stopCourseContext}
        result={result}
        resetKey={tutorSessionId}
        streamingMessageKind={streamingMessageKind}
        streamingTutorMessage={streamingTutorMessage}
      />
      {isExamGenerationModalOpen && (
        <ExamGenerationModal
          generation={examGeneration}
          onClear={() => void clearExamGeneration()}
          onClose={() => setIsExamGenerationModalOpen(false)}
        />
      )}
      {examGenerationToast && (
        <Toast message={examGenerationToast} onClose={() => setExamGenerationToast(null)} />
      )}
    </main>
  )
}

const TrainerPanel = memo(function TrainerPanel({
  title,
  currentUnit,
  answersByQuestion,
  canSubmitAnswer,
  correctLast25,
  error,
  isAnswerKeyRevealed,
  isGrading,
  isSubmittingAnswer,
  last25,
  onExplainConcept,
  onNextAfterResult,
  onOpenAnswerChange,
  menuHref,
  onSkipQuestion,
  onSubmitAnswer,
  onToggleOption,
  result,
  revealedCorrectOptionIdsByQuestion,
  seenQuestionCount,
}: {
  title: string
  currentUnit: QuestionUnit
  answersByQuestion: Record<string, AnswerPayload>
  canSubmitAnswer: boolean
  correctLast25: number
  error: string | null
  isAnswerKeyRevealed: boolean
  isGrading: boolean
  isSubmittingAnswer: boolean
  last25: HistoryItem[]
  onExplainConcept: () => void
  onNextAfterResult: () => void
  onOpenAnswerChange: (questionId: string, text: string) => void
  menuHref: string
  onSkipQuestion: () => void
  onSubmitAnswer: () => void
  onToggleOption: (question: Question, optionId: string) => void
  result: TutorResponse | null
  revealedCorrectOptionIdsByQuestion: Record<string, string[]>
  seenQuestionCount: number
}) {
  return (
    <section className="trainer-panel">
      <header className="study-header">
        <div className="study-title">
          <Link className="ghost-button" to={menuHref}>
            Menu
          </Link>
          <div>
            <h1>{title}</h1>
          </div>
        </div>
        <div className="study-metrics">
          <Stat label="Last 25" value={`${correctLast25}/${Math.max(25, last25.length || 25)}`} />
          <Stat label="Seen" value={String(seenQuestionCount)} />
        </div>
        <div className="history-strip" aria-label="Last 25 answers">
          {Array.from({ length: 25 }).map((_, index) => {
            const item = last25[index]
            return (
              <span
                key={index}
                className={`history-dot ${item ? (item.isCorrect ? 'correct' : 'wrong') : ''}`}
                title={item?.title ?? 'No answer yet'}
              />
            )
          })}
        </div>
      </header>

      <div className="question-scroll">
        <article className="question-card">
          {currentUnit.sharedPrompt && (
            <div className="shared-question-context">
              <MarkdownBlock className="question-prose">{currentUnit.sharedPrompt}</MarkdownBlock>
            </div>
          )}
          <div className={currentUnit.questions.length > 1 ? 'question-group' : undefined}>
            {currentUnit.questions.map((question) => (
              <QuestionPrompt
                key={question.id}
                question={question}
                answer={answersByQuestion[question.id] ?? {}}
                disabled={Boolean(result) || isAnswerKeyRevealed}
                showAnswerKey={Boolean(result) || isAnswerKeyRevealed}
                openAnswerState={getOpenAnswerState(currentUnit, question, result)}
                revealedCorrectOptionIds={revealedCorrectOptionIdsByQuestion[question.id] ?? []}
                showHeading={currentUnit.questions.length > 1}
                sharedPrompt={currentUnit.sharedPrompt ?? ''}
                onToggleOption={onToggleOption}
                onOpenAnswerChange={onOpenAnswerChange}
              />
            ))}
          </div>
        </article>
      </div>

      {!isSubmittingAnswer && (
        <div className="action-row">
          {result ? (
            <button
              className="primary-button"
              type="button"
              onClick={onNextAfterResult}
              disabled={isGrading}
              aria-keyshortcuts="Meta+Enter"
              title="Command+Enter"
            >
              Next question
            </button>
          ) : (
            <>
              <button
                className="primary-button"
                type="button"
                onClick={onSubmitAnswer}
                disabled={!canSubmitAnswer || isGrading}
                aria-keyshortcuts="Meta+Enter"
                title="Command+Enter"
              >
                Submit answer
              </button>
              <div className="secondary-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={onExplainConcept}
                  disabled={isGrading}
                >
                  I don&apos;t know
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={onSkipQuestion}
                  disabled={isGrading}
                >
                  Skip / next
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {error && <div className="error-box">{error}</div>}
    </section>
  )
})

const CodexPanel = memo(forwardRef<ChatComposerHandle, {
  codexLogRef: RefObject<HTMLDivElement | null>
  codexStatus: string
  courseContext: CourseContextState
  isGrading: boolean
  isContextModalOpen: boolean
  messages: TutorMessage[]
  onClearContext: () => void | Promise<void>
  onCodexLogScroll: () => void
  onCloseContextModal: () => void
  onMarkCodexLogUserScroll: () => void
  onOpenContextModal: () => void
  onRestartContext: () => void | Promise<void>
  onSendChat: (input: string) => void | Promise<void>
  onStopContext: () => void | Promise<void>
  resetKey: string
  result: TutorResponse | null
  streamingMessageKind: TutorMessage['kind'] | null
  streamingTutorMessage: string
}>(function CodexPanel({
  codexLogRef,
  codexStatus,
  courseContext,
  isGrading,
  isContextModalOpen,
  messages,
  onClearContext,
  onCodexLogScroll,
  onCloseContextModal,
  onMarkCodexLogUserScroll,
  onOpenContextModal,
  onRestartContext,
  onSendChat,
  onStopContext,
  resetKey,
  result,
  streamingMessageKind,
  streamingTutorMessage,
}, ref) {
  const [markdownCopy, setMarkdownCopy] = useState<MarkdownCopyPopup | null>(null)
  const pendingMessage: TutorMessage | null = isGrading
    ? {
        role: 'tutor',
        content: streamingTutorMessage,
        kind: streamingMessageKind ?? 'pending',
      }
    : null
  const hideMarkdownCopy = useCallback(() => {
    setMarkdownCopy(null)
  }, [])

  useEffect(() => {
    const handleSelectionChange = () => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) {
        hideMarkdownCopy()
      }
    }

    document.addEventListener('selectionchange', handleSelectionChange)
    return () => document.removeEventListener('selectionchange', handleSelectionChange)
  }, [hideMarkdownCopy])

  const updateMarkdownCopyPopup = useCallback(() => {
    const selection = window.getSelection()
    const log = codexLogRef.current
    if (!selection || selection.isCollapsed || !log || selection.rangeCount === 0) {
      hideMarkdownCopy()
      return
    }

    const range = selection.getRangeAt(0)
    const messageElement = selectedTutorMessageElement(selection, log)
    if (!messageElement) {
      hideMarkdownCopy()
      return
    }

    const rawMarkdown = messageElement.dataset.markdownSource ?? ''
    const markdown = selectedMarkdownFromRange(range, rawMarkdown)
    if (!markdown.trim()) {
      hideMarkdownCopy()
      return
    }

    const rect = range.getBoundingClientRect()
    setMarkdownCopy({
      markdown,
      status: 'idle',
      x: clamp(rect.left + rect.width / 2, 74, window.innerWidth - 74),
      y: Math.max(12, rect.top - 44),
    })
  }, [codexLogRef, hideMarkdownCopy])

  const copySelectedMarkdown = useCallback(async () => {
    if (!markdownCopy) return
    try {
      await writeClipboardText(markdownCopy.markdown)
      setMarkdownCopy((current) => current ? { ...current, status: 'copied' } : current)
      window.setTimeout(() => {
        setMarkdownCopy((current) => current?.status === 'copied' ? null : current)
      }, 900)
    } catch {
      setMarkdownCopy((current) => current ? { ...current, status: 'failed' } : current)
    }
  }, [markdownCopy])

  return (
    <aside className="codex-panel">
      <div className="codex-header">
        <div>
          <p className="eyebrow">Codex</p>
        </div>
        <div className="context-controls">
          <button
            className={`context-button context-${courseContext.status}`}
            type="button"
            disabled={courseContext.status === 'processing'}
            onClick={() => {
              onOpenContextModal()
            }}
          >
            {courseContext.status === 'processing' && <span className="context-spinner" aria-hidden="true" />}
            {contextButtonLabel(courseContext)}
          </button>
          {courseContext.status === 'error' && (
            <button
              className="context-clear-button"
              type="button"
              title="Clear context error"
              aria-label="Clear context error"
              onClick={() => void onClearContext()}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div
        className="codex-log"
        ref={codexLogRef}
        onPointerDown={onMarkCodexLogUserScroll}
        onMouseUp={updateMarkdownCopyPopup}
        onScroll={onCodexLogScroll}
        onKeyUp={updateMarkdownCopyPopup}
        onTouchMove={onMarkCodexLogUserScroll}
        onTouchEnd={updateMarkdownCopyPopup}
        onWheel={onMarkCodexLogUserScroll}
      >
        {messages.map((message, index) => (
          <ChatMessage
            key={`${message.role}:${index}`}
            message={message}
            fallbackStatus={codexStatus || 'Asking Codex...'}
            gradeResult={message.kind === 'grading' ? result : null}
          />
        ))}
        {pendingMessage ? (
          <ChatMessage
            message={pendingMessage}
            fallbackStatus={codexStatus || 'Asking Codex...'}
            gradeResult={null}
          />
        ) : messages.length === 0 ? (
          <div className="empty-chat">{codexStatus || 'Ask Codex about this question.'}</div>
        ) : null}
      </div>

      {markdownCopy && (
        <button
          className={`markdown-copy-popup markdown-copy-${markdownCopy.status}`}
          type="button"
          style={{ left: markdownCopy.x, top: markdownCopy.y }}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => void copySelectedMarkdown()}
        >
          {markdownCopy.status === 'copied'
            ? 'Copied'
            : markdownCopy.status === 'failed'
              ? 'Copy failed'
              : 'Copy Markdown'}
        </button>
      )}

      <ChatComposer
        key={resetKey}
        ref={ref}
        disabled={isGrading}
        onSend={onSendChat}
      />

      {isContextModalOpen && (
        <ContextModal
          context={courseContext}
          onClear={() => void onClearContext()}
          onClose={onCloseContextModal}
          onRestart={() => void onRestartContext()}
          onStop={() => void onStopContext()}
        />
      )}
    </aside>
  )
}))

const ContextModal = memo(function ContextModal({
  context,
  onClear,
  onClose,
  onRestart,
  onStop,
}: {
  context: CourseContextState
  onClear: () => void
  onClose: () => void
  onRestart: () => void
  onStop: () => void
}) {
  const isProcessing = context.status === 'processing'
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="context-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="context-modal-title"
      >
        <header className="context-modal-header">
          <div>
            <p className="eyebrow">Persistent Context</p>
            <h2 id="context-modal-title">{contextModalTitle(context)}</h2>
          </div>
          <button className="ghost-button" type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="context-modal-meta">
          <span>Status: {context.status}</span>
          {context.startedAt && <span>Started {formatDateTime(context.startedAt)}</span>}
          {context.completedAt && <span>Finished {formatDateTime(context.completedAt)}</span>}
          {context.generatedAt && <span>Generated {formatDateTime(context.generatedAt)}</span>}
          {context.threadId && <span>Thread {context.threadId}</span>}
          {context.error && <span>{context.error}</span>}
        </div>

        <ul className="context-file-list">
          {context.files.map((file, index) => (
            <li key={`${file.name}:${index}`}>
              <span>{file.name}</span>
              <small>{formatBytes(file.size)}</small>
            </li>
          ))}
        </ul>

        {context.error && <div className="error-box">{context.error}</div>}

        <div className="exam-generation-feed context-generation-feed">
          {context.log.length > 0 ? (
            compactExamGenerationLog(context.log).map((entry) => (
              <div key={entry.id} className={`exam-generation-event event-${entry.kind}`}>
                <div className="exam-generation-event-label">
                  {examGenerationEventLabel(entry)}
                  <span>{formatEventTime(entry.at)}</span>
                </div>
                <div className="exam-generation-event-body">
                  {entry.kind === 'assistant' ? (
                    <MarkdownBlock mode="chat">{entry.message}</MarkdownBlock>
                  ) : (
                    <>
                      <strong>{entry.message}</strong>
                      {entry.detail && <small>{entry.detail}</small>}
                    </>
                  )}
                </div>
              </div>
            ))
          ) : (
            <div className="empty-chat">No context generation activity yet.</div>
          )}
        </div>

        <pre className="context-prompt-preview">{context.injectedPrompt || 'No injected prompt is stored.'}</pre>

        <footer className="context-modal-actions">
          {isProcessing ? (
            <button className="danger-button" type="button" onClick={onStop}>
              Stop generation
            </button>
          ) : (
            <button className="secondary-button" type="button" onClick={onRestart}>
              {context.status === 'idle' ? 'Generate context' : 'Restart generation'}
            </button>
          )}
          <button className="secondary-button" type="button" onClick={onClear}>
            Clear context
          </button>
        </footer>
      </section>
    </div>
  )
})

function contextButtonLabel(context: CourseContextState) {
  if (context.status === 'processing') return 'Generating'
  if (context.status === 'ready') {
    return `${context.fileCount} file${context.fileCount === 1 ? '' : 's'} loaded`
  }
  if (context.status === 'error') return 'Context error'
  return 'Context'
}

function contextModalTitle(context: CourseContextState) {
  if (context.status === 'processing') return 'Generating context'
  if (context.status === 'error') return 'Context generation failed'
  if (context.status === 'ready') return `${context.fileCount} file${context.fileCount === 1 ? '' : 's'} loaded`
  return 'Course context'
}

function courseContextSignature(context: CourseContextState) {
  return [
    context.status,
    context.fileCount,
    context.generatedAt ?? '',
    context.injectedPrompt.length,
  ].join(':')
}

function formatDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size >= 10 || unitIndex === 0 ? Math.round(size) : size.toFixed(1)} ${units[unitIndex]}`
}

function isSourceUploadEntry(item: SourceUploadInput): item is { file: File; relativePath?: string } {
  return typeof item === 'object' && item !== null && 'file' in item
}

function isAbortError(error: unknown) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'name' in error &&
    error.name === 'AbortError'
  )
}

async function collectAssignmentFolderFiles(
  directory: SourceFileSystemDirectoryHandle,
  pathPrefix = directory.name,
): Promise<SourceUploadInput[]> {
  const files: SourceUploadInput[] = []
  for await (const entry of directory.values()) {
    const relativePath = `${pathPrefix}/${entry.name}`
    if (entry.kind === 'directory') {
      if (!shouldSkipAssignmentFolderPath(relativePath, true)) {
        files.push(...await collectAssignmentFolderFiles(entry, relativePath))
      }
      continue
    }

    if (shouldSkipAssignmentFolderPath(relativePath, false)) continue
    files.push({
      file: await entry.getFile(),
      relativePath,
    })
  }
  return files
}

function filterAssignmentFolderFileList(files: FileList): SourceUploadInput[] {
  return Array.from(files)
    .map((file) => ({
      file,
      relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    }))
    .filter(({ relativePath }) => !shouldSkipAssignmentFolderPath(relativePath, false))
}

function shouldSkipAssignmentFolderPath(relativePath: string, isDirectory: boolean) {
  const segments = relativePath
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
  const lowerSegments = segments.map((segment) => segment.toLowerCase())
  if (lowerSegments.some((segment) => ignoredAssignmentFolderSegments.has(segment))) return true
  if (isDirectory) return false

  const fileName = lowerSegments.at(-1) ?? ''
  if (ignoredAssignmentFolderFiles.has(fileName)) return true
  const extension = fileName.includes('.') ? `.${fileName.split('.').pop()}` : ''
  return !assignmentFolderExtensions.has(extension)
}

function selectedTutorMessageElement(selection: Selection, root: HTMLElement) {
  const anchorElement = nodeElement(selection.anchorNode)
  const focusElement = nodeElement(selection.focusNode)
  const anchorMessage = anchorElement?.closest<HTMLElement>('.chat-message.tutor')
  const focusMessage = focusElement?.closest<HTMLElement>('.chat-message.tutor')
  if (!anchorMessage || anchorMessage !== focusMessage || !root.contains(anchorMessage)) return null
  return anchorMessage
}

function nodeElement(node: Node | null) {
  if (!node) return null
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
}

function selectedMarkdownFromRange(range: Range, rawMarkdown: string) {
  const markdown = serializeSelectionFragment(range.cloneContents())
  if (markdown.trim()) return trimMarkdownSelection(markdown)
  if (!rawMarkdown) return compactSelectedText(window.getSelection()?.toString() ?? '')
  return trimMarkdownSelection(rawMarkdown)
}

function serializeSelectionFragment(fragment: DocumentFragment) {
  return Array.from(fragment.childNodes)
    .map((node) => serializeMarkdownNode(node))
    .join('')
}

function serializeMarkdownNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return normalizeMarkdownText(node.textContent ?? '')
  if (!(node instanceof HTMLElement)) return Array.from(node.childNodes).map(serializeMarkdownNode).join('')

  const tagName = node.tagName.toLowerCase()
  const children = () => Array.from(node.childNodes).map(serializeMarkdownNode).join('')
  const inline = () => compactInlineMarkdown(children())
  const block = () => `${inline()}\n\n`

  if (node.classList.contains('katex')) return serializeKatexNode(node)
  if (node.getAttribute('aria-hidden') === 'true' && node.closest('.katex')) return ''

  switch (tagName) {
    case 'br':
      return '\n'
    case 'p':
      return block()
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return `${'#'.repeat(Number(tagName.slice(1)))} ${inline()}\n\n`
    case 'strong':
    case 'b':
      return inline() ? `**${inline()}**` : ''
    case 'em':
    case 'i':
      return inline() ? `*${inline()}*` : ''
    case 'code':
      return node.closest('pre') ? node.textContent ?? '' : `\`${node.textContent ?? ''}\``
    case 'pre':
      return `\`\`\`\n${node.textContent?.replace(/\n$/, '') ?? ''}\n\`\`\`\n\n`
    case 'ul':
      return `${serializeListItems(node, '-')}\n`
    case 'ol':
      return `${serializeListItems(node, '1.')}\n`
    case 'li':
      return `- ${inline()}\n`
    case 'blockquote':
      return children()
        .trim()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n') + '\n\n'
    case 'table':
      return `${node.textContent ?? ''}\n\n`
    default:
      return children()
  }
}

function serializeListItems(list: HTMLElement, marker: '-' | '1.') {
  return Array.from(list.children)
    .filter((child): child is HTMLElement => child instanceof HTMLElement && child.tagName.toLowerCase() === 'li')
    .map((item, index) => {
      const bullet = marker === '-' ? '-' : `${index + 1}.`
      return `${bullet} ${compactInlineMarkdown(serializeSelectionFragmentLike(item))}`
    })
    .join('\n')
}

function serializeSelectionFragmentLike(element: HTMLElement) {
  return Array.from(element.childNodes).map(serializeMarkdownNode).join('')
}

function serializeKatexNode(element: HTMLElement) {
  const tex = element.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim()
  if (!tex) return ''
  return element.classList.contains('katex-display') ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`
}

function normalizeMarkdownText(text: string) {
  return text.replace(/\s+/g, ' ')
}

function compactInlineMarkdown(markdown: string) {
  return markdown
    .replace(/[ \t]*\n[ \t]*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function trimMarkdownSelection(markdown: string) {
  return markdown
    .replace(/\n[ \t]*\n[ \t]*(?=(?:[-*+]|\d+\.)\s)/g, '\n')
    .replace(/^\s*\n+/, '')
    .replace(/\n+\s*$/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function compactSelectedText(text: string) {
  return text.replace(/[ \t]*\n[ \t]*/g, ' ').trim()
}

async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.append(textarea)
  textarea.select()
  try {
    document.execCommand('copy')
  } finally {
    textarea.remove()
  }
}

const ChatMessage = memo(function ChatMessage({
  message,
  fallbackStatus,
  gradeResult,
}: {
  message: TutorMessage
  fallbackStatus: string
  gradeResult: TutorResponse | null
}) {
  const hasSeparator =
    message.kind === 'grading' ||
    message.kind === 'grading-pending' ||
    message.kind === 'learning' ||
    message.kind === 'learning-pending'

  return (
    <div
      className={`chat-message ${message.role} ${message.kind ? `message-${message.kind}` : ''}`}
      data-markdown-source={message.role === 'tutor' ? normalizeChatMarkdown(message.content) : undefined}
    >
      {hasSeparator && (
        <div className="graded-result-separator">
          {message.kind === 'learning' || message.kind === 'learning-pending'
            ? 'Learn from zero'
            : 'Graded result'}
        </div>
      )}
      {message.content ? (
        <MarkdownBlock mode="chat">{message.content}</MarkdownBlock>
      ) : (
        fallbackStatus
      )}
      {gradeResult && <GradeWidget result={gradeResult} />}
    </div>
  )
})

const GradeWidget = memo(function GradeWidget({ result }: { result: TutorResponse }) {
  return (
    <div className={`grade-widget ${result.isCorrect ? 'correct' : 'wrong'}`}>
      <div className="grade-widget-score">{Math.round(result.score * 100)}%</div>
      {result.verdict && <div className="grade-widget-verdict">{result.verdict}</div>}
    </div>
  )
})

const ChatComposer = memo(forwardRef<ChatComposerHandle, {
  disabled: boolean
  onSend: (input: string) => void | Promise<void>
}>(function ChatComposer({ disabled, onSend }, ref) {
  const [chatInput, setChatInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useImperativeHandle(ref, () => ({
    focus() {
      textareaRef.current?.focus()
    },
  }), [])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    autoGrowTextarea(textarea)
  }, [chatInput])

  const submit = useCallback(() => {
    const trimmedInput = chatInput.trim()
    if (!trimmedInput || disabled) return
    setChatInput('')
    void onSend(trimmedInput)
  }, [chatInput, disabled, onSend])

  return (
    <div className="codex-compose">
      <form
        className="chat-row"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <textarea
          ref={textareaRef}
          value={chatInput}
          onChange={(event) => setChatInput(event.target.value)}
          placeholder="Ask Codex about this question..."
          disabled={disabled}
          rows={1}
          onKeyDown={(event) => {
            if (
              event.key !== 'Enter' ||
              event.shiftKey ||
              event.metaKey ||
              event.ctrlKey ||
              event.altKey ||
              event.nativeEvent.isComposing
            ) {
              return
            }
            event.preventDefault()
            submit()
          }}
        />
      </form>
    </div>
  )
}))

const QuestionPrompt = memo(function QuestionPrompt({
  question,
  answer,
  disabled,
  showAnswerKey,
  openAnswerState,
  revealedCorrectOptionIds,
  showHeading,
  sharedPrompt,
  onToggleOption,
  onOpenAnswerChange,
}: {
  question: Question
  answer: AnswerPayload
  disabled: boolean
  showAnswerKey: boolean
  openAnswerState: 'correct' | 'partial' | 'incorrect' | null
  revealedCorrectOptionIds: string[]
  showHeading: boolean
  sharedPrompt: string
  onToggleOption: (question: Question, optionId: string) => void
  onOpenAnswerChange: (questionId: string, text: string) => void
}) {
  const openAnswerTextareaRef = useRef<HTMLTextAreaElement>(null)
  const selectedOptionIds = answer.selectedOptionIds ?? []
  const correctOptionIds = revealedCorrectOptionIds.length > 0
    ? revealedCorrectOptionIds
    : getCorrectOptionIds(question)
  const hasKnownCorrectOptionIds = correctOptionIds.length > 0
  const displayPrompt = useMemo(
    () => removeSharedImageTags(question.prompt, sharedPrompt),
    [question.prompt, sharedPrompt],
  )

  useLayoutEffect(() => {
    const textarea = openAnswerTextareaRef.current
    if (!textarea) return

    if (question.type !== 'open') {
      textarea.style.height = ''
      return
    }

    autoGrowTextarea(textarea)
  }, [answer.text, question.type, showAnswerKey])

  return (
    <section className="subquestion">
      {showHeading && (
        <div className="subquestion-heading">
          <span>{question.number}</span>
          {question.points ? <small>{question.points}p</small> : null}
        </div>
      )}
      <MarkdownBlock className="question-prose">{displayPrompt}</MarkdownBlock>
      {question.type === 'open' ? (
        <textarea
          ref={openAnswerTextareaRef}
          className={openAnswerTextareaClassName(openAnswerState, showAnswerKey)}
          value={answer.text ?? ''}
          onChange={(event) => onOpenAnswerChange(question.id, event.target.value)}
          placeholder="Write a short exam-style answer..."
          disabled={disabled}
        />
      ) : (
        <div className="options-grid">
          {question.options.map((option) => {
            const isSelected = selectedOptionIds.includes(option.id)
            const isCorrect = showAnswerKey && hasKnownCorrectOptionIds && correctOptionIds.includes(option.id)
            const isSelectedCorrect = isSelected && isCorrect
            const isSelectedIncorrect = showAnswerKey && hasKnownCorrectOptionIds && isSelected && !isCorrect
            const isModelOnlyCorrect = isCorrect && !isSelected
            return (
              <label
                key={option.id}
                className={optionButtonClassName(
                  isSelected,
                  isSelectedCorrect,
                  isSelectedIncorrect,
                  isModelOnlyCorrect,
                )}
              >
                  <input
                    type={question.type === 'single' ? 'radio' : 'checkbox'}
                    name={question.id}
                    checked={isSelected}
                    onChange={() => onToggleOption(question, option.id)}
                    disabled={disabled}
                  />
                <MarkdownBlock className="option-prose">{option.text}</MarkdownBlock>
              </label>
            )
          })}
        </div>
      )}
    </section>
  )
})

function optionButtonClassName(
  isSelected: boolean,
  isSelectedCorrect: boolean,
  isSelectedIncorrect: boolean,
  isModelOnlyCorrect: boolean,
) {
  return [
    'option-button',
    isSelected ? 'selected' : '',
    isSelectedCorrect ? 'correct-answer' : '',
    isSelectedIncorrect ? 'incorrect-answer' : '',
    isModelOnlyCorrect ? 'model-answer' : '',
  ].filter(Boolean).join(' ')
}

function openAnswerTextareaClassName(
  state: 'correct' | 'partial' | 'incorrect' | null,
  showAnswerKey: boolean,
) {
  return [
    'answer-textarea',
    showAnswerKey ? 'answer-key-visible' : '',
    state === 'correct' ? 'correct-answer' : '',
    state === 'partial' ? 'partial-answer' : '',
    state === 'incorrect' ? 'incorrect-answer' : '',
  ].filter(Boolean).join(' ')
}

function getOpenAnswerState(
  unit: QuestionUnit,
  question: Question,
  result: TutorResponse | null,
): 'correct' | 'partial' | 'incorrect' | null {
  if (!result || question.type !== 'open') return null

  const questionScore = result.questionScores?.[question.id]
  if (typeof questionScore === 'number') {
    if (result.questionCorrectness?.[question.id] === true || questionScore >= 0.8) return 'correct'
    if (questionScore > 0) return 'partial'
    return 'incorrect'
  }

  const openQuestions = unit.questions.filter((unitQuestion) => unitQuestion.type === 'open')
  if (openQuestions.length !== 1) return null

  if (result.isCorrect || result.score >= 0.8) return 'correct'
  if (result.score > 0) return 'partial'
  return 'incorrect'
}

function TopicMenu({
  topics,
  onCreateTopic,
  error,
}: {
  topics: Topic[]
  onCreateTopic: (name: string, emoji: string) => void | Promise<void>
  error: string | null
}) {
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('📚')
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const canCreate = name.trim().length > 0
  const closeCreateModal = () => {
    setIsCreateModalOpen(false)
    setName('')
    setEmoji('📚')
    setCreateError(null)
  }

  const handleCreateTopic = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canCreate || isCreating) return
    const nextName = name.trim()
    const nextEmoji = emoji.trim() || '📚'
    setIsCreating(true)
    setCreateError(null)
    closeCreateModal()
    try {
      await onCreateTopic(nextName, nextEmoji)
    } catch (createTopicError) {
      setIsCreateModalOpen(true)
      setName(nextName)
      setEmoji(nextEmoji)
      setCreateError(String(createTopicError))
      setIsCreating(false)
    }
  }

  return (
    <section className="menu-screen topic-menu-screen">
      <div className="menu-heading">
        <h1>Topics</h1>
        <div className="menu-actions">
          <button className="generate-exam-button" type="button" onClick={() => setIsCreateModalOpen(true)}>
            Create topic
          </button>
        </div>
      </div>

      <div className="menu-grid topic-grid">
        {topics.map((topic) => (
          <Link key={topic.id} className="exam-tile topic-tile" to={`/topics/${encodeURIComponent(topic.id)}`}>
            <span>{topic.examCount} exams · {topic.sourceCount} sources</span>
            <strong><span className="topic-emoji">{topic.emoji}</span>{topic.name}</strong>
            <small>Seen {topic.seen} questions.</small>
            <ExamTileProgress summary={{
              last25: topic.last25 ?? [],
              correctLast25: topic.correctLast25 ?? 0,
              seen: topic.seen ?? 0,
            }} />
          </Link>
        ))}
      </div>
      {error && <div className="error-box">{error}</div>}

      {isCreateModalOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeCreateModal()
          }}
        >
          <section
            className="context-modal topic-create-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="topic-create-modal-title"
          >
            <header className="context-modal-header">
              <div>
                <p className="eyebrow">Topics</p>
                <h2 id="topic-create-modal-title">Create topic</h2>
              </div>
              <button className="ghost-button" type="button" onClick={closeCreateModal}>
                Close
              </button>
            </header>

            <form className="topic-create-form" onSubmit={(event) => void handleCreateTopic(event)}>
              <div className="topic-create-fields">
                <input
                  aria-label="Topic emoji"
                  className="topic-emoji-input"
                  value={emoji}
                  maxLength={8}
                  onChange={(event) => setEmoji(event.target.value)}
                />
                <input
                  aria-label="Topic name"
                  className="topic-name-input"
                  value={name}
                  placeholder="New topic name"
                  autoFocus
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              {createError && <div className="error-box">{createError}</div>}
              <footer className="context-modal-actions">
                <button className="secondary-button" type="button" onClick={closeCreateModal}>
                  Cancel
                </button>
                <button className="generate-exam-button" type="submit" disabled={!canCreate || isCreating}>
                  {isCreating ? 'Creating...' : 'Create topic'}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}
    </section>
  )
}

function ExamMenu({
  topic,
  sets,
  examSessions,
  examGeneration,
  sources,
  context,
  onDeleteSource,
  onDeleteExam,
  onGenerateExam,
  onUploadSourceFiles,
  onOpenContextModal,
  onOpenExamGenerationModal,
  error,
}: {
  topic: Topic
  sets: QuestionSet[]
  examSessions: Record<string, ExamSession>
  examGeneration: ExamGenerationState
  sources: TopicSource[]
  context: CourseContextState
  onDeleteSource: (sourceId: string) => void | Promise<void>
  onDeleteExam: (setId: string) => void | Promise<void>
  onGenerateExam: () => void | Promise<void>
  onUploadSourceFiles: (files: FileList | SourceUploadInput[], sourceKind?: SourceUploadKind) => void | Promise<void>
  onOpenContextModal: () => void
  onOpenExamGenerationModal: () => void
  error: string | null
}) {
  const sourceInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const [sourceUploadError, setSourceUploadError] = useState<string | null>(null)
  const [examDeleteTarget, setExamDeleteTarget] = useState<QuestionSet | null>(null)
  const [isDeletingExam, setIsDeletingExam] = useState(false)
  const [deleteExamError, setDeleteExamError] = useState<string | null>(null)
  const isBusy = examGeneration.status === 'processing'
  const allQuestionsSet = sets.find((set) => set.id === 'all-questions') ?? null
  const examSets = sets.filter((set) => set.id !== 'all-questions')

  const closeDeleteModal = useCallback(() => {
    if (isDeletingExam) return
    setExamDeleteTarget(null)
    setDeleteExamError(null)
  }, [isDeletingExam])

  const uploadAssignmentFolder = useCallback(async () => {
    const showDirectoryPicker = (window as SourceDirectoryPickerWindow).showDirectoryPicker
    if (!showDirectoryPicker) {
      folderInputRef.current?.click()
      return
    }

    try {
      const directory = await showDirectoryPicker()
      const files = await collectAssignmentFolderFiles(directory)
      if (files.length === 0) {
        setSourceUploadError('No supported source files were found in that folder.')
        return
      }
      setSourceUploadError(null)
      await onUploadSourceFiles(files, 'code-example')
    } catch (folderError) {
      if (isAbortError(folderError)) return
      setSourceUploadError(String(folderError))
    }
  }, [onUploadSourceFiles])

  const confirmDeleteExam = useCallback(async () => {
    if (!examDeleteTarget || isDeletingExam) return
    try {
      setIsDeletingExam(true)
      setDeleteExamError(null)
      await onDeleteExam(examDeleteTarget.id)
      setExamDeleteTarget(null)
    } catch (deleteError) {
      setDeleteExamError(String(deleteError))
    } finally {
      setIsDeletingExam(false)
    }
  }, [examDeleteTarget, isDeletingExam, onDeleteExam])

  const sourceItems = useMemo(() => sourceSidebarItems(sources), [sources])

  return (
    <section className="menu-screen topic-exam-screen">
      <aside className="source-sidebar">
        <div className="source-sidebar-header">
          <h2>Sources</h2>
        </div>

        <input
          ref={sourceInputRef}
          className="context-file-input"
          type="file"
          accept=".pdf,.txt,.md,.csv,.json,.log,.py,.js,.jsx,.ts,.tsx,.ipynb,.java,.c,.cpp,.h,.hpp,.cs,.go,.rs,.rb,.php,.html,.css,.sql,.sh,.yml,.yaml,application/pdf,text/*,application/json"
          multiple
          onChange={(event) => {
            const { files } = event.currentTarget
            if (files?.length) {
              setSourceUploadError(null)
              const supportedFiles = filterAssignmentFolderFileList(files)
              if (supportedFiles.length > 0) {
                void onUploadSourceFiles(supportedFiles, 'auto')
              } else {
                setSourceUploadError('No supported source files were found in that folder.')
              }
            }
            event.currentTarget.value = ''
          }}
        />
        <input
          ref={folderInputRef}
          className="context-file-input"
          type="file"
          multiple
          {...{ webkitdirectory: '' }}
          onChange={(event) => {
            const { files } = event.currentTarget
            if (files?.length) {
              setSourceUploadError(null)
              const supportedFiles = filterAssignmentFolderFileList(files)
              if (supportedFiles.length > 0) {
                void onUploadSourceFiles(supportedFiles, 'code-example')
              } else {
                setSourceUploadError('No supported source files were found in that folder.')
              }
            }
            event.currentTarget.value = ''
          }}
        />

        <div className="source-actions">
          <button
            className="source-add-button"
            type="button"
            aria-label="Add files"
            title="Add files"
            onClick={() => sourceInputRef.current?.click()}
          >
            <FileIcon />
          </button>
          <button
            className="source-add-button"
            type="button"
            aria-label="Add folder"
            title="Add folder"
            onClick={() => void uploadAssignmentFolder()}
          >
            <FolderIcon />
          </button>
          <button
            className={`context-button context-${context.status}`}
            type="button"
            onClick={onOpenContextModal}
          >
            {context.status === 'processing' && <span className="context-spinner" aria-hidden="true" />}
            {context.status === 'processing' ? 'Generating' : 'Context'}
          </button>
        </div>

        {sourceUploadError && <div className="error-box source-error-box">{sourceUploadError}</div>}

        <div className="source-list">
          {sources.length === 0 ? (
            <div className="empty-chat">No sources yet.</div>
          ) : sourceItems.map((item) => (
            <div key={item.key} className={`source-row source-${item.extractionStatus}`}>
              {item.kind === 'folder' ? <SourceFolderIcon /> : <SourceKindIcon source={item.source} />}
              <div>
                <strong>{item.name}</strong>
                <small>
                  {item.kind === 'folder' ? `Folder · ${item.fileCount} files` : 'Source'} ·{' '}
                  {formatBytes(item.size)}
                  {item.extractionStatus !== 'ready' ? ` · ${item.extractionStatus}` : ''}
                  {item.extractionError ? ` · ${item.extractionError}` : ''}
                </small>
              </div>
              <button
                className="source-remove-button"
                type="button"
                aria-label={`Remove ${item.name}`}
                title={`Remove ${item.name}`}
                onClick={() => void deleteSourceSidebarItem(item, onDeleteSource)}
              >
                <TrashIcon />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="topic-exam-main">
        <div className="menu-heading">
          <div className="topic-main-heading">
            <Link className="ghost-button" to="/">
              <BackCaretIcon />
              Topics
            </Link>
            <h1>{topic.emoji} {topic.name}</h1>
          </div>
          <div className="menu-actions">
            <button
              className={`generate-exam-button generation-${examGeneration.status}`}
              type="button"
              disabled={sources.length === 0 && examGeneration.status === 'idle'}
              onClick={() => {
                if (examGeneration.status === 'processing' || examGeneration.status === 'ready' || examGeneration.status === 'error') {
                  onOpenExamGenerationModal()
                  return
                }
                void onGenerateExam()
              }}
            >
              {isBusy && <span className="context-spinner" aria-hidden="true" />}
              {examGeneration.status === 'idle' ? 'Generate exam' : examGenerationTileTitle(examGeneration)}
            </button>
            {allQuestionsSet && (
              <Link
                className="all-questions-button"
                to={`/topics/${encodeURIComponent(topic.id)}/exams/${encodeURIComponent(allQuestionsSet.id)}`}
              >
                All Questions
                <span>{allQuestionsSet.questions.length}</span>
              </Link>
            )}
          </div>
        </div>
        <div className="menu-grid">
          {examSets.map((set, index) => {
            const summary = examMenuSummary(examSessions[set.id])
            const isGeneratedExam = set.sourceType === 'generated'
            return (
              <div key={set.id} className="exam-tile-shell">
                {isGeneratedExam && (
                  <button
                    className="exam-tile-menu-button"
                    type="button"
                    aria-label={`Open actions for ${set.title}`}
                    title={`Open actions for ${set.title}`}
                    onClick={() => {
                      setDeleteExamError(null)
                      setExamDeleteTarget(set)
                    }}
                  >
                    <ThreeDotIcon />
                  </button>
                )}
                <Link
                  className={`exam-tile${isGeneratedExam ? ' generated-exam-tile' : ''}`}
                  to={`/topics/${encodeURIComponent(topic.id)}/exams/${encodeURIComponent(set.id)}`}
                >
                  <span>Exam {index + 1} · {set.questions.length} questions</span>
                  <strong>{set.title}</strong>
                  {set.description && <small>{compactExamDescription(set.description)}</small>}
                  <ExamTileProgress summary={summary} />
                </Link>
              </div>
            )
          })}
        </div>
        {error && <div className="error-box">{error}</div>}
      </div>
      {examDeleteTarget && (
        <DeleteExamModal
          exam={examDeleteTarget}
          error={deleteExamError}
          isDeleting={isDeletingExam}
          onConfirm={() => void confirmDeleteExam()}
          onClose={closeDeleteModal}
        />
      )}
    </section>
  )
}

function sourceSidebarItems(sources: TopicSource[]): SourceSidebarItem[] {
  const items: SourceSidebarItem[] = []
  const folderItems = new Map<string, Extract<SourceSidebarItem, { kind: 'folder' }>>()

  for (const source of sources) {
    const folderName = sourceFolderName(source)
    if (!folderName) {
      items.push({
        kind: 'source',
        key: source.id,
        name: source.relativePath || source.name,
        size: source.size,
        extractionStatus: source.extractionStatus,
        extractionError: source.extractionError,
        sourceIds: [source.id],
        source,
      })
      continue
    }

    const folderKey = `folder:${folderName}`
    const existing = folderItems.get(folderKey)
    if (existing) {
      existing.size += source.size
      existing.fileCount += 1
      existing.sourceIds.push(source.id)
      existing.extractionStatus = combineSourceStatus(existing.extractionStatus, source.extractionStatus)
      if (!existing.extractionError && source.extractionError) existing.extractionError = source.extractionError
      if (source.createdAt < existing.sortDate) existing.sortDate = source.createdAt
      continue
    }

    const folderItem: Extract<SourceSidebarItem, { kind: 'folder' }> = {
      kind: 'folder',
      key: folderKey,
      name: folderName,
      size: source.size,
      extractionStatus: source.extractionStatus,
      extractionError: source.extractionError,
      sourceIds: [source.id],
      fileCount: 1,
      sortDate: source.createdAt,
    }
    folderItems.set(folderKey, folderItem)
    items.push(folderItem)
  }

  return items.sort((left, right) => sourceItemSortDate(left).localeCompare(sourceItemSortDate(right)))
}

function sourceFolderName(source: TopicSource) {
  const parts = source.relativePath.split('/').filter(Boolean)
  return parts.length > 1 ? parts[0] : ''
}

function sourceItemSortDate(item: SourceSidebarItem) {
  return item.kind === 'folder' ? item.sortDate : item.source.createdAt
}

function combineSourceStatus(
  current: TopicSource['extractionStatus'],
  next: TopicSource['extractionStatus'],
): TopicSource['extractionStatus'] {
  if (current === 'pending' || next === 'pending') return 'pending'
  if (current === 'error' || next === 'error') return 'error'
  return 'ready'
}

async function deleteSourceSidebarItem(
  item: SourceSidebarItem,
  onDeleteSource: (sourceId: string) => void | Promise<void>,
) {
  for (const sourceId of item.sourceIds) {
    await Promise.resolve(onDeleteSource(sourceId))
  }
}

function SourceKindIcon({ source }: { source: TopicSource }) {
  const icon = sourceIconMeta(source)
  const Icon = icon.Icon
  return (
    <span className={`source-kind-icon source-kind-${icon.tone}`} title={icon.label}>
      <Icon size={27} strokeWidth={2.1} absoluteStrokeWidth aria-hidden="true" />
      <span className="source-kind-extension">{icon.label}</span>
    </span>
  )
}

function SourceFolderIcon() {
  return (
    <span className="source-kind-icon source-kind-folder" title="Folder">
      <FolderOpen size={28} strokeWidth={2.1} absoluteStrokeWidth aria-hidden="true" />
      <span className="source-kind-extension">DIR</span>
    </span>
  )
}

function sourceIconMeta(source: TopicSource): {
  label: string
  tone: string
  Icon: ComponentType<LucideProps>
} {
  const extension = (source.extension || source.name.split('.').pop() || '').replace(/^\./, '').toLowerCase()
  switch (extension) {
    case 'pdf':
      return { label: 'PDF', tone: 'pdf', Icon: FileText }
    case 'ipynb':
      return { label: 'NB', tone: 'notebook', Icon: NotebookText }
    case 'py':
      return { label: 'PY', tone: 'python', Icon: FileCode2 }
    case 'js':
    case 'jsx':
      return { label: extension.toUpperCase(), tone: 'javascript', Icon: FileCode2 }
    case 'ts':
    case 'tsx':
      return { label: extension.toUpperCase(), tone: 'typescript', Icon: FileCode2 }
    case 'json':
      return { label: 'JSON', tone: 'json', Icon: FileJson }
    case 'md':
      return { label: 'MD', tone: 'markdown', Icon: FileType }
    case 'csv':
      return { label: 'CSV', tone: 'csv', Icon: FileSpreadsheet }
    case 'yml':
    case 'yaml':
      return { label: 'YML', tone: 'yaml', Icon: Braces }
    case 'html':
      return { label: 'HTML', tone: 'html', Icon: FileCode2 }
    case 'css':
      return { label: 'CSS', tone: 'css', Icon: FileCode2 }
    case 'sql':
      return { label: 'SQL', tone: 'sql', Icon: FileSpreadsheet }
    case 'txt':
    case 'log':
      return { label: extension.toUpperCase(), tone: 'text', Icon: FileText }
    case 'java':
      return { label: 'JAVA', tone: 'java', Icon: FileCode2 }
    case 'cpp':
    case 'hpp':
      return { label: 'C++', tone: 'cpp', Icon: FileCode2 }
    case 'c':
    case 'h':
      return { label: 'C', tone: 'cpp', Icon: FileCode2 }
    case 'cs':
      return { label: 'C#', tone: 'csharp', Icon: FileCode2 }
    case 'go':
      return { label: 'GO', tone: 'go', Icon: FileCode2 }
    case 'rs':
      return { label: 'RS', tone: 'rust', Icon: FileCode2 }
    case 'rb':
      return { label: 'RB', tone: 'ruby', Icon: FileCode2 }
    case 'php':
      return { label: 'PHP', tone: 'php', Icon: FileCode2 }
    case 'sh':
      return { label: 'SH', tone: 'shell', Icon: FileTerminal }
    default:
      return source.sourceKind === 'code-example'
        ? { label: 'CODE', tone: 'code', Icon: FileCode2 }
        : { label: 'FILE', tone: 'file', Icon: File }
  }
}

function FileIcon({ className = 'source-add-icon' }: { className?: string }) {
  return <FilePlus className={className} size={22} strokeWidth={2.2} absoluteStrokeWidth aria-hidden="true" />
}

function FolderIcon({ className = 'source-add-icon' }: { className?: string }) {
  return <FolderPlus className={className} size={22} strokeWidth={2.2} absoluteStrokeWidth aria-hidden="true" />
}

function BackCaretIcon() {
  return (
    <svg className="back-caret-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg className="source-trash-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M6 6l1 16h10l1-16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  )
}

function ThreeDotIcon() {
  return (
    <svg className="three-dot-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  )
}

const DeleteExamModal = memo(function DeleteExamModal({
  exam,
  error,
  isDeleting,
  onConfirm,
  onClose,
}: {
  exam: QuestionSet
  error: string | null
  isDeleting: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="context-modal delete-exam-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-exam-modal-title"
      >
        <header className="context-modal-header">
          <div>
            <p className="eyebrow">Generated Exam</p>
            <h2 id="delete-exam-modal-title">Delete exam?</h2>
          </div>
          <button className="ghost-button" type="button" disabled={isDeleting} onClick={onClose}>
            Close
          </button>
        </header>
        <div className="delete-exam-summary">
          <strong>{exam.title}</strong>
          <small>{exam.questions.length} questions</small>
        </div>
        <p className="delete-exam-copy">
          This removes the exam from this topic and from future exam generation context.
        </p>
        {error && <div className="error-box">{error}</div>}
        <div className="context-modal-actions">
          <button className="ghost-button" type="button" disabled={isDeleting} onClick={onClose}>
            Cancel
          </button>
          <button className="danger-button" type="button" disabled={isDeleting} onClick={onConfirm}>
            {isDeleting ? 'Deleting...' : 'Delete exam'}
          </button>
        </div>
      </section>
    </div>
  )
})

const ExamGenerationModal = memo(function ExamGenerationModal({
  generation,
  onClear,
  onClose,
}: {
  generation: ExamGenerationState
  onClear: () => void
  onClose: () => void
}) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="context-modal exam-generation-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="exam-generation-modal-title"
      >
        <header className="context-modal-header">
          <div>
            <p className="eyebrow">Exam Generation</p>
            <h2 id="exam-generation-modal-title">{examGenerationTileTitle(generation)}</h2>
          </div>
          <button className="ghost-button" type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="context-modal-meta">
          <span>Status: {generation.status}</span>
          {generation.phase && <span>{generation.phase}</span>}
          {generation.startedAt && <span>Started {formatDateTime(generation.startedAt)}</span>}
          {generation.completedAt && <span>Finished {formatDateTime(generation.completedAt)}</span>}
          {generation.threadId && <span>Thread {generation.threadId}</span>}
        </div>

        <ul className="context-file-list">
          {generation.files.map((file, index) => (
            <li key={`${file.name}:${index}`}>
              <span>{file.name}</span>
              <small>{formatBytes(file.size)}</small>
            </li>
          ))}
        </ul>

        {generation.error && <div className="error-box">{generation.error}</div>}

        <div className="exam-generation-feed">
          {generation.log.length > 0 ? (
            compactExamGenerationLog(generation.log).map((entry) => (
              <div key={entry.id} className={`exam-generation-event event-${entry.kind}`}>
                <div className="exam-generation-event-label">
                  {examGenerationEventLabel(entry)}
                  <span>{formatEventTime(entry.at)}</span>
                </div>
                <div className="exam-generation-event-body">
                  {entry.kind === 'assistant' ? (
                    <MarkdownBlock mode="chat">{entry.message}</MarkdownBlock>
                  ) : (
                    <>
                      <strong>{entry.message}</strong>
                      {entry.detail && <small>{entry.detail}</small>}
                    </>
                  )}
                </div>
              </div>
            ))
          ) : (
            <div className="empty-chat">No generation activity yet.</div>
          )}
        </div>

        <footer className="context-modal-actions">
          <button className="secondary-button" type="button" onClick={onClear}>
            Clear generation status
          </button>
        </footer>
      </section>
    </div>
  )
})

const Toast = memo(function Toast({
  message,
  onClose,
}: {
  message: string
  onClose: () => void
}) {
  return (
    <button className="app-toast" type="button" onClick={onClose}>
      {message}
    </button>
  )
})

const ExamTileProgress = memo(function ExamTileProgress({
  summary,
}: {
  summary: {
    last25: HistoryItem[]
    correctLast25: number
    seen: number
  }
}) {
  return (
    <div className="exam-tile-progress">
      <div className="exam-tile-stats">
        <span>Last 25 <strong>{summary.correctLast25}/{summary.last25.length || 25}</strong></span>
        <span>Seen <strong>{summary.seen}</strong></span>
      </div>
      <div className="exam-tile-history" aria-label={`Last 25: ${summary.correctLast25} correct`}>
        {Array.from({ length: 25 }, (_, index) => {
          const item = summary.last25[index]
          return (
            <span
              key={index}
              className={`exam-tile-dot ${item ? item.isCorrect ? 'correct' : 'wrong' : ''}`}
            />
          )
        })}
      </div>
    </div>
  )
})

function examMenuSummary(session: ExamSession | undefined) {
  const last25 = session?.history.slice(0, 25) ?? []
  return {
    last25,
    correctLast25: last25.filter((item) => item.isCorrect).length,
    seen: Object.keys(session?.progress ?? {}).length,
  }
}

function examGenerationTileTitle(generation: ExamGenerationState) {
  if (generation.status === 'processing') return 'Generating exam'
  if (generation.status === 'ready') return generation.generatedExamTitle || 'Generated exam ready'
  if (generation.status === 'error') return 'Exam generation failed'
  return 'Generate exam'
}

function compactExamGenerationLog(log: ExamGenerationLogEntry[]) {
  const compacted: ExamGenerationLogEntry[] = []
  for (const entry of log) {
    if (!entry.message.trim()) continue
    const previous = compacted.at(-1)
    if (entry.kind === 'assistant' && previous?.kind === 'assistant') {
      compacted[compacted.length - 1] = {
        ...previous,
        at: entry.at,
        message: `${previous.message}${entry.message}`,
      }
      continue
    }
    compacted.push(entry)
  }
  return compacted
}

function examGenerationEventLabel(entry: ExamGenerationLogEntry) {
  if (entry.kind === 'assistant') return 'Codex'
  if (entry.kind === 'tool') return 'Tool'
  if (entry.kind === 'error') return 'Error'
  return 'Status'
}

function formatEventTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function compactExamDescription(description: string) {
  return description
    .replace(/^Generated exam question set covering\s+/i, 'Covers ')
    .replace(/^Machine Learning BSc practice exam,\s*/i, '')
    .replace(/^Previous Machine Learning exam questions\.?$/i, 'Previous exam.')
    .replace(/\.$/, '')
    .split(/[,;]/)
    .slice(0, 3)
    .join(', ')
    .trim()
    .replace(/\.$/, '') + '.'
}

const MarkdownBlock = memo(function MarkdownBlock({
  children,
  mode = 'question',
  className = '',
}: {
  children: string
  mode?: 'question' | 'chat'
  className?: string
}) {
  const markdown = useMemo(
    () => (mode === 'question' ? normalizeQuestionMarkup(children) : normalizeChatMarkdown(children)),
    [children, mode],
  )

  return (
    <div className={`markdown markdown-${mode} ${className}`.trim()}>
      <Markdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        components={markdownComponents}
      >
        {markdown}
      </Markdown>
    </div>
  )
})

function normalizeQuestionMarkup(markup: string) {
  return markup
    .replace(
      /<code(?:\s+lang=["']?([\w-]+)["']?)?>([\s\S]*?)<\/code>/gi,
      (_, rawLanguage = '', rawCode: string) => {
        const language = String(rawLanguage).trim()
        const code = rawCode.replace(/^\n/, '').replace(/\n$/, '')
        if (!language && !code.includes('\n')) return `\`${code}\``
        const fenceLanguage = language ? language : ''
        return `\n\n\`\`\`${fenceLanguage}\n${code}\n\`\`\`\n\n`
      },
    )
    .replace(/<math>([\s\S]*?)<\/math>/gi, (_, rawMath: string) => {
      const math = rawMath.trim()
      if (!math) return ''
      return math.includes('\n') ? `\n\n$$\n${math}\n$$\n\n` : `$${math}$`
    })
    .replace(/<math\s+display>([\s\S]*?)<\/math>/gi, (_, rawMath: string) => {
      const math = rawMath.trim()
      if (!math) return ''
      return `\n\n$$\n${math}\n$$\n\n`
    })
    .replace(/<image>([\s\S]*?)<\/image>/gi, (_, rawPath: string) => {
      const path = rawPath.trim()
      if (!path) return ''
      return `\n\n![Question attachment](${encodeMarkdownUrl(path)})\n\n`
    })
}

function removeSharedImageTags(prompt: string, sharedPrompt: string) {
  const sharedImages = new Set(extractQuestionImageTags(sharedPrompt))
  if (sharedImages.size === 0) return prompt

  return prompt
    .replace(/<image>([\s\S]*?)<\/image>/gi, (tag, rawPath: string) => {
      const imagePath = rawPath.trim()
      return sharedImages.has(imagePath) ? '' : tag
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractQuestionImageTags(markup: string) {
  const paths: string[] = []
  markup.replace(/<image>([\s\S]*?)<\/image>/gi, (_, rawPath: string) => {
    const imagePath = rawPath.trim()
    if (imagePath) paths.push(imagePath)
    return ''
  })
  return paths
}

function normalizeChatMarkdown(markup: string) {
  return normalizeLatexDelimiters(markup)
}

function normalizeLatexDelimiters(markup: string) {
  return markup
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, rawMath: string) => {
      const math = rawMath.trim()
      return math ? `\n\n$$\n${math}\n$$\n\n` : ''
    })
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, rawMath: string) => {
      const math = rawMath.trim()
      return math ? `$${math}$` : ''
    })
    .replace(/<math\s+display>([\s\S]*?)<\/math>/gi, (_, rawMath: string) => {
      const math = rawMath.trim()
      return math ? `\n\n$$\n${math}\n$$\n\n` : ''
    })
    .replace(/<math>([\s\S]*?)<\/math>/gi, (_, rawMath: string) => {
      const math = rawMath.trim()
      if (!math) return ''
      return math.includes('\n') ? `\n\n$$\n${math}\n$$\n\n` : `$${math}$`
    })
}

function encodeMarkdownUrl(url: string) {
  return encodeURI(url).replace(/\)/g, '%29')
}

function resolveImageSource(src?: string) {
  if (!src) return ''
  if (/^(https?:|data:|blob:|\/api\/file|\/api\/generated-assets\/)/i.test(src)) return src
  if (/^\/(generated-assets|favicon\.svg|icons\.svg)\b/i.test(src)) return src
  return `/api/file?path=${encodeURIComponent(decodeUrl(src))}`
}

function decodeUrl(url: string) {
  try {
    return decodeURI(url)
  } catch {
    return url
  }
}

function MermaidDiagram({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = `mermaid-${Math.random().toString(36).slice(2)}`
    mermaid
      .render(id, chart)
      .then(({ svg }) => {
        if (ref.current) ref.current.innerHTML = svg
      })
      .catch(() => {
        if (ref.current) ref.current.textContent = chart
      })
  }, [chart])

  return <div ref={ref} className="mermaid-box" />
}

function autoGrowTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.height = '0px'
  textarea.style.height = `${textarea.scrollHeight}px`
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function buildQuestionUnits(questions: Question[]) {
  const units: QuestionUnit[] = []
  const groupIndexes = new Map<string, number>()

  for (const question of questions) {
    if (!question.groupId) {
      units.push({
        id: question.id,
        source: question.source,
        title: question.title,
        questions: [question],
        concepts: question.concepts ?? [],
      })
      continue
    }

    const existingIndex = groupIndexes.get(question.groupId)
    if (existingIndex === undefined) {
      groupIndexes.set(question.groupId, units.length)
      units.push({
        id: question.groupId,
        source: question.source,
        title: question.groupTitle ?? question.title,
        questions: [question],
        sharedPrompt: question.groupPrompt,
        concepts: question.concepts ?? [],
      })
      continue
    }

    const existing = units[existingIndex]
    existing.questions.push(question)
    existing.concepts = uniqueStrings([...existing.concepts, ...(question.concepts ?? [])])
  }

  return units.map((unit) => ({
    ...unit,
    questions: [...unit.questions].sort((a, b) => (a.groupOrder ?? 0) - (b.groupOrder ?? 0)),
  }))
}

function shuffleQuestionOptions(question: Question, seed: string): Question {
  if (question.options.length < 2) return question

  return {
    ...question,
    options: seededShuffle(question.options, `${seed}:${question.id}`),
  }
}

function seededShuffle<T>(values: T[], seed: string) {
  const shuffled = [...values]
  const random = mulberry32(hashString(seed))

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1))
    const current = shuffled[index]
    shuffled[index] = shuffled[swapIndex]
    shuffled[swapIndex] = current
  }

  return shuffled
}

function hashString(value: string) {
  let hash = 2166136261

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return hash >>> 0
}

function mulberry32(seed: number) {
  return () => {
    seed += 0x6D2B79F5
    let value = seed
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function buildTutorQuestion(unit: QuestionUnit) {
  if (unit.questions.length === 1) return buildTutorChoiceQuestion(unit.questions[0])

  return {
    id: unit.id,
    source: unit.source,
    title: unit.title,
    type: 'group',
    prompt: unit.sharedPrompt ?? '',
    concepts: unit.concepts,
    questions: unit.questions.map(buildTutorChoiceQuestion),
  }
}

function buildTutorChoiceQuestion(question: Question): Question {
  if (question.type === 'open' || question.options.length === 0) return question

  const sourceToTutorOptionId = buildTutorOptionIdMap(question)
  const mapSourceOptionIdsToTutorIds = (optionIds: string[]) => {
    return optionIds.map((optionId) => sourceToTutorOptionId.get(optionId) ?? optionId)
  }

  return {
    ...question,
    options: question.options.map((option, index) => ({
      ...option,
      id: buildTutorOptionId(question.id, option),
      visibleLabel: displayOptionId(index),
    })),
    answer: question.answer
      ? {
          ...question.answer,
          correctOptionIds: question.answer.correctOptionIds
            ? mapSourceOptionIdsToTutorIds(question.answer.correctOptionIds)
            : null,
        }
      : question.answer,
    correctOptionIds: question.correctOptionIds
      ? mapSourceOptionIdsToTutorIds(question.correctOptionIds)
      : undefined,
  }
}

function buildTutorAnswerPayload(
  unit: QuestionUnit,
  answersByQuestion: Record<string, AnswerPayload>,
): AnswerPayload | GroupAnswerPayload {
  if (unit.questions.length === 1) {
    return normalizeTutorAnswer(unit.questions[0], answersByQuestion[unit.questions[0].id])
  }

  return {
    subAnswers: unit.questions.map((question) => ({
      questionId: question.id,
      number: question.number,
      type: question.type,
      ...normalizeTutorAnswer(question, answersByQuestion[question.id]),
    })),
  }
}

function normalizeTutorAnswer(question: Question, answer: AnswerPayload = {}) {
  if (question.type === 'open') return { text: (answer.text ?? '').trim() }
  const sourceToTutorOptionId = buildTutorOptionIdMap(question)
  return {
    selectedOptionIds: (answer.selectedOptionIds ?? [])
      .map((optionId) => sourceToTutorOptionId.get(optionId) ?? optionId),
  }
}

function buildTutorOptionIdMap(question: Question) {
  return new Map(question.options.map((option) => [
    option.id,
    buildTutorOptionId(question.id, option),
  ]))
}

function buildTutorOptionId(questionId: string, option: Option) {
  return `opt_${hashString(`${questionId}\u0000${option.id}\u0000${option.text}`).toString(36)}`
}

function displayOptionId(index: number) {
  const alphabetLength = 26
  let value = index
  let label = ''

  do {
    label = String.fromCharCode(65 + (value % alphabetLength)) + label
    value = Math.floor(value / alphabetLength) - 1
  } while (value >= 0)

  return label
}

function normalizeAnswer(question: Question, answer: AnswerPayload = {}) {
  if (question.type === 'open') return { text: (answer.text ?? '').trim() }
  return { selectedOptionIds: answer.selectedOptionIds ?? [] }
}

function getResponseCorrectOptionIdsByQuestion(unit: QuestionUnit, response: TutorResponse) {
  if (response.correctOptionIdsByQuestion && Object.keys(response.correctOptionIdsByQuestion).length > 0) {
    return Object.fromEntries(
      unit.questions.map((question) => {
        const tutorQuestion = buildTutorChoiceQuestion(question)
        const correctOptionIds = response.correctOptionIdsByQuestion?.[question.id] ?? []
        return [
          question.id,
          correctOptionIds
            .map((optionId) => resolveTutorResponseOptionId(optionId, tutorQuestion, question))
            .filter((optionId): optionId is string => Boolean(optionId)),
        ]
      }).filter(([, correctOptionIds]) => correctOptionIds.length > 0),
    )
  }

  const choiceQuestions = unit.questions.filter((question) => question.type !== 'open')
  if (choiceQuestions.length !== 1) return {}

  const choiceQuestion = choiceQuestions[0]
  const tutorChoiceQuestion = buildTutorChoiceQuestion(choiceQuestion)
  const keyedCorrectOptionIds = response.correctOptionIds
    ?.map((optionId) => resolveTutorResponseOptionId(optionId, tutorChoiceQuestion, choiceQuestion))
    .filter((optionId): optionId is string => Boolean(optionId))

  return keyedCorrectOptionIds?.length
    ? { [choiceQuestion.id]: keyedCorrectOptionIds }
    : {}
}

function resolveTutorResponseOptionId(
  idOrVisibleLabel: string,
  tutorQuestion: Question,
  sourceQuestion: Question,
) {
  const normalized = idOrVisibleLabel.toLowerCase()
  const tutorOptionIndex = tutorQuestion.options.findIndex((option) => option.id.toLowerCase() === normalized)
  if (tutorOptionIndex >= 0) return sourceQuestion.options[tutorOptionIndex]?.id

  const visibleLabelIndex = tutorQuestion.options.findIndex((option) =>
    option.visibleLabel?.toLowerCase() === normalized
  )
  if (visibleLabelIndex >= 0) return sourceQuestion.options[visibleLabelIndex]?.id

  return sourceQuestion.options.find((option) => option.id.toLowerCase() === normalized)?.id
}

function buildRevealedCorrectOptionIds(
  existingCorrectOptionIds: Record<string, string[]>,
  correctOptionIdsByQuestion: Record<string, string[]>,
) {
  if (Object.keys(correctOptionIdsByQuestion).length === 0) return existingCorrectOptionIds

  return {
    ...existingCorrectOptionIds,
    ...correctOptionIdsByQuestion,
  }
}

function getCorrectOptionIds(question: Question) {
  if (Array.isArray(question.answer?.correctOptionIds)) return question.answer.correctOptionIds
  if (Array.isArray(question.correctOptionIds)) return question.correctOptionIds
  return []
}

function isUnitAnswered(unit: QuestionUnit, answersByQuestion: Record<string, AnswerPayload>) {
  return unit.questions.every((question) => {
    const answer = normalizeAnswer(question, answersByQuestion[question.id])
    if (question.type === 'open') return Boolean(answer.text)
    return (answer.selectedOptionIds ?? []).length > 0
  })
}

function createExamSession(deck: { currentId: string | null; queue: string[] }): ExamSession {
  return {
    currentId: deck.currentId,
    questionQueue: deck.queue,
    answersByQuestion: {},
    result: null,
    isAnswerKeyRevealed: false,
    revealedCorrectOptionIdsByQuestion: {},
    messages: [],
    tutorSessionId: crypto.randomUUID(),
    optionOrderSeed: crypto.randomUUID(),
    usedLearningBeforeAnswer: false,
    progress: {},
    history: [],
  }
}

function resetExamSessionQuestionState(
  session: ExamSession,
  nextQuestionState: Pick<ExamSession, 'currentId' | 'questionQueue'>,
): ExamSession {
  return {
    ...session,
    ...nextQuestionState,
    answersByQuestion: {},
    result: null,
    isAnswerKeyRevealed: false,
    revealedCorrectOptionIdsByQuestion: {},
    messages: [],
    tutorSessionId: crypto.randomUUID(),
    optionOrderSeed: crypto.randomUUID(),
    usedLearningBeforeAnswer: false,
  }
}

function applyAnsweredUnitToSession(
  session: ExamSession,
  unit: QuestionUnit,
  isCorrect: boolean,
  now: number,
): ExamSession {
  const progress = session.progress ?? {}
  const nextProgress = { ...progress }
  for (const question of unit.questions) {
    const existing = progress[question.id] ?? {
      attempts: 0,
      correct: 0,
      wrong: 0,
      streak: 0,
      dueAt: now,
      ease: 1,
    }
    nextProgress[question.id] = updateRecord(existing, isCorrect, now)
  }

  return {
    ...session,
    progress: nextProgress,
    history: [
      {
        questionId: unit.id,
        title: `${unit.source}: ${unit.title}`,
        isCorrect,
        answeredAt: now,
      },
      ...(session.history ?? []),
    ],
  }
}

function sourceQuestionUnitsBySet(unit: QuestionUnit) {
  const questionsBySet = new Map<string, Question[]>()
  for (const question of unit.questions) {
    const questions = questionsBySet.get(question.setId) ?? []
    questions.push(question)
    questionsBySet.set(question.setId, questions)
  }

  return [...questionsBySet.entries()].flatMap(([setId, questions]) =>
    buildQuestionUnits(questions).map((sourceUnit) => [setId, sourceUnit] as const),
  )
}

function prepareExamSessionsForStorage(sessions: Record<string, ExamSession>): Record<string, ExamSession> {
  return Object.fromEntries(
    Object.entries(sessions).map(([setId, session]) => [
      setId,
      {
        ...session,
        messages: persistedTutorMessages(session.messages),
      },
    ]),
  )
}

function isExamSessionValid(session: ExamSession | undefined, units: QuestionUnit[]) {
  if (!session?.currentId) return false
  const unitIds = new Set(units.map((unit) => unit.id))
  return unitIds.has(session.currentId) && session.questionQueue.every((id) => unitIds.has(id))
}

function buildInitialQuestionDeck(units: QuestionUnit[]) {
  return buildInitialQuestionDeckFromIds(units.map((unit) => unit.id))
}

function buildInitialQuestionDeckFromIds(unitIds: string[]) {
  const [currentId = null, ...queue] = shuffleQuestionIds(unitIds)
  return { currentId, queue }
}

function getNextQuestionFromQueue(
  unitIds: string[],
  currentId: string | null,
  queue: string[],
  requeueCurrent: boolean,
) {
  if (unitIds.length === 0) return null

  const unitIdSet = new Set(unitIds)
  const remainingQueue = queue.filter((id) => id !== currentId && unitIdSet.has(id))
  const nextQueue =
    requeueCurrent && currentId && unitIdSet.has(currentId)
      ? [...remainingQueue, currentId]
      : remainingQueue

  if (nextQueue.length > 0) {
    const [nextId, ...rest] = nextQueue
    return { currentId: nextId, queue: rest }
  }

  return buildInitialQuestionDeckFromIds(unitIds)
}

function shuffleQuestionIds(ids: string[]) {
  return seededShuffle(ids, crypto.randomUUID())
}

function findQuestionOverride(bank: QuestionBank, questionId: string) {
  for (const set of bank.sets) {
    const unit = buildQuestionUnits(set.questions).find(
      (candidate) =>
        candidate.id === questionId ||
        candidate.questions.some((question) => question.id === questionId),
    )
    if (unit) return { setId: set.id, unitId: unit.id }
  }

  return null
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)]
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function updateRecord(record: ProgressRecord, isCorrect: boolean, now: number) {
  const attempts = record.attempts + 1
  const streak = isCorrect ? record.streak + 1 : 0
  const ease = Math.min(2.5, Math.max(0.7, record.ease + (isCorrect ? 0.15 : -0.25)))
  const soon = 90 * 1000
  const intervals = [soon, 5 * 60 * 1000, 25 * 60 * 1000, 2 * 60 * 60 * 1000]
  const interval = isCorrect
    ? intervals[Math.min(streak, intervals.length - 1)] * ease
    : 0

  return {
    attempts,
    correct: record.correct + (isCorrect ? 1 : 0),
    wrong: record.wrong + (isCorrect ? 0 : 1),
    streak,
    ease,
    dueAt: now + interval,
    lastSeenAt: now,
  }
}

function forceLearningAttemptRetry(response: TutorResponse): TutorResponse {
  return {
    ...response,
    isCorrect: false,
    score: 0,
    verdict: 'Learning attempt - repeat this question',
    nextPrompt: 'Try this again later without using I don\'t know first.',
    explanation: [
      '**This attempt is recorded as 0% because you used "I don\'t know" before answering.**',
      'Use the feedback to repair the concept, but the question will repeat until you can retrieve it cold.',
      '',
      response.explanation,
    ].join('\n\n'),
  }
}

async function postTutorStream(
  url: string,
  payload: unknown,
  handlers: {
    onStatus?: (message: string) => void
    onDelta?: (delta: string) => void
    onFinal?: (response: TutorResponse) => void
  } = {},
) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error(await response.text())

  if (!response.body) {
    return (await response.json()) as TutorResponse
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finalResponse: TutorResponse | null = null

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
    buffer = readStreamLines(buffer, (line) => {
      const event = JSON.parse(line) as TutorStreamEvent
      if (event.type === 'status') handlers.onStatus?.(event.message)
      if (event.type === 'delta') handlers.onDelta?.(event.delta)
      if (event.type === 'final') {
        finalResponse = event.response
        handlers.onFinal?.(event.response)
      }
    })
    if (done) break
  }

  if (!finalResponse) throw new Error('Codex stream ended without a tutor response.')
  return finalResponse
}

async function jsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await response.text())
  return await response.json() as T
}

async function loadTopicsFromApi() {
  const payload = await fetch('/api/topics').then(jsonResponse<{ topics: Topic[] }>)
  return payload.topics
}

function readStreamLines(buffer: string, onLine: (line: string) => void) {
  const lines = buffer.split(/\r?\n/)
  const rest = lines.pop() ?? ''

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed) onLine(trimmed)
  }

  return rest
}

function isScrolledNearBottom(element: HTMLElement) {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <= codexAutoScrollThreshold
  )
}

function useBatchedStreamingText() {
  const [text, setText] = useState('')
  const pendingTextRef = useRef('')
  const animationFrameRef = useRef<number | null>(null)

  const flushPendingText = useCallback(() => {
    animationFrameRef.current = null
    if (!pendingTextRef.current) return
    const nextText = pendingTextRef.current
    pendingTextRef.current = ''
    setText((currentText) => currentText + nextText)
  }, [])

  const append = useCallback((delta: string) => {
    if (!delta) return
    pendingTextRef.current += delta
    if (animationFrameRef.current !== null) return
    animationFrameRef.current = window.requestAnimationFrame(flushPendingText)
  }, [flushPendingText])

  const clear = useCallback(() => {
    pendingTextRef.current = ''
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
    setText('')
  }, [])

  useEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [])

  return { text, append, clear }
}

type LocalStateOptions = {
  persistenceDelayMs?: number
}

function useLocalState<T>(
  key: string,
  initialValue: T,
  prepareForStorage: (value: T) => T = identity,
  options: LocalStateOptions = {},
) {
  const [state, setState] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key)
      return stored ? prepareForStorage(JSON.parse(stored) as T) : initialValue
    } catch {
      return initialValue
    }
  })

  useEffect(() => {
    const persist = () => {
      localStorage.setItem(key, JSON.stringify(prepareForStorage(state)))
    }
    const delay = options.persistenceDelayMs ?? 0
    if (delay <= 0) {
      persist()
      return undefined
    }
    const timeout = window.setTimeout(persist, delay)
    return () => window.clearTimeout(timeout)
  }, [key, options.persistenceDelayMs, prepareForStorage, state])

  return [state, setState] as const
}

export default App

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
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react'
import Markdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import mermaid from 'mermaid'
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
  size: number
  extension: string
}

type CourseContextState = {
  status: ContextStatus
  fileCount: number
  files: ContextFile[]
  generatedAt: string | null
  injectedPrompt: string
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

const progressKey = 'turbolearner.progress.v1'
const activeSetKey = 'turbolearner.activeSet.v1'
const activeQuestionKey = 'turbolearner.activeQuestion.v1'
const activeQuestionQueueKey = 'turbolearner.activeQuestionQueue.v1'
const activeAnswersKey = 'turbolearner.activeAnswers.v1'
const activeResultKey = 'turbolearner.activeResult.v1'
const activeAnswerKeyRevealedKey = 'turbolearner.activeAnswerKeyRevealed.v1'
const activeRevealedCorrectOptionIdsKey = 'turbolearner.revealedCorrectOptionIds.v1'
const activeHistoryKey = 'turbolearner.activeHistory.v1'
const activeMessagesKey = 'turbolearner.activeMessages.v1'
const activeTutorSessionKey = 'turbolearner.activeTutorSession.v1'
const activeOptionOrderSeedKey = 'turbolearner.activeOptionOrderSeed.v1'
const activeUsedLearningBeforeAnswerKey = 'turbolearner.usedLearningBeforeAnswer.v1'
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
  injectedPrompt: '',
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

function App() {
  const [bank, setBank] = useState<QuestionBank | null>(null)
  const [selectedSetId, setSelectedSetId] = useLocalState<string | null>(activeSetKey, null)
  const [progress, setProgress] = useLocalState<Record<string, ProgressRecord>>(progressKey, {})
  const [history, setHistory] = useLocalState<HistoryItem[]>(activeHistoryKey, [])
  const [currentId, setCurrentId] = useLocalState<string | null>(activeQuestionKey, null)
  const [questionQueue, setQuestionQueue] = useLocalState<string[]>(
    activeQuestionQueueKey,
    [],
  )
  const [answersByQuestion, setAnswersByQuestion] = useLocalState<Record<string, AnswerPayload>>(
    activeAnswersKey,
    {},
  )
  const [result, setResult] = useLocalState<TutorResponse | null>(activeResultKey, null)
  const [isAnswerKeyRevealed, setIsAnswerKeyRevealed] = useLocalState(
    activeAnswerKeyRevealedKey,
    false,
  )
  const [revealedCorrectOptionIdsByQuestion, setRevealedCorrectOptionIdsByQuestion] =
    useLocalState<Record<string, string[]>>(activeRevealedCorrectOptionIdsKey, {})
  const [messages, setMessages] = useLocalState<TutorMessage[]>(
    activeMessagesKey,
    [],
    persistedTutorMessages,
    { persistenceDelayMs: localStatePersistenceDelayMs },
  )
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
  const [tutorSessionId, setTutorSessionId] = useLocalState(
    activeTutorSessionKey,
    crypto.randomUUID(),
  )
  const [optionOrderSeed, setOptionOrderSeed] = useLocalState(
    activeOptionOrderSeedKey,
    crypto.randomUUID(),
  )
  const [usedLearningBeforeAnswer, setUsedLearningBeforeAnswer] = useLocalState(
    activeUsedLearningBeforeAnswerKey,
    false,
  )
  const [error, setError] = useState<string | null>(null)
  const [courseContext, setCourseContext] = useState<CourseContextState>(emptyCourseContextState)
  const [isContextModalOpen, setIsContextModalOpen] = useState(false)
  const chatComposerRef = useRef<ChatComposerHandle>(null)
  const codexLogRef = useRef<HTMLDivElement>(null)
  const shouldFollowCodexStreamRef = useRef(true)
  const isUserScrollingCodexRef = useRef(false)
  const codexScrollIntentResetRef = useRef<number | null>(null)
  const courseContextSignatureRef = useRef<string | null>(null)

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

  const refreshCourseContext = useCallback(async () => {
    const response = await fetch('/api/context')
    if (!response.ok) throw new Error(await response.text())
    applyCourseContextState(await response.json() as CourseContextState)
  }, [applyCourseContextState])

  useEffect(() => {
    fetch('/questions.json')
      .then((response) => response.json())
      .then((loadedBank: QuestionBank) => {
        setBank(loadedBank)

        const questionOverrideId = new URLSearchParams(window.location.search).get('question')
        if (!questionOverrideId) return

        const override = findQuestionOverride(loadedBank, questionOverrideId)
        if (!override) {
          setError(`Question not found: ${questionOverrideId}`)
          return
        }

        setSelectedSetId(override.setId)
        setCurrentId(override.unitId)
        setQuestionQueue([])
        setAnswersByQuestion({})
        setResult(null)
        setMessages([])
        setIsSubmittingAnswer(false)
        setCodexStatus('')
        clearStreamingTutorMessage()
        setStreamingMessageKind(null)
        setTutorSessionId(crypto.randomUUID())
        setError(null)
      })
      .catch((loadError) => setError(String(loadError)))
  }, [
    setAnswersByQuestion,
    setCurrentId,
    clearStreamingTutorMessage,
    setMessages,
    setQuestionQueue,
    setResult,
    setSelectedSetId,
    setTutorSessionId,
  ])

  useEffect(() => {
    let isCancelled = false
    fetch('/api/context')
      .then((response) => {
        if (!response.ok) return response.text().then((message) => Promise.reject(new Error(message)))
        return response.json()
      })
      .then((nextContext: CourseContextState) => {
        if (!isCancelled) applyCourseContextState(nextContext)
      })
      .catch((contextError) => {
        if (!isCancelled) setError(String(contextError))
      })
    return () => {
      isCancelled = true
    }
  }, [applyCourseContextState])

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

  const allSets = useMemo(() => {
    const baseSets = bank?.sets ?? []
    const allQuestions = baseSets.flatMap((set) => set.questions)
    const combinedSet: QuestionSet | null =
      allQuestions.length > 0
        ? {
            id: 'all-questions',
            title: 'All Questions',
            description: 'Practice and last year exam questions mixed together.',
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

  const startSet = useCallback((setId: string) => {
    setSelectedSetId(setId)
    const nextSet = allSets.find((set) => set.id === setId)
    resetQuestionState()
    if (!nextSet) return

    const initialDeck = buildInitialQuestionDeck(buildQuestionUnits(nextSet.questions))
    setCurrentId(initialDeck.currentId)
    setQuestionQueue(initialDeck.queue)
  }, [
    allSets,
    resetQuestionState,
    setCurrentId,
    setQuestionQueue,
    setSelectedSetId,
  ])

  const returnToMenu = useCallback(() => {
    setSelectedSetId(null)
    setCurrentId(null)
    setQuestionQueue([])
    resetQuestionState()
  }, [resetQuestionState, setCurrentId, setQuestionQueue, setSelectedSetId])

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
      nextProgress[question.id] = updateRecord(existing, tutorResponse.isCorrect, now)
    }
    setProgress(nextProgress)
    setHistory((items) => [
      {
        questionId: unit.id,
        title: `${unit.source}: ${unit.title}`,
        isCorrect: tutorResponse.isCorrect,
        answeredAt: now,
      },
      ...items,
    ])
  }, [progress, setHistory, setProgress])

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
    tutorSessionId,
  ])

  const uploadCourseContextFiles = useCallback(async (files: FileList | File[]) => {
    const selectedFiles = Array.from(files)
    if (selectedFiles.length === 0) return
    const formData = new FormData()
    for (const file of selectedFiles) formData.append('files', file)

    try {
      const response = await fetch('/api/context/files', {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) throw new Error(await response.text())
      applyCourseContextState(await response.json() as CourseContextState)
    } catch (uploadError) {
      setCourseContext({
        ...emptyCourseContextState,
        status: 'error',
        error: String(uploadError),
      })
    }
  }, [applyCourseContextState])

  const clearCourseContext = useCallback(async () => {
    const response = await fetch('/api/context', { method: 'DELETE' })
    if (!response.ok) throw new Error(await response.text())
    applyCourseContextState(await response.json() as CourseContextState)
    setIsContextModalOpen(false)
  }, [applyCourseContextState])

  if (!bank) {
    return (
      <main className="app-shell centered">
        <div className="loading-panel">Loading question bank...</div>
      </main>
    )
  }

  if (!activeSet || !currentUnit) {
    return (
      <main className="app-shell">
        <ExamMenu
          sets={allSets}
          onStart={startSet}
          error={error}
        />
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
        onReturnToMenu={returnToMenu}
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
        onSendChat={sendChat}
        onUploadContextFiles={uploadCourseContextFiles}
        result={result}
        resetKey={tutorSessionId}
        streamingMessageKind={streamingMessageKind}
        streamingTutorMessage={streamingTutorMessage}
      />
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
  onReturnToMenu,
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
  onReturnToMenu: () => void
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
          <button className="ghost-button" type="button" onClick={onReturnToMenu}>
            Menu
          </button>
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
  onSendChat: (input: string) => void | Promise<void>
  onUploadContextFiles: (files: FileList | File[]) => void | Promise<void>
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
  onSendChat,
  onUploadContextFiles,
  resetKey,
  result,
  streamingMessageKind,
  streamingTutorMessage,
}, ref) {
  const contextInputRef = useRef<HTMLInputElement>(null)
  const [markdownCopy, setMarkdownCopy] = useState<MarkdownCopyPopup | null>(null)
  const pendingMessage: TutorMessage | null = isGrading
    ? {
        role: 'tutor',
        content: streamingTutorMessage,
        kind: streamingMessageKind ?? 'pending',
      }
    : null
  const openContextPicker = useCallback(() => {
    contextInputRef.current?.click()
  }, [])
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
          <input
            ref={contextInputRef}
            className="context-file-input"
            type="file"
            accept=".pdf,.txt,.md,.csv,.json,.log,application/pdf,text/*"
            multiple
            onChange={(event) => {
              const { files } = event.currentTarget
              if (files?.length) void onUploadContextFiles(files)
              event.currentTarget.value = ''
            }}
          />
          <button
            className={`context-button context-${courseContext.status}`}
            type="button"
            disabled={courseContext.status === 'processing'}
            onClick={() => {
              if (courseContext.status === 'ready') onOpenContextModal()
              else openContextPicker()
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
        />
      )}
    </aside>
  )
}))

const ContextModal = memo(function ContextModal({
  context,
  onClear,
  onClose,
}: {
  context: CourseContextState
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
        className="context-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="context-modal-title"
      >
        <header className="context-modal-header">
          <div>
            <p className="eyebrow">Persistent Context</p>
            <h2 id="context-modal-title">{context.fileCount} files loaded</h2>
          </div>
          <button className="ghost-button" type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="context-modal-meta">
          <span>{context.generatedAt ? formatDateTime(context.generatedAt) : 'No generation timestamp'}</span>
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

        <pre className="context-prompt-preview">{context.injectedPrompt || 'No injected prompt is stored.'}</pre>

        <footer className="context-modal-actions">
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
      {result.verdict && <div className="grade-widget-verdict">{result.verdict}</div>}
      <div className="grade-widget-score">{Math.round(result.score * 100)}%</div>
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
  onToggleOption: (question: Question, optionId: string) => void
  onOpenAnswerChange: (questionId: string, text: string) => void
}) {
  const openAnswerTextareaRef = useRef<HTMLTextAreaElement>(null)
  const selectedOptionIds = answer.selectedOptionIds ?? []
  const correctOptionIds = revealedCorrectOptionIds.length > 0
    ? revealedCorrectOptionIds
    : getCorrectOptionIds(question)
  const hasKnownCorrectOptionIds = correctOptionIds.length > 0

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
      <MarkdownBlock className="question-prose">{question.prompt}</MarkdownBlock>
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

function ExamMenu({
  sets,
  onStart,
  error,
}: {
  sets: QuestionSet[]
  onStart: (id: string) => void
  error: string | null
}) {
  return (
    <section className="menu-screen">
      <div className="menu-heading">
        <h1>Exams</h1>
      </div>
      <div className="menu-grid">
        {sets.map((set) => (
          <button key={set.id} className="exam-tile" type="button" onClick={() => onStart(set.id)}>
            <span>{set.questions.length} questions</span>
            <strong>{set.title}</strong>
          </button>
        ))}
      </div>
      {error && <div className="error-box">{error}</div>}
    </section>
  )
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
  if (/^(https?:|data:|blob:|\/api\/file)/i.test(src)) return src
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

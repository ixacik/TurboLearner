import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
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

function appendToLastTutorMessage(messages: TutorMessage[], delta: string) {
  const next = [...messages]
  const last = next.at(-1)
  if (last?.role === 'tutor') {
    next[next.length - 1] = { ...last, content: last.content + delta }
  }
  return next
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
const codeLanguageAliases: Record<string, string> = {
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  tsx: 'tsx',
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
  )
  const [chatInput, setChatInput] = useState('')
  const [isGrading, setIsGrading] = useState(false)
  const [isSubmittingAnswer, setIsSubmittingAnswer] = useState(false)
  const [codexStatus, setCodexStatus] = useState('')
  const [codexSidebarWidth, setCodexSidebarWidth] = useLocalState(
    codexSidebarWidthKey,
    defaultCodexSidebarWidth,
  )
  const [isResizingSidebar, setIsResizingSidebar] = useState(false)
  const [streamingTutorMessage, setStreamingTutorMessage] = useState('')
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
  const chatTextareaRef = useRef<HTMLTextAreaElement>(null)
  const codexLogRef = useRef<HTMLDivElement>(null)
  const shouldFollowCodexStreamRef = useRef(true)
  const isUserScrollingCodexRef = useRef(false)
  const codexScrollIntentResetRef = useRef<number | null>(null)

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
        setChatInput('')
        setIsSubmittingAnswer(false)
        setCodexStatus('')
        setStreamingTutorMessage('')
        setTutorSessionId(crypto.randomUUID())
        setError(null)
      })
      .catch((loadError) => setError(String(loadError)))
  }, [
    setAnswersByQuestion,
    setCurrentId,
    setMessages,
    setQuestionQueue,
    setResult,
    setSelectedSetId,
    setTutorSessionId,
  ])

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

  const last25 = history.slice(0, 25)
  const correctLast25 = last25.filter((item) => item.isCorrect).length
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
    const textarea = chatTextareaRef.current
    if (!textarea) return

    autoGrowTextarea(textarea)
  }, [chatInput, result])

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
    setChatInput('')
    setIsSubmittingAnswer(false)
    setCodexStatus('')
    setStreamingTutorMessage('')
    setTutorSessionId(crypto.randomUUID())
    setOptionOrderSeed(crypto.randomUUID())
    setUsedLearningBeforeAnswer(false)
    setError(null)
  }, [
    followCodexStream,
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

  function startSet(setId: string) {
    setSelectedSetId(setId)
    const nextSet = allSets.find((set) => set.id === setId)
    resetQuestionState()
    if (!nextSet) return

    const initialDeck = buildInitialQuestionDeck(buildQuestionUnits(nextSet.questions))
    setCurrentId(initialDeck.currentId)
    setQuestionQueue(initialDeck.queue)
  }

  function returnToMenu() {
    setSelectedSetId(null)
    setCurrentId(null)
    setQuestionQueue([])
    resetQuestionState()
  }

  function toggleOption(question: Question, optionId: string) {
    if (result) return
    const existing = answersByQuestion[question.id]?.selectedOptionIds ?? []
    if (question.type === 'single') {
      setAnswersByQuestion((answers) => ({
        ...answers,
        [question.id]: { selectedOptionIds: [optionId] },
      }))
      return
    }
    const selectedOptionIds = existing.includes(optionId)
      ? existing.filter((id) => id !== optionId)
      : [...existing, optionId]
    setAnswersByQuestion((answers) => ({
      ...answers,
      [question.id]: { selectedOptionIds },
    }))
  }

  function updateOpenAnswer(questionId: string, text: string) {
    setAnswersByQuestion((answers) => ({
      ...answers,
      [questionId]: { text },
    }))
  }

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
    setStreamingTutorMessage('')
    setError(null)
    const previousMessages = persistedTutorMessages(messages)
    setMessages([...previousMessages, { role: 'tutor', content: '', kind: 'grading-pending' }])
    try {
      const tutorQuestion = buildTutorQuestion(currentUnit)
      const tutorResponse = await postTutorStream(
        '/api/explain',
        {
          sessionId: tutorSessionId,
          mode: 'submit',
          question: tutorQuestion,
          answer: buildTutorAnswerPayload(currentUnit, answersByQuestion),
          messages,
        },
        {
          onStatus: setCodexStatus,
          onDelta: (delta) => {
            setMessages((existing) => appendToLastTutorMessage(existing, delta))
          },
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
      setStreamingTutorMessage('')
    }
  }, [
    answersByQuestion,
    currentUnit,
    followCodexStream,
    isGrading,
    messages,
    recordAnswer,
    setIsAnswerKeyRevealed,
    setMessages,
    setRevealedCorrectOptionIdsByQuestion,
    setResult,
    tutorSessionId,
    revealedCorrectOptionIdsByQuestion,
    usedLearningBeforeAnswer,
  ])

  useEffect(() => {
    if (!currentUnit || !isAnswerKeyRevealed) return

    const latestAnswerMessage = [...messages]
      .reverse()
      .find((message) =>
        message.role === 'tutor' &&
        (message.kind === 'learning' || message.kind === 'grading') &&
        message.content.trim()
      )
    if (!latestAnswerMessage) return

    const inferredCorrectOptionIdsByQuestion = getResponseCorrectOptionIdsByQuestion(currentUnit, {
      isCorrect: false,
      score: 0,
      verdict: '',
      explanation: latestAnswerMessage.content,
      concepts: [],
      nextPrompt: '',
    })
    if (Object.keys(inferredCorrectOptionIdsByQuestion).length === 0) return

    const nextRevealedCorrectOptionIds = buildRevealedCorrectOptionIds(
      revealedCorrectOptionIdsByQuestion,
      inferredCorrectOptionIdsByQuestion,
    )
    if (nextRevealedCorrectOptionIds !== revealedCorrectOptionIdsByQuestion) {
      setRevealedCorrectOptionIdsByQuestion(nextRevealedCorrectOptionIds)
    }

  }, [
    currentUnit,
    isAnswerKeyRevealed,
    messages,
    revealedCorrectOptionIdsByQuestion,
    setRevealedCorrectOptionIdsByQuestion,
  ])

  const explainConceptBeforeAnswering = useCallback(async () => {
    if (!currentUnit || isGrading) return

    setIsGrading(true)
    followCodexStream()
    setCodexStatus('Teaching the concept...')
    setStreamingTutorMessage('')
    setError(null)
    const learningPrompt = [
      'I do not know this yet.',
      'Teach me the underlying concept from zero like a textbook, but do not answer this question for me.',
      'Do not reveal the correct option, eliminate options, give the final formula for this exact question, or make the answer immediately inferable.',
      'Leave me with desirable difficulty so I still have to reason and submit an answer myself.',
    ].join(' ')
    const previousMessages = persistedTutorMessages(messages)
    setMessages([
      ...previousMessages,
      { role: 'tutor', content: '', kind: 'learning-pending' },
    ])
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
          onDelta: (delta) => {
            setMessages((existing) => appendToLastTutorMessage(existing, delta))
          },
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
      setStreamingTutorMessage('')
    }
  }, [
    answersByQuestion,
    currentUnit,
    followCodexStream,
    isGrading,
    messages,
    setMessages,
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
        chatTextareaRef.current?.focus()
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

  async function sendChat() {
    if (!currentUnit || !chatInput.trim() || isGrading) return
    const nextMessages: TutorMessage[] = [
      ...persistedTutorMessages(messages),
      { role: 'learner', content: chatInput.trim() },
    ]
    followCodexStream()
    setMessages(nextMessages)
    setChatInput('')
    setIsGrading(true)
    setCodexStatus('Asking Codex...')
    try {
      const pendingMessages: TutorMessage[] = [
        ...nextMessages,
        { role: 'tutor', content: '', kind: 'pending' },
      ]
      setMessages(pendingMessages)
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
          onDelta: (delta) => {
            setMessages((existing) => appendToLastTutorMessage(existing, delta))
          },
          onFinal: (streamedResponse) => {
            setMessages([
              ...nextMessages,
              { role: 'tutor', content: streamedResponse.explanation },
            ])
          },
        },
      )
      setMessages([...nextMessages, { role: 'tutor', content: tutorResponse.explanation }])
    } catch (chatError) {
      setMessages(nextMessages)
      setError(String(chatError))
    } finally {
      setIsGrading(false)
      setCodexStatus('')
    }
  }

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
      <section className="trainer-panel">
        <header className="study-header">
          <div className="study-title">
            <button className="ghost-button" type="button" onClick={returnToMenu}>
              Menu
            </button>
            <div>
              <h1>{activeSet.title}</h1>
            </div>
          </div>
          <div className="study-metrics">
            <Stat label="Last 25" value={`${correctLast25}/${Math.max(25, last25.length || 25)}`} />
            <Stat label="Seen" value={String(Object.keys(progress).length)} />
          </div>
          <div className="history-strip" aria-label="Last 25 answers">
            {Array.from({ length: 25 }).map((_, index) => {
              const item = last25[index]
              return (
                <span
                  key={index}
                  className={`history-dot ${
                    item ? (item.isCorrect ? 'correct' : 'wrong') : ''
                  }`}
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
                  onToggleOption={toggleOption}
                  onOpenAnswerChange={updateOpenAnswer}
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
                onClick={() => showNextQuestion(!result.isCorrect)}
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
                  onClick={submitAnswer}
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
                    onClick={explainConceptBeforeAnswering}
                    disabled={isGrading}
                  >
                    I don&apos;t know
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => showNextQuestion()}
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

      <aside className={`codex-panel ${result?.isCorrect ? 'correct' : result ? 'wrong' : ''}`}>
        <div className="codex-header">
          <div>
            <p className="eyebrow">Codex</p>
            {result && <h2>{result.verdict}</h2>}
          </div>
          {result && <span>{Math.round(result.score * 100)}%</span>}
        </div>

        <div
          className="codex-log"
          ref={codexLogRef}
          onPointerDown={markCodexLogUserScroll}
          onScroll={handleCodexLogScroll}
          onTouchMove={markCodexLogUserScroll}
          onWheel={markCodexLogUserScroll}
        >
          {messages.map((message, index) => (
            <div
              key={index}
              className={`chat-message ${message.role} ${message.kind ? `message-${message.kind}` : ''}`}
            >
              {(message.kind === 'grading' ||
                message.kind === 'grading-pending' ||
                message.kind === 'learning' ||
                message.kind === 'learning-pending') && (
                <div className="graded-result-separator">
                  {message.kind === 'learning' || message.kind === 'learning-pending'
                    ? 'Learn from zero'
                    : 'Graded result'}
                </div>
              )}
              {message.content ? (
                <MarkdownBlock mode="chat">{message.content}</MarkdownBlock>
              ) : isGrading && (
                message.kind === 'pending' ||
                message.kind === 'grading-pending' ||
                message.kind === 'learning-pending'
              ) ? (
                codexStatus || 'Asking Codex...'
              ) : null}
            </div>
          ))}
          {isGrading && streamingTutorMessage && messages.length === 0 && (
            <section className="chat-message tutor">
              <MarkdownBlock mode="chat">{streamingTutorMessage}</MarkdownBlock>
            </section>
          )}
          {isGrading && !streamingTutorMessage && messages.length === 0 && (
            <div className="empty-chat">{codexStatus || 'Asking Codex...'}</div>
          )}
        </div>

        <div className="codex-compose">
          <form
            className="chat-row"
            onSubmit={(event) => {
              event.preventDefault()
              sendChat()
            }}
          >
            <textarea
              ref={chatTextareaRef}
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="Ask Codex about this question..."
              disabled={isGrading}
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
                sendChat()
              }}
            />
          </form>
        </div>
      </aside>
    </main>
  )
}

function QuestionPrompt({
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
}

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

function MarkdownBlock({
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
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          table(props) {
            return (
              <div className="markdown-table-wrap">
                <table {...props} />
              </div>
            )
          },
          code(props) {
            const { children: codeChildren, className } = props
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
              <code className={className}>
                {codeChildren}
              </code>
            )
          },
          img(props) {
            const { src, alt } = props
            return (
              <img
                src={resolveImageSource(src)}
                alt={alt || 'Question attachment'}
                loading="lazy"
              />
            )
          },
        }}
      >
        {markdown}
      </Markdown>
    </div>
  )
}

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
  const inferredCorrectOptionIds = keyedCorrectOptionIds?.length
    ? undefined
    : inferCorrectOptionIdsFromText(tutorChoiceQuestion, choiceQuestion, response.explanation)
  const correctOptionIds = keyedCorrectOptionIds?.length
    ? keyedCorrectOptionIds
    : inferredCorrectOptionIds

  return correctOptionIds?.length
    ? { [choiceQuestion.id]: correctOptionIds }
    : {}
}

function inferCorrectOptionIdsFromText(tutorQuestion: Question, sourceQuestion: Question, text: string) {
  if (!text.trim()) return undefined
  const optionIds = tutorQuestion.options.map((option) => option.id)
  if (optionIds.length === 0) return undefined

  const visibleLabelToOptionId = new Map(
    tutorQuestion.options
      .filter((option) => option.visibleLabel)
      .map((option) => [option.visibleLabel as string, option.id]),
  )
  const answerIds = visibleLabelToOptionId.size > 0
    ? [...visibleLabelToOptionId.keys()]
    : optionIds
  const escapedIds = answerIds.map(escapeRegExp).join('|')
  const answerPatterns = [
    new RegExp(`\\bcorrect (?:choices?|answers?|options?)\\s+(?:are|is)\\s+((?:${escapedIds})(?:\\s*(?:,|and|&)\\s*(?:${escapedIds}))*)`, 'i'),
    new RegExp(`\\b(?:correct|right|intended|inferred)?\\s*answer(?:\\s+from\\s+the\\s+concept)?\\s*(?:is|:)\\s*((?:${escapedIds})(?:\\s*(?:,|and|&)\\s*(?:${escapedIds}))*)`, 'i'),
    new RegExp(`\\bchoose\\s+((?:${escapedIds})(?:\\s*(?:,|and|&)\\s*(?:${escapedIds}))*)`, 'i'),
  ]

  for (const pattern of answerPatterns) {
    const match = text.match(pattern)
    if (!match) continue
    const ids = match[1].match(new RegExp(`\\b(?:${escapedIds})\\b`, 'gi')) ?? []
    const normalizedIds = ids
      .map((id) => resolveTutorResponseOptionId(id, tutorQuestion, sourceQuestion))
      .filter((id): id is string => Boolean(id))
    if (normalizedIds.length > 0) return uniqueStrings(normalizedIds)
  }

  const rightOptionPattern = new RegExp(
    `(?:^|\\n)\\s*(?:[-*]\\s*)?(?:\\*\\*)?(${escapedIds})(?:\\*\\*)?\\s*[:.)-]\\s*(?:\\*\\*)?(?:right|correct|true|best answer)\\b`,
    'gi',
  )
  const rightOptionIds = [...text.matchAll(rightOptionPattern)]
    .map((match) => resolveTutorResponseOptionId(match[1], tutorQuestion, sourceQuestion))
    .filter((id): id is string => Boolean(id))
  if (rightOptionIds.length > 0) return uniqueStrings(rightOptionIds)

  return undefined
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

function useLocalState<T>(
  key: string,
  initialValue: T,
  prepareForStorage: (value: T) => T = identity,
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
    localStorage.setItem(key, JSON.stringify(prepareForStorage(state)))
  }, [key, prepareForStorage, state])

  return [state, setState] as const
}

export default App

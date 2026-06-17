import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
}

function appendToLastTutorMessage(messages: TutorMessage[], delta: string) {
  const next = [...messages]
  const last = next.at(-1)
  if (last?.role === 'tutor') {
    next[next.length - 1] = { ...last, content: last.content + delta }
  }
  return next
}

const progressKey = 'turbolearner.progress.v1'
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
  const [selectedSetId, setSelectedSetId] = useState<string | null>(null)
  const [progress, setProgress] = useLocalState<Record<string, ProgressRecord>>(progressKey, {})
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [answersByQuestion, setAnswersByQuestion] = useState<Record<string, AnswerPayload>>({})
  const [result, setResult] = useState<TutorResponse | null>(null)
  const [messages, setMessages] = useState<TutorMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [isGrading, setIsGrading] = useState(false)
  const [codexStatus, setCodexStatus] = useState('')
  const [streamingTutorMessage, setStreamingTutorMessage] = useState('')
  const [tutorSessionId, setTutorSessionId] = useState(() => crypto.randomUUID())
  const [error, setError] = useState<string | null>(null)
  const recentIds = useRef<string[]>([])
  const chatTextareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    fetch('/questions.json')
      .then((response) => response.json())
      .then(setBank)
      .catch((loadError) => setError(String(loadError)))
  }, [])

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
    return activeSet.questions
  }, [activeSet])
  const units = useMemo(() => buildQuestionUnits(questions), [questions])
  const currentUnit = units.find((unit) => unit.id === currentId) ?? null

  const last25 = history.slice(0, 25)
  const correctLast25 = last25.filter((item) => item.isCorrect).length
  const canSubmitAnswer = currentUnit ? isUnitAnswered(currentUnit, answersByQuestion) : false

  useEffect(() => {
    const textarea = chatTextareaRef.current
    if (!textarea) return

    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`
  }, [chatInput, result])

  const resetQuestionState = useCallback(() => {
    setAnswersByQuestion({})
    setResult(null)
    setMessages([])
    setChatInput('')
    setCodexStatus('')
    setStreamingTutorMessage('')
    setTutorSessionId(crypto.randomUUID())
    setError(null)
  }, [])

  const showNextQuestion = useCallback((pool = units, records = progress) => {
    if (pool.length === 0) return
    const next = chooseNextUnit(pool, records, recentIds.current)
    recentIds.current = [next.id, ...recentIds.current.filter((id) => id !== next.id)].slice(0, 7)
    setCurrentId(next.id)
    resetQuestionState()
  }, [progress, resetQuestionState, units])

  function startSet(setId: string) {
    setSelectedSetId(setId)
    const nextSet = allSets.find((set) => set.id === setId)
    resetQuestionState()
    if (nextSet) showNextQuestion(buildQuestionUnits(nextSet.questions), progress)
  }

  function returnToMenu() {
    setSelectedSetId(null)
    setCurrentId(null)
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
  }, [progress, setProgress])

  const submitAnswer = useCallback(async () => {
    if (!currentUnit || isGrading) return
    const answer = buildAnswerPayload(currentUnit, answersByQuestion)
    if (!isUnitAnswered(currentUnit, answersByQuestion)) return

    setIsGrading(true)
    setCodexStatus('Asking Codex...')
    setStreamingTutorMessage('')
    setError(null)
    const previousMessages = messages
    setMessages([...previousMessages, { role: 'tutor', content: '' }])
    try {
      const tutorResponse = await postTutorStream(
        '/api/explain',
        {
          sessionId: tutorSessionId,
          mode: 'submit',
          question: buildTutorQuestion(currentUnit),
          answer,
          messages,
        },
        {
          onStatus: setCodexStatus,
          onDelta: (delta) => {
            setMessages((existing) => appendToLastTutorMessage(existing, delta))
          },
        },
      )
      setResult(tutorResponse)
      setMessages([...previousMessages, { role: 'tutor', content: tutorResponse.explanation }])
      recordAnswer(currentUnit, tutorResponse)
    } catch (submitError) {
      setMessages(previousMessages)
      setError(String(submitError))
    } finally {
      setIsGrading(false)
      setCodexStatus('')
      setStreamingTutorMessage('')
    }
  }, [answersByQuestion, currentUnit, isGrading, messages, recordAnswer, tutorSessionId])

  useEffect(() => {
    if (selectedSetId && units.length > 0 && !currentUnit) {
      showNextQuestion(units, progress)
    }
  }, [currentUnit, progress, selectedSetId, showNextQuestion, units])

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
        showNextQuestion()
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
      ...messages,
      { role: 'learner', content: chatInput.trim() },
    ]
    setMessages(nextMessages)
    setChatInput('')
    setIsGrading(true)
    setCodexStatus('Asking Codex...')
    try {
      const pendingMessages: TutorMessage[] = [...nextMessages, { role: 'tutor', content: '' }]
      setMessages(pendingMessages)
      const tutorResponse = await postTutorStream(
        '/api/explain',
        {
          sessionId: tutorSessionId,
          mode: 'chat',
          phase: result ? 'post_submit' : 'pre_submit',
          question: buildTutorQuestion(currentUnit),
          answer: buildAnswerPayload(currentUnit, answersByQuestion),
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
    <main className="app-shell">
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
            <Stat label="Mode" value="Infinite" />
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
                  disabled={Boolean(result)}
                  showHeading={currentUnit.questions.length > 1}
                  onToggleOption={toggleOption}
                  onOpenAnswerChange={updateOpenAnswer}
                />
              ))}
            </div>
          </article>
        </div>

        {!isGrading && (
          <div className="action-row">
            {result ? (
              <button
                className="primary-button"
                type="button"
                onClick={() => showNextQuestion()}
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
                  disabled={!canSubmitAnswer}
                  aria-keyshortcuts="Meta+Enter"
                  title="Command+Enter"
                >
                  Submit answer
                </button>
                <button className="secondary-button" type="button" onClick={() => showNextQuestion()}>
                  Skip / next
                </button>
              </>
            )}
          </div>
        )}

        {error && <div className="error-box">{error}</div>}
      </section>

      <aside className={`codex-panel ${result?.isCorrect ? 'correct' : result ? 'wrong' : ''}`}>
        <div className="codex-header">
          <div>
            <p className="eyebrow">Codex</p>
            {result && <h2>{result.verdict}</h2>}
          </div>
          {result && <span>{Math.round(result.score * 100)}%</span>}
        </div>

        <div className="codex-log">
          {messages.map((message, index) => (
            <div key={index} className={`chat-message ${message.role}`}>
              {message.content ? (
                <MarkdownBlock mode="chat">{message.content}</MarkdownBlock>
              ) : isGrading && message.role === 'tutor' ? (
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
              placeholder={result?.nextPrompt || 'Ask Codex about this question...'}
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
  showHeading,
  onToggleOption,
  onOpenAnswerChange,
}: {
  question: Question
  answer: AnswerPayload
  disabled: boolean
  showHeading: boolean
  onToggleOption: (question: Question, optionId: string) => void
  onOpenAnswerChange: (questionId: string, text: string) => void
}) {
  const selectedOptionIds = answer.selectedOptionIds ?? []

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
          className="answer-textarea"
          value={answer.text ?? ''}
          onChange={(event) => onOpenAnswerChange(question.id, event.target.value)}
          placeholder="Write a short exam-style answer..."
          disabled={disabled}
        />
      ) : (
        <div className="options-grid">
          {question.options.map((option) => (
            <label
              key={option.id}
              className={`option-button ${
                selectedOptionIds.includes(option.id) ? 'selected' : ''
              }`}
            >
              <input
                type={question.type === 'single' ? 'radio' : 'checkbox'}
                name={question.id}
                checked={selectedOptionIds.includes(option.id)}
                onChange={() => onToggleOption(question, option.id)}
                disabled={disabled}
              />
              <MarkdownBlock className="option-prose">{option.text}</MarkdownBlock>
            </label>
          ))}
        </div>
      )}
    </section>
  )
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
                    margin: '0 0 14px',
                    padding: '16px',
                    borderRadius: '6px',
                    background: 'var(--code-bg)',
                    fontSize: '0.95em',
                    lineHeight: 1.55,
                  }}
                  language={language}
                  PreTag="pre"
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

function buildTutorQuestion(unit: QuestionUnit) {
  if (unit.questions.length === 1) return unit.questions[0]

  return {
    id: unit.id,
    source: unit.source,
    title: unit.title,
    type: 'group',
    prompt: unit.sharedPrompt ?? '',
    concepts: unit.concepts,
    questions: unit.questions.map((question) => ({
      id: question.id,
      number: question.number,
      title: question.title,
      type: question.type,
      prompt: question.prompt,
      points: question.points,
      options: question.options,
      answer: question.answer,
      correctOptionIds: question.correctOptionIds,
      expectedAnswer: question.expectedAnswer,
      concepts: question.concepts,
    })),
  }
}

function buildAnswerPayload(
  unit: QuestionUnit,
  answersByQuestion: Record<string, AnswerPayload>,
): AnswerPayload | GroupAnswerPayload {
  if (unit.questions.length === 1) {
    return normalizeAnswer(unit.questions[0], answersByQuestion[unit.questions[0].id])
  }

  return {
    subAnswers: unit.questions.map((question) => ({
      questionId: question.id,
      number: question.number,
      type: question.type,
      ...normalizeAnswer(question, answersByQuestion[question.id]),
    })),
  }
}

function normalizeAnswer(question: Question, answer: AnswerPayload = {}) {
  if (question.type === 'open') return { text: (answer.text ?? '').trim() }
  return { selectedOptionIds: answer.selectedOptionIds ?? [] }
}

function isUnitAnswered(unit: QuestionUnit, answersByQuestion: Record<string, AnswerPayload>) {
  return unit.questions.every((question) => {
    const answer = normalizeAnswer(question, answersByQuestion[question.id])
    if (question.type === 'open') return Boolean(answer.text)
    return (answer.selectedOptionIds ?? []).length > 0
  })
}

function chooseNextUnit(
  units: QuestionUnit[],
  progress: Record<string, ProgressRecord>,
  recentIds: string[],
) {
  const now = Date.now()
  const due = units.filter((unit) =>
    unit.questions.some((question) => (progress[question.id]?.dueAt ?? 0) <= now),
  )
  const candidates = (due.length > 0 ? due : units).filter((unit) => !recentIds.includes(unit.id))
  const pool = candidates.length > 0 ? candidates : due.length > 0 ? due : units
  const weighted = pool.flatMap((unit) => {
    const weight = unit.questions.reduce((total, question) => {
      const record = progress[question.id]
      return total + (!record ? 4 : Math.max(1, 5 - record.streak + record.wrong * 2))
    }, 0)
    return Array.from({ length: Math.max(1, weight) }, () => unit)
  })
  return weighted[Math.floor(Math.random() * weighted.length)] ?? units[0]
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)]
}

function updateRecord(record: ProgressRecord, isCorrect: boolean, now: number) {
  const attempts = record.attempts + 1
  const streak = isCorrect ? record.streak + 1 : 0
  const ease = Math.min(2.5, Math.max(0.7, record.ease + (isCorrect ? 0.15 : -0.25)))
  const soon = 90 * 1000
  const intervals = [soon, 5 * 60 * 1000, 25 * 60 * 1000, 2 * 60 * 60 * 1000]
  const interval = isCorrect
    ? intervals[Math.min(streak, intervals.length - 1)] * ease
    : 45 * 1000

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

function useLocalState<T>(key: string, initialValue: T) {
  const [state, setState] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key)
      return stored ? (JSON.parse(stored) as T) : initialValue
    } catch {
      return initialValue
    }
  })

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(state))
  }, [key, state])

  return [state, setState] as const
}

export default App

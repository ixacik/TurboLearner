const latexBackslash = '\\'

const imageTagPattern = /<image>([\s\S]*?)<\/image>/gi
const mathTagPattern = /<math(?:\s+[^>]*)?>([\s\S]*?)<\/math>/gi
const htmlTagPattern = /<[^>]+>/g
const latexCommandPattern = /\\([A-Za-z]+)/g
const mathishPattern = /(?:[A-Z]\s*_\{|\\(?:sum|max|min|pi|gamma|alpha)|[γπα]\s*(?:\^|[A-Z])|\bsum_[a-z]\b|\bmax_[a-z]\b|\bmid\b|\bsmid\b|\bamid\b)/
const knownMathCommands = new Set([
  'alpha',
  'beta',
  'gamma',
  'delta',
  'epsilon',
  'pi',
  'theta',
  'lambda',
  'sigma',
  'rho',
  'infty',
  'mid',
  'max',
  'min',
  'sum',
])

const latexSpecialCharacters = new Map([
  [latexBackslash, `${latexBackslash}textbackslash{}`],
  ['&', `${latexBackslash}&`],
  ['%', `${latexBackslash}%`],
  ['$', `${latexBackslash}$`],
  ['#', `${latexBackslash}#`],
  ['_', `${latexBackslash}_`],
  ['{', `${latexBackslash}{`],
  ['}', `${latexBackslash}}`],
  ['~', `${latexBackslash}textasciitilde{}`],
  ['^', `${latexBackslash}textasciicircum{}`],
])

export function buildQuestionSetLatex({ set, topicName, resolveImagePath = () => null }) {
  const title = escapeLatexText(set?.title || 'Exam')
  const subtitle = escapeLatexText(topicName || '')
  const questions = Array.isArray(set?.questions) ? set.questions : []
  const lines = [
    `${latexBackslash}documentclass[11pt]{article}`,
    `${latexBackslash}usepackage[a4paper,margin=0.72in]{geometry}`,
    `${latexBackslash}usepackage{fontspec}`,
    `${latexBackslash}usepackage{unicode-math}`,
    `${latexBackslash}usepackage{graphicx}`,
    `${latexBackslash}usepackage{xcolor}`,
    `${latexBackslash}usepackage{array}`,
    `${latexBackslash}setmainfont{Arial Unicode MS}`,
    `${latexBackslash}setmathfont{STIX Two Math}`,
    `${latexBackslash}definecolor{rulegray}{HTML}{D7DCE2}`,
    `${latexBackslash}definecolor{textgray}{HTML}{4B5563}`,
    `${latexBackslash}setlength{${latexBackslash}parindent}{0pt}`,
    `${latexBackslash}setlength{${latexBackslash}parskip}{0.58em}`,
    `${latexBackslash}pagestyle{plain}`,
    `${latexBackslash}newcommand{${latexBackslash}examrule}{${latexBackslash}vspace{0.35em}${latexBackslash}textcolor{rulegray}{${latexBackslash}hrule}${latexBackslash}vspace{0.65em}}`,
    `${latexBackslash}newenvironment{choices}{${latexBackslash}begin{list}{}{${latexBackslash}setlength{${latexBackslash}leftmargin}{2.4em}${latexBackslash}setlength{${latexBackslash}labelwidth}{1.8em}${latexBackslash}setlength{${latexBackslash}labelsep}{0.45em}${latexBackslash}setlength{${latexBackslash}itemsep}{0.32em}${latexBackslash}setlength{${latexBackslash}parsep}{0pt}${latexBackslash}setlength{${latexBackslash}topsep}{0.25em}}}{${latexBackslash}end{list}}`,
    `${latexBackslash}begin{document}`,
    `${latexBackslash}begin{center}`,
    `{${latexBackslash}LARGE${latexBackslash}bfseries ${title}}${latexBackslash}par`,
    `${latexBackslash}vspace{0.25em}`,
    subtitle ? `{${latexBackslash}color{textgray}${subtitle}}${latexBackslash}par` : '',
    `${latexBackslash}end{center}`,
    `${latexBackslash}vspace{0.4em}`,
    `${latexBackslash}examrule`,
  ].filter(Boolean)

  questions.forEach((question, index) => {
    const number = question?.number || String(index + 1)
    if (index > 0 && questionHasImages(question)) lines.push(`${latexBackslash}newpage`)
    lines.push(`${latexBackslash}textbf{${latexBackslash}large Question ${escapeLatexText(number)}}`, '')

    for (const block of questionPromptBlocks(question)) {
      if (block.kind === 'text') {
        lines.push(paragraphize(textWithLatexMath(block.value)), '')
        continue
      }

      const resolvedPath = resolveImagePath(block.value)
      if (resolvedPath) lines.push(imageLatex(resolvedPath), '')
    }

    const options = Array.isArray(question?.options) ? question.options : []
    if (options.length > 0) {
      lines.push(`${latexBackslash}begin{choices}`)
      for (const option of options) {
        lines.push(`${latexBackslash}item[${latexBackslash}textbf{${escapeLatexText(option?.id || '')}.}] ${paragraphize(textWithLatexMath(option?.text || ''))}`)
      }
      lines.push(`${latexBackslash}end{choices}`, '')
    } else {
      lines.push(`${latexBackslash}vspace{1.2cm}`)
    }

    lines.push(`${latexBackslash}examrule`)
  })

  lines.push(
    `${latexBackslash}newpage`,
    `${latexBackslash}begin{center}`,
    `{${latexBackslash}LARGE${latexBackslash}bfseries Answer Key}${latexBackslash}par`,
    `${latexBackslash}end{center}`,
    `${latexBackslash}vspace{0.4em}`,
    `${latexBackslash}examrule`,
  )

  questions.forEach((question, index) => {
    const number = escapeLatexText(question?.number || String(index + 1))
    lines.push(`${latexBackslash}textbf{${number}.} ${answerLatex(question)}`, '')
  })

  lines.push(`${latexBackslash}end{document}`)
  return `${lines.join('\n')}\n`
}

export function sanitizePdfFileName(value) {
  const base = String(value || 'exam')
    .replace(/[/:*?"<>|\\]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'exam'
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`
}

function questionHasImages(question) {
  if (Array.isArray(question?.imagePaths) && question.imagePaths.length > 0) return true
  imageTagPattern.lastIndex = 0
  return imageTagPattern.test(String(question?.prompt || ''))
}

function questionPromptBlocks(question) {
  const prompt = String(question?.prompt || '')
  const blocks = []
  const seenImages = new Set()
  let lastIndex = 0

  imageTagPattern.lastIndex = 0
  for (const match of prompt.matchAll(imageTagPattern)) {
    const text = prompt.slice(lastIndex, match.index)
    if (text.trim()) blocks.push({ kind: 'text', value: text })
    const imagePath = String(match[1] || '').trim()
    if (imagePath) {
      seenImages.add(imagePath)
      blocks.push({ kind: 'image', value: imagePath })
    }
    lastIndex = (match.index ?? 0) + match[0].length
  }

  const tail = prompt.slice(lastIndex)
  if (tail.trim()) blocks.push({ kind: 'text', value: tail })

  for (const imagePath of Array.isArray(question?.imagePaths) ? question.imagePaths : []) {
    const normalizedPath = String(imagePath || '').trim()
    if (normalizedPath && !seenImages.has(normalizedPath)) {
      blocks.push({ kind: 'image', value: normalizedPath })
    }
  }

  return blocks
}

function answerLatex(question) {
  const correctOptionIds = question?.correctOptionIds ?? question?.answer?.correctOptionIds
  if (Array.isArray(correctOptionIds) && correctOptionIds.length > 0) {
    return correctOptionIds.map((optionId) => escapeLatexText(optionId)).join(', ')
  }
  const expectedText = question?.answer?.expectedText ?? question?.expectedAnswer ?? ''
  return paragraphize(textWithLatexMath(expectedText))
}

function imageLatex(imagePath) {
  return [
    `${latexBackslash}begin{center}`,
    `${latexBackslash}includegraphics[width=0.84${latexBackslash}linewidth,height=0.42${latexBackslash}textheight,keepaspectratio]{${latexBackslash}detokenize{${imagePath}}}`,
    `${latexBackslash}end{center}`,
  ].join('\n')
}

function textWithLatexMath(value) {
  const raw = String(value ?? '')
  if (!mathTagPattern.test(raw)) return maybeMathText(raw)
  mathTagPattern.lastIndex = 0

  const parts = []
  let lastIndex = 0
  for (const match of raw.matchAll(mathTagPattern)) {
    const before = stripImagesAndHtml(raw.slice(lastIndex, match.index))
    parts.push(escapeLatexText(before))
    parts.push(`${latexBackslash}(${normalizeMath(match[1])}${latexBackslash})`)
    lastIndex = (match.index ?? 0) + match[0].length
  }

  parts.push(escapeLatexText(stripImagesAndHtml(raw.slice(lastIndex))))
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim()
}

function maybeMathText(value) {
  const raw = stripImagesAndHtml(value).trim()
  if (mathishPattern.test(raw)) return `${latexBackslash}(${normalizeMath(raw)}${latexBackslash})`
  return escapeLatexText(raw)
}

function normalizeMath(value) {
  return decodeHtml(value)
    .trim()
    .replace(/−/g, '-')
    .replace(/∞/g, `${latexBackslash}infty`)
    .replace(/γ/g, `${latexBackslash}gamma`)
    .replace(/π/g, `${latexBackslash}pi`)
    .replace(/α/g, `${latexBackslash}alpha`)
    .replace(latexCommandPattern, (_match, command) => (
      knownMathCommands.has(command) ? `${latexBackslash}${command}` : `${latexBackslash}${command}`
    ))
    .replace(/\bmax_([A-Za-z])\b/g, (_match, variable) => `${latexBackslash}max_{${variable}}`)
    .replace(/\bmin_([A-Za-z])\b/g, (_match, variable) => `${latexBackslash}min_{${variable}}`)
    .replace(/\bsum_([A-Za-z])\b/g, (_match, variable) => `${latexBackslash}sum_{${variable}}`)
    .replace(/\bsmid\b/g, `${latexBackslash}mid`)
    .replace(/\bamid\b/g, `${latexBackslash}mid`)
    .replace(/\bmid\b/g, `${latexBackslash}mid`)
    .replace(/\\\\(alpha|beta|gamma|delta|epsilon|pi|theta|lambda|sigma|rho|infty|mid|max|min|sum)/g, '\\$1')
}

function paragraphize(value) {
  return String(value || '')
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .join('\n\n')
}

function stripImagesAndHtml(value) {
  return decodeHtml(String(value || '').replace(imageTagPattern, '').replace(htmlTagPattern, ''))
}

function escapeLatexText(value) {
  return decodeHtml(value)
    .replace(/−/g, '-')
    .replace(/–/g, '-')
    .replace(/—/g, '---')
    .split('')
    .map((character) => latexSpecialCharacters.get(character) ?? character)
    .join('')
}

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

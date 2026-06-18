const maxStyleQuestionsPerSet = 36
const maxCoverageAngles = 220

export function createExamGenerationPromptContext(baseBank) {
  const sets = Array.isArray(baseBank?.sets) ? baseBank.sets : []
  const realExamSets = sets.filter((set) => !isGeneratedQuestionSet(set))

  return {
    styleExamples: {
      schema: baseBank?.schema ?? null,
      sets: realExamSets.map(styleExampleSet),
      styleMetrics: styleMetrics(realExamSets),
    },
    coverageProfile: coverageProfile(sets),
  }
}

export function buildExamDraftGenerationPrompt({
  topicId = null,
  examId,
  examAssetDir,
  usableFiles,
  failedFiles,
  promptContext,
}) {
  const extractionNotes = extractionNotesText(failedFiles)
  const imageUrlPrefix = imageUrlPrefixFor(topicId, examId)

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
- Every question must follow schema version 2 from the real exam examples.
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
- Include grouped questions where the real exam style supports them.
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
- For grouped questions, put a visual in groupPrompt when it applies to the whole group; do not repeat that same <image> in child prompts.
- Only put an image in a child prompt when it is specific to that subquestion and not already shown in the groupPrompt.

Priority order:
1. Cover selected lecture material that is unseen or underrepresented in the coverage profile.
2. Count both real exams and generated exams as already-covered practice when choosing topics and angles.
3. Use only real exams for vibe: phrasing, grouping, point values, difficulty, type mix, and answer style.
4. Do not imitate generated exams' style, phrasing, structure, option patterns, or question construction.
5. Do not create pure spinoffs of existing questions. If an important concept repeats, test a genuinely different lecture angle.

Quality requirements:
- Match the real exams' style, phrasing, grouping, point values, and difficulty.
- Infer exam length and type mix from real style examples only.
- Cover the selected lecture material broadly without adding topics not evidenced by lectures.
- Repeating important concepts is allowed only when the angle is fresh and useful for spaced practice.
- Do not clone the same surface scenario, code bug, diagram concept, numeric setup, or option pattern from any existing question.
- Code questions should vary the implementation mistakes they test; do not repeatedly use the same precision/recall/F1 bug unless the lecture material makes that repetition necessary.
- Before finalizing each question, check whether it is testing a new angle or merely rewording an existing example; replace it if it is merely a rewording.
- Include math/code tags using TurboLearner syntax when useful.

Extraction notes:
${extractionNotes}

Real exam style examples:
${JSON.stringify(promptContext.styleExamples, null, 2)}

Coverage history from all prior exams:
${JSON.stringify(promptContext.coverageProfile, null, 2)}

Selected lecture text:
${lectureTextBlock(usableFiles)}
`.trim()
}

export function buildExamReviewPrompt({
  topicId = null,
  examId,
  examAssetDir,
  usableFiles,
  failedFiles,
  promptContext,
  draftSet,
}) {
  const extractionNotes = extractionNotesText(failedFiles)
  const imageUrlPrefix = imageUrlPrefixFor(topicId, examId)

  return `
Review and repair this draft TurboLearner exam. Return the corrected final exam JSON.

Exam id to use exactly: ${examId}
Asset directory for any generated PNG/JPEG images: ${examAssetDir}
Image URL prefix for generated images: ${imageUrlPrefix}

You are the second-pass exam editor. The first pass generated a draft. Your job is to fix it, not to comment on it.

Output contract:
- Return exactly one JSON object for the final TurboLearner question set, not review notes.
- Put the final JSON inside a fenced \`\`\`json block.
- Preserve id "${examId}" for the set and setId "${examId}" on every question.
- Use source "Generated Exam" and answer.source "inferred".
- Preserve valid generated image references when the question remains valid.
- If you introduce a new image question, generate/copy a PNG/JPEG into the asset directory and reference it as <image>${imageUrlPrefix}filename.png</image>.
- Do not output SVG.
- For grouped questions, keep shared visuals only in groupPrompt and remove duplicate child-level <image> tags.
- Use child-level images only when that visual is specific to one subquestion and not already shown in groupPrompt.
- Final JSON must pass the same schema rules as the draft generation prompt.

Review rubric:
- Replace or rewrite questions that are near-duplicates of any prior real or generated question.
- Remove pure spinoffs that keep the same scenario, wording, code bug, diagram setup, numeric setup, or option pattern.
- Fix obvious answers, weak distractors, answer-length tells, malformed rubrics, shallow prompts, unsupported lecture claims, and inconsistent answer keys.
- Substitute new questions from the selected lecture material when a question is too duplicated or too low quality.
- Keep the same real-exam vibe: difficulty, phrasing, grouping, point values, type mix, and answer style.
- Generated prior exams are coverage history only. Do not copy their style or structure.
- Prefer unseen and underrepresented lecture material after accounting for all prior exams.
- Do not add topics that are not evidenced by the selected lecture text.
- Preserve grouping and type mix when possible, but quality and non-duplication are higher priority.

Extraction notes:
${extractionNotes}

Draft exam JSON:
${JSON.stringify(draftSet, null, 2)}

Real exam style examples:
${JSON.stringify(promptContext.styleExamples, null, 2)}

Coverage history from all prior exams:
${JSON.stringify(promptContext.coverageProfile, null, 2)}

Selected lecture text:
${lectureTextBlock(usableFiles)}
`.trim()
}

function styleExampleSet(set) {
  const questions = Array.isArray(set?.questions) ? set.questions : []
  return {
    id: set.id,
    title: set.title,
    description: set.description,
    questionCount: questions.length,
    typeCounts: countBy(questions.map((question) => question?.type || 'unknown')),
    pointValues: uniqueNumbers(questions.map((question) => question?.points)).slice(0, 12),
    groupedQuestionCount: questions.filter((question) => question?.groupId).length,
    questions: questions.slice(0, maxStyleQuestionsPerSet).map(styleExampleQuestion),
  }
}

function styleExampleQuestion(question) {
  return {
    number: question?.number,
    title: question?.title,
    type: question?.type,
    points: question?.points,
    prompt: question?.prompt,
    groupTitle: question?.groupTitle,
    groupPrompt: question?.groupPrompt,
    optionCount: Array.isArray(question?.options) ? question.options.length : 0,
    options: Array.isArray(question?.options)
      ? question.options.map((option) => ({ id: option?.id, text: option?.text }))
      : [],
    answerShape: answerShape(question),
    concepts: Array.isArray(question?.concepts) ? question.concepts : [],
  }
}

function coverageProfile(sets) {
  const allQuestions = sets.flatMap((set) =>
    (Array.isArray(set?.questions) ? set.questions : []).map((question) => ({ set, question })),
  )
  const concepts = allQuestions.flatMap(({ question }) =>
    Array.isArray(question?.concepts) ? question.concepts.filter(Boolean) : [],
  )
  const conceptCounts = sortedCounts(concepts)

  return {
    setCount: sets.length,
    questionCount: allQuestions.length,
    sets: sets.map(coverageSetSummary),
    conceptCounts,
    typeCounts: sortedCounts(allQuestions.map(({ question }) => question?.type || 'unknown')),
    overrepresentedConcepts: Object.fromEntries(Object.entries(conceptCounts).slice(0, 12)),
    angleSignatures: allQuestions.slice(0, maxCoverageAngles).map(({ set, question }) => coverageAngle(set, question)),
  }
}

function coverageSetSummary(set) {
  const questions = Array.isArray(set?.questions) ? set.questions : []
  return {
    id: set.id,
    title: set.title,
    sourceRole: isGeneratedQuestionSet(set) ? 'coverage-only-generated' : 'real-style-and-coverage',
    questionCount: questions.length,
    typeCounts: sortedCounts(questions.map((question) => question?.type || 'unknown')),
    conceptCounts: sortedCounts(questions.flatMap((question) => (
      Array.isArray(question?.concepts) ? question.concepts.filter(Boolean) : []
    ))),
  }
}

function coverageAngle(set, question) {
  return {
    setId: set?.id,
    questionId: question?.id,
    sourceRole: isGeneratedQuestionSet(set) ? 'coverage-only-generated' : 'real-style-and-coverage',
    type: question?.type,
    concepts: Array.isArray(question?.concepts) ? question.concepts : [],
    hasCode: /<code\b/i.test(`${question?.prompt ?? ''}\n${question?.groupPrompt ?? ''}`),
    imageCount: [
      ...extractImageTags(question?.prompt),
      ...extractImageTags(question?.groupPrompt),
      ...(Array.isArray(question?.imagePaths) ? question.imagePaths : []),
    ].length,
    optionPattern: optionPattern(question),
    signature: textSignature([
      question?.groupTitle,
      question?.groupPrompt,
      question?.title,
      question?.prompt,
      ...(Array.isArray(question?.options) ? question.options.map((option) => option?.text) : []),
    ].filter(Boolean).join(' ')),
  }
}

function styleMetrics(sets) {
  const questions = sets.flatMap((set) => Array.isArray(set?.questions) ? set.questions : [])
  return {
    realExamCount: sets.length,
    questionCounts: sets.map((set) => Array.isArray(set?.questions) ? set.questions.length : 0),
    typeCounts: sortedCounts(questions.map((question) => question?.type || 'unknown')),
    optionCountsByType: optionCountsByType(questions),
    groupedQuestionCount: questions.filter((question) => question?.groupId).length,
    pointValues: uniqueNumbers(questions.map((question) => question?.points)).slice(0, 12),
  }
}

function optionCountsByType(questions) {
  const counts = {}
  for (const question of questions) {
    const type = question?.type || 'unknown'
    const optionCount = Array.isArray(question?.options) ? question.options.length : 0
    counts[type] ??= {}
    counts[type][optionCount] = (counts[type][optionCount] ?? 0) + 1
  }
  return counts
}

function answerShape(question) {
  if (question?.type === 'open') {
    return {
      expectedText: typeof question?.answer?.expectedText === 'string' && question.answer.expectedText.trim()
        ? 'present'
        : 'missing',
    }
  }
  return {
    correctOptionCount: Array.isArray(question?.answer?.correctOptionIds)
      ? question.answer.correctOptionIds.length
      : Array.isArray(question?.correctOptionIds)
        ? question.correctOptionIds.length
        : 0,
  }
}

function optionPattern(question) {
  if (!Array.isArray(question?.options) || question.options.length === 0) return 'none'
  return question.options
    .map((option) => textSignature(option?.text ?? '').split(' ').slice(0, 8).join(' '))
    .join(' | ')
    .slice(0, 320)
}

function textSignature(text) {
  return String(text ?? '')
    .replace(/<image>[\s\S]*?<\/image>/gi, ' image ')
    .replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, ' code ')
    .replace(/<math\b[^>]*>[\s\S]*?<\/math>/gi, ' math ')
    .replace(/<[^>]+>/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 42)
    .join(' ')
}

function isGeneratedQuestionSet(set) {
  const id = String(set?.id ?? '')
  const sourceType = String(set?.sourceType ?? set?.source_type ?? '')
  const sourcePath = String(set?.sourcePath ?? set?.source_path ?? '')
  return (
    sourceType === 'generated' ||
    /^generated-/i.test(id) ||
    /generated-(exams|assets)/i.test(sourcePath)
  )
}

function countBy(values) {
  return values.reduce((counts, value) => {
    const key = String(value || 'unknown')
    counts[key] = (counts[key] ?? 0) + 1
    return counts
  }, {})
}

function sortedCounts(values) {
  return Object.fromEntries(
    Object.entries(countBy(values))
      .sort(([, countA], [, countB]) => countB - countA),
  )
}

function uniqueNumbers(values) {
  return [...new Set(values.map(Number).filter(Number.isFinite))].sort((a, b) => a - b)
}

function extractionNotesText(failedFiles) {
  return Array.isArray(failedFiles) && failedFiles.length > 0
    ? failedFiles.map((file) => `- ${file.name}: ${file.error}`).join('\n')
    : 'none'
}

function imageUrlPrefixFor(topicId, examId) {
  return topicId
    ? `/api/generated-assets/${topicId}/${examId}/`
    : `/api/generated-assets/${examId}/`
}

function lectureTextBlock(usableFiles) {
  return usableFiles.map((file) => `
--- BEGIN FILE: ${file.name} ---
${file.text}
--- END FILE: ${file.name} ---
`).join('\n')
}

function extractImageTags(markup) {
  const paths = []
  String(markup ?? '').replace(/<image>([\s\S]*?)<\/image>/gi, (_, rawPath) => {
    const imagePath = String(rawPath).trim()
    if (imagePath) paths.push(imagePath)
    return ''
  })
  return paths
}

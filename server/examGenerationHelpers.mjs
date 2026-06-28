const maxStyleQuestionsPerSet = 36
const maxCoverageAngles = 220
const predictableMultiSelectDominanceRatio = 0.75
const predictableMultiSelectMinCount = 3
const feedbackQuestionReferenceLimit = 14

export function createExamGenerationPromptContext(baseBank) {
  const sets = Array.isArray(baseBank?.sets) ? baseBank.sets : []
  const realExamSets = sets.filter((set) => !isGeneratedQuestionSet(set))
  const generatedExamSets = sets.filter((set) => isGeneratedQuestionSet(set))

  return {
    styleExamples: {
      schema: baseBank?.schema ?? null,
      sets: realExamSets.map(styleExampleSet),
      styleMetrics: styleMetrics(realExamSets),
    },
    realExamCoverageProfile: coverageProfile(realExamSets),
    generatedDuplicateHistory: duplicateHistory(generatedExamSets),
    courseContext: normalizeCourseContext(baseBank?.courseContext),
    courseSections: courseContextSections(baseBank?.courseContext),
  }
}

export function buildExamDraftGenerationPrompt({
  topicId = null,
  examId,
  examAssetDir,
  outputPath = null,
  sourceManifest = null,
  usableFiles,
  failedFiles,
  promptContext,
  codeExampleFiles = [],
  steeringPrompt = '',
}) {
  const extractionNotes = extractionNotesText(failedFiles)
  const imageUrlPrefix = imageUrlPrefixFor(topicId, examId)
  const steeringBlock = examSteeringPromptBlock(steeringPrompt)

  return `
Generate one new TurboLearner exam question set.

Exam id to use exactly: ${examId}
Asset directory for any generated PNG/JPEG images: ${examAssetDir}
Image URL prefix for generated images: ${imageUrlPrefix}

Output contract:
- Write exactly one TurboLearner question set JSON object, not a full bank.
- Save the JSON file here: ${outputPath || 'return the JSON in your final response'}.
- If an output path is provided, create or overwrite that file yourself and keep your final chat response brief.
- Before writing questions, create a lightweight internal coverage plan: slot, course section, depth, type, and search terms. Use it to guide the final JSON, but do not include the plan as a separate output artifact.
- If internal source search is available, use it for every question and include sourceEvidence metadata in the JSON.

${steeringBlock}

${sharedExamQuestionSetGuidelines({ examId, imageUrlPrefix })}

Extraction notes:
${extractionNotes}

Real exam style examples:
${JSON.stringify(promptContext.styleExamples, null, 2)}

Real exam coverage profile:
${JSON.stringify(promptContext.realExamCoverageProfile, null, 2)}

Course context coverage map:
${courseContextPromptBlock(promptContext)}

Course source manifest:
${sourceMaterialBlock({ sourceManifest, usableFiles, codeExampleFiles })}
`.trim()
}

export function buildExamReviewPrompt({
  topicId = null,
  examId,
  examAssetDir,
  outputPath = null,
  draftPath = null,
  sourceManifest = null,
  usableFiles,
  failedFiles,
  promptContext,
  codeExampleFiles = [],
  draftSet,
  programmaticFeedback = null,
  steeringPrompt = '',
}) {
  const extractionNotes = extractionNotesText(failedFiles)
  const imageUrlPrefix = imageUrlPrefixFor(topicId, examId)
  const draftAudit = String(programmaticFeedback || '').trim() || 'No programmatic draft audit was provided.'
  const steeringBlock = examSteeringPromptBlock(steeringPrompt)

  return `
Review and repair this draft TurboLearner exam. Return the corrected final exam JSON.

Exam id to use exactly: ${examId}
Asset directory for any generated PNG/JPEG images: ${examAssetDir}
Image URL prefix for generated images: ${imageUrlPrefix}

You are the second-pass exam editor. The first pass generated a draft. Your job is to fix it, not to comment on it.

Output contract:
- Write exactly one final TurboLearner question set JSON object, not review notes.
- Save the corrected JSON file here: ${outputPath || 'return the JSON in your final response'}.
- If an output path is provided, create or overwrite that file yourself and keep your final chat response brief.
- Preserve id "${examId}" for the set and setId "${examId}" on every question.
- Preserve valid generated image references when the question remains valid.
- If you introduce a new image question, generate/copy a PNG/JPEG into the asset directory and reference it as <image>${imageUrlPrefix}filename.png</image>.
- Final JSON must pass every shared guideline below.
- Resolve every blocking issue in the Programmatic draft audit before writing final JSON. These checks run again after review.
- Preserve or repair courseSection, sourceSearchTerms, and sourceEvidence metadata for every question.

${steeringBlock}

${sharedExamQuestionSetGuidelines({ examId, imageUrlPrefix })}

Programmatic draft audit:
${draftAudit}

Review rubric:
- Treat the Programmatic draft audit as concrete failing feedback from the app; repair every blocking issue it lists before finalizing.
- Replace or rewrite questions that are near-duplicates of any prior real or generated question.
- Remove pure spinoffs that keep the same scenario, wording, code bug, diagram setup, numeric setup, or option pattern.
- Fix multi-select questions where no options are correct, and avoid making the number of correct options predictable across the set.
- Replace questions that ask what happened in the lecture, what was shown in the lecture, or what matches a lecture derivation/example.
- Reject lecture-memorization trivia: slide-specific examples, exact classroom walkthroughs, toy numbers, professor phrasing, or derivation steps unless real exams clearly test that exact math depth.
- Fix obvious answers, weak distractors, answer-length tells, malformed rubrics, shallow prompts, unsupported lecture claims, and inconsistent answer keys.
- Fix weak choice options by making every distractor a plausible same-topic misconception and removing obvious length, specificity, or extreme-wording tells.
- Substitute new questions from the selected source material when a question is too duplicated or too low quality.
- Keep the same real-exam vibe: difficulty, phrasing, grouping, point values, type mix, and answer style.
- Generated prior exams are not source material, style material, or coverage inspiration. Use only programmatic duplicate warnings about them.
- Prefer major course-context sections that are underrepresented in this draft, then ground replacements with internal source search.
- Do not add topics that are not evidenced by the provided course sources.
- Preserve grouping and type mix when possible, but quality and non-duplication are higher priority.

Extraction notes:
${extractionNotes}

Draft exam JSON:
${draftPath ? `Read the draft JSON from: ${draftPath}` : JSON.stringify(draftSet, null, 2)}

Real exam style examples:
${JSON.stringify(promptContext.styleExamples, null, 2)}

Real exam coverage profile:
${JSON.stringify(promptContext.realExamCoverageProfile, null, 2)}

Course context coverage map:
${courseContextPromptBlock(promptContext)}

Course source manifest:
${sourceMaterialBlock({ sourceManifest, usableFiles, codeExampleFiles })}
`.trim()
}

function examSteeringPromptBlock(steeringPrompt) {
  const text = String(steeringPrompt || '').trim()
  if (!text) return ''
  return `
User exam steering prompt:
Treat the following learner instructions as high-priority direction for this generated exam's focus, style, difficulty, phrasing, and option construction, unless they conflict with the output contract, schema validity, source grounding, image asset requirements, or duplicate-avoidance rules.

${text}
`.trim()
}

function sharedExamQuestionSetGuidelines({ examId, imageUrlPrefix }) {
  return `
Shared question-set guidelines:
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
- Multi-select questions may have any number of correct options from exactly one through all options.
- All-correct and single-correct multi-select questions are valid when the prompt naturally asks the learner to evaluate every option.
- Across a generated set, avoid making the number of correct options predictable.
- For single/multiple questions, answer.correctOptionIds must contain canonical option ids.
- Include correctOptionIds legacy mirror for choice questions.
- Avoid making correct answers longer, more specific, or stylistically different than distractors.
- Make questions non-trivial, course-grounded, and hard to guess.
- Choice options must be balanced: use plausible same-topic distractors, avoid absurd extremes, and avoid cue words such as "always", "never", "none", "every", "exhaustive", "guarantees", "replaces", or "impossible" unless all options are similarly balanced.
- Hard MCQs should use near-miss options that differ by small technical details. Normal MCQs may be more direct, but their options should still be roughly equal in specificity, length, and plausibility.
- Include grouped questions where the real exam style supports them.
- Include code examples and image-based questions where course material supports them.

Shared course-code requirements:
- Treat uploaded source text as the primary authority for concepts and coverage.
- Use uploaded course code examples only to match programming languages, APIs, style, difficulty, implementation mistakes, and assignment scope.
- Prefer adapting code-question patterns from uploaded code examples when possible.
- Do not invent unrelated programming domains, libraries, APIs, or tasks that are absent from uploaded source text and uploaded code examples.
- Do not copy full assignment solutions verbatim; write fresh exam questions using the same scope and idioms.
- If no code examples are provided, avoid forced code questions unless the source text clearly supports code-level assessment.

Shared image requirements:
- Do not output SVG.
- If a question needs a diagram/chart/graph, use the built-in imagegen skill / image_gen tool to create a polished raster PNG/JPEG.
- Do not use Matplotlib for generated exam images unless imagegen is unavailable and the question would otherwise have to be dropped.
- After imagegen creates an image under $CODEX_HOME/generated_images, copy the selected output into the asset directory.
- Use local shell commands only to create directories, copy imagegen output, inspect files, and verify that referenced PNG/JPEG assets exist.
- Reference images in prompts as <image>${imageUrlPrefix}filename.png</image>.
- Include the same URL in imagePaths.
- Filenames must not reveal the answer.
- For grouped questions, put a visual in groupPrompt when it applies to the whole group; do not repeat that same <image> in child prompts, and remove duplicate child-level <image> tags.
- Only put an image in a child prompt when it is specific to that subquestion and not already shown in the groupPrompt.

Shared priority order:
1. Use the course context coverage map to cover major testable course sections without forcing weak trivia.
2. Use internal source search results as the grounding evidence for each question.
3. Use only real exams for vibe: phrasing, grouping, point values, difficulty, type mix, and answer style.
4. Do not imitate generated exams' style, phrasing, structure, option patterns, or question construction; generated exams are duplicate-check history only.
5. Do not create pure spinoffs of existing questions. If an important concept repeats, test a genuinely different lecture angle.

Shared concept-understanding requirements:
- Test broad concept understanding, model behavior, tradeoffs, recognition, interpretation, and application.
- Do not ask what happened in the lecture, what was shown in the lecture, or which mapping/derivation/example "matches the lecture derivation".
- Do not require memorizing lecture-specific examples, slide-specific derivation steps, classroom walkthroughs, toy numbers, or professor phrasing.
- Source text is evidence for course scope and depth, not source material for trivia about the source itself.
- Only include formula manipulation, derivations, or exact feature mappings when real exam examples clearly use that same level of mathematical specificity.
- Prefer asking what a concept means or how it applies over asking the learner to reproduce an exact lecture artifact.

Shared quality requirements:
- Match the real exams' style, phrasing, grouping, point values, and difficulty.
- Infer exam length and type mix from real style examples only.
- Cover the selected source material broadly without adding topics not evidenced by sources.
- Include courseSection, sourceSearchTerms, and sourceEvidence on every generated question when internal source search is available.
- Repeating important concepts is allowed only when the angle is fresh and useful for spaced practice.
- Do not clone the same surface scenario, code bug, diagram concept, numeric setup, or option pattern from any existing question.
- Code questions should vary the implementation mistakes they test; do not repeatedly use the same precision/recall/F1 bug unless the source material makes that repetition necessary.
- Before finalizing each question, check whether it is testing a new angle or merely rewording an existing example; replace it if it is merely a rewording.
- Include math/code tags using TurboLearner syntax when useful.
`.trim()
}

export function assertGeneratedChoiceAnswerDistribution({ questionId, type, options, correctOptionIds }) {
  if (type !== 'multiple') return

  if (correctOptionIds.length < 1 || correctOptionIds.length > options.length) {
    throw new Error(`${questionId} has an invalid multi-select answer count.`)
  }
}

export function assertGeneratedMultiSelectAnswerVariety(questions) {
  const stats = generatedMultiSelectAnswerStats(questions)

  if (!stats.isPredictable) return

  throw new Error(
    `Generated multi-select answer counts are too predictable: ${stats.dominantCount}/${stats.total} use ${stats.dominantPattern} correct options.`,
  )
}

export function buildGeneratedExamProgrammaticFeedback(questionSet, auditContext = {}) {
  const questions = Array.isArray(questionSet) ? questionSet : (
    Array.isArray(questionSet?.questions) ? questionSet.questions : []
  )
  const issues = []
  const stats = generatedMultiSelectAnswerStats(questions)
  const typeCounts = sortedCounts(questions.map((question) => question?.type || 'unknown'))
  const contentSignals = generatedQuestionContentSignals(questions)
  const sourceEvidenceAudit = generatedSourceEvidenceAudit(questions, auditContext)
  const sectionAudit = generatedCourseSectionAudit(questions, auditContext)
  const duplicateAudit = generatedDuplicateAudit(questions, auditContext)

  if (questions.length === 0) {
    issues.push({
      code: 'empty-question-set',
      message: 'Draft contains no questions.',
      detail: 'The reviewer must produce a complete TurboLearner question set JSON object with questions.',
    })
  }

  if (stats.invalidAnswerCounts.length > 0) {
    issues.push({
      code: 'invalid-multi-select-answer-counts',
      message: `${stats.invalidAnswerCounts.length} multi-select question${stats.invalidAnswerCounts.length === 1 ? '' : 's'} have invalid answer counts.`,
      detail: `Multi-selects must have at least one correct option and no more correct options than available choices. Affected questions: ${formatQuestionReferences(stats.invalidAnswerCounts)}.`,
    })
  }

  if (stats.unknownCorrectOptionQuestions.length > 0) {
    issues.push({
      code: 'unknown-correct-option-ids',
      message: `${stats.unknownCorrectOptionQuestions.length} multi-select question${stats.unknownCorrectOptionQuestions.length === 1 ? '' : 's'} reference correct option ids that are not present in their options.`,
      detail: `Fix answer.correctOptionIds so every id exists in options. Affected questions: ${formatQuestionReferences(stats.unknownCorrectOptionQuestions)}.`,
    })
  }

  if (stats.isPredictable) {
    issues.push({
      code: 'predictable-multi-select-answer-counts',
      message: `Generated multi-select answer counts are too predictable: ${stats.dominantCount}/${stats.total} use ${stats.dominantPattern} correct options.`,
      detail: `Affected ${stats.dominantPattern} questions: ${formatQuestionReferences(stats.dominantQuestions)}. Rewrite enough prompts, options, answer keys, or question types so the final multi-select answer-count distribution is mixed. Do not randomly flip answers; preserve course-grounded correctness.`,
    })
  }

  if (sourceEvidenceAudit.missingEvidence.length > 0) {
    issues.push({
      code: 'missing-source-evidence',
      message: `${sourceEvidenceAudit.missingEvidence.length} question${sourceEvidenceAudit.missingEvidence.length === 1 ? '' : 's'} lack internal-search source evidence.`,
      detail: `Every question must include sourceEvidence from the internal search tool plus sourceSearchTerms. Affected questions: ${formatQuestionReferences(sourceEvidenceAudit.missingEvidence)}.`,
    })
  }

  if (sectionAudit.missingCourseSection.length > 0) {
    issues.push({
      code: 'missing-course-section',
      message: `${sectionAudit.missingCourseSection.length} question${sectionAudit.missingCourseSection.length === 1 ? '' : 's'} lack courseSection metadata.`,
      detail: `Every question must declare the course context section it covers. Affected questions: ${formatQuestionReferences(sectionAudit.missingCourseSection)}.`,
    })
  }

  if (sectionAudit.tooManyMissingSections) {
    issues.push({
      code: 'course-section-coverage-gap',
      message: `${sectionAudit.missingSectionTitles.length}/${sectionAudit.expectedSectionTitles.length} course context sections are absent from the draft.`,
      detail: `Missing sections include: ${sectionAudit.missingSectionTitles.slice(0, 10).join('; ')}. Use the course context map to cover major testable sections, merging low-yield sections into stronger questions when needed.`,
    })
  }

  if (sectionAudit.overConcentratedSections.length > 0) {
    issues.push({
      code: 'course-section-overconcentration',
      message: `Too many questions concentrate in ${sectionAudit.overConcentratedSections.map((entry) => `"${entry.section}" (${entry.count})`).join(', ')}.`,
      detail: `Redistribute questions across course context sections while preserving real-exam style and source grounding.`,
    })
  }

  if (duplicateAudit.matches.length > 0) {
    issues.push({
      code: 'generated-history-near-duplicates',
      message: `${duplicateAudit.matches.length} question${duplicateAudit.matches.length === 1 ? '' : 's'} are too similar to prior generated exams.`,
      detail: `Replace these angles without using generated exams as inspiration: ${duplicateAudit.matches.slice(0, feedbackQuestionReferenceLimit).map((match) => `${match.reference} similarity ${match.score.toFixed(2)} to prior generated history`).join(', ')}.`,
    })
  }

  const lines = [
    issues.length > 0
      ? `Blocking issues detected (${issues.length}):`
      : 'No blocking programmatic issues detected.',
    ...issues.flatMap((issue) => [`- ${issue.message}`, `  ${issue.detail}`]),
    `Question type counts: ${formatCountMap(typeCounts)}.`,
    `Content signals: ${contentSignals.codeQuestionCount} code question(s), ${contentSignals.imageQuestionCount} image/graph question(s), ${contentSignals.groupedQuestionCount} grouped child question(s).`,
    `Course section counts: ${formatCountMap(sectionAudit.sectionCounts)}.`,
    `Missing source evidence: ${sourceEvidenceAudit.missingEvidence.length}.`,
    stats.total > 0
      ? `Multi-select answer-count distribution: ${formatCountMap(stats.counts)}.`
      : 'Multi-select answer-count distribution: none.',
  ]

  return {
    hasIssues: issues.length > 0,
    issues,
    text: lines.join('\n'),
  }
}

function generatedSourceEvidenceAudit(questions, auditContext) {
  const requireEvidence = Boolean(auditContext?.requireSourceEvidence || auditContext?.sourceAccessMode === 'internal-search-only')
  const missingEvidence = requireEvidence
    ? (Array.isArray(questions) ? questions : []).filter((question) => (
      !Array.isArray(question?.sourceEvidence) ||
      question.sourceEvidence.length === 0 ||
      !Array.isArray(question?.sourceSearchTerms) ||
      question.sourceSearchTerms.length === 0
    )).map((question) => ({
      ...question,
      reference: questionReference(question),
    }))
    : []

  return { missingEvidence }
}

function generatedCourseSectionAudit(questions, auditContext) {
  const safeQuestions = Array.isArray(questions) ? questions : []
  const expectedSectionTitles = (Array.isArray(auditContext?.courseSections) ? auditContext.courseSections : [])
    .map((section) => String(section?.title || '').trim())
    .filter(Boolean)
  const normalizedExpected = new Map(expectedSectionTitles.map((title) => [normalizeSectionTitle(title), title]))
  const sectionCounts = sortedCounts(safeQuestions.map((question) => (
    String(question?.courseSection || '').trim() || 'missing'
  )))
  const missingCourseSection = expectedSectionTitles.length > 0
    ? safeQuestions.filter((question) => !String(question?.courseSection || '').trim()).map((question) => ({
      ...question,
      reference: questionReference(question),
    }))
    : []
  const represented = new Set(
    safeQuestions
      .map((question) => normalizeSectionTitle(question?.courseSection))
      .filter(Boolean),
  )
  const missingSectionTitles = [...normalizedExpected.entries()]
    .filter(([normalized]) => !represented.has(normalized))
    .map(([, title]) => title)
  const tooManyMissingSections = Boolean(
    expectedSectionTitles.length >= 4 &&
    safeQuestions.length >= expectedSectionTitles.length &&
    missingSectionTitles.length > Math.ceil(expectedSectionTitles.length * 0.4)
  )
  const maxSectionCount = Math.max(6, Math.ceil(safeQuestions.length * 0.25))
  const overConcentratedSections = safeQuestions.length >= 12
    ? Object.entries(sectionCounts)
      .filter(([section, count]) => section !== 'missing' && count > maxSectionCount)
      .map(([section, count]) => ({ section, count }))
    : []

  return {
    sectionCounts,
    expectedSectionTitles,
    missingCourseSection,
    missingSectionTitles,
    tooManyMissingSections,
    overConcentratedSections,
  }
}

function generatedDuplicateAudit(questions, auditContext) {
  const history = Array.isArray(auditContext?.generatedDuplicateHistory) ? auditContext.generatedDuplicateHistory : []
  if (history.length === 0) return { matches: [] }
  const matches = []
  for (const question of Array.isArray(questions) ? questions : []) {
    const signature = textSignature([
      question?.groupTitle,
      question?.groupPrompt,
      question?.title,
      question?.prompt,
      ...(Array.isArray(question?.options) ? question.options.map((option) => option?.text) : []),
    ].filter(Boolean).join(' '))
    if (!signature) continue
    const best = history
      .map((candidate) => ({
        candidate,
        score: signatureSimilarity(signature, candidate.signature),
      }))
      .sort((a, b) => b.score - a.score)[0]
    if (best && best.score >= 0.72) {
      matches.push({
        reference: questionReference(question),
        score: best.score,
        priorSetId: best.candidate.setId,
        priorQuestionId: best.candidate.questionId,
      })
    }
  }
  return { matches }
}

function generatedMultiSelectAnswerStats(questions) {
  const multiSelects = (Array.isArray(questions) ? questions : [])
    .filter((question) => question?.type === 'multiple')
    .map((question) => {
      const options = Array.isArray(question?.options) ? question.options : []
      const optionIds = new Set(options.map((option, index) => {
        const explicitId = String(option?.id ?? '').trim()
        return explicitId || String.fromCharCode(65 + index)
      }))
      const correctOptionIds = generatedCorrectOptionIds(question)
      const unknownCorrectOptionIds = correctOptionIds.filter((id) => !optionIds.has(id))
      const correctCount = correctOptionIds.length
      const optionCount = options.length
      return {
        id: question?.id || question?.number || 'multi-select question',
        number: question?.number,
        title: question?.title,
        reference: questionReference(question),
        optionCount,
        correctCount,
        correctOptionIds,
        unknownCorrectOptionIds,
        pattern: `${correctCount}/${optionCount}`,
      }
    })

  const counts = sortedCounts(multiSelects.map((question) => question.pattern))
  const [dominantPattern, dominantCount = 0] = Object.entries(counts)[0] ?? []
  const dominanceRatio = multiSelects.length > 0 ? dominantCount / multiSelects.length : 0
  const dominantQuestions = dominantPattern
    ? multiSelects.filter((question) => question.pattern === dominantPattern)
    : []

  return {
    total: multiSelects.length,
    multiSelects,
    counts,
    dominantPattern,
    dominantCount,
    dominanceRatio,
    dominantQuestions,
    invalidAnswerCounts: multiSelects.filter((question) => (
      question.correctCount < 1 || question.correctCount > question.optionCount
    )),
    unknownCorrectOptionQuestions: multiSelects.filter((question) => question.unknownCorrectOptionIds.length > 0),
    isPredictable: Boolean(
      multiSelects.length >= predictableMultiSelectMinCount &&
      dominantPattern &&
      dominantCount >= predictableMultiSelectMinCount &&
      dominanceRatio >= predictableMultiSelectDominanceRatio
    ),
  }
}

function generatedCorrectOptionIds(question) {
  const rawCorrectIds = Array.isArray(question?.answer?.correctOptionIds)
    ? question.answer.correctOptionIds
    : Array.isArray(question?.correctOptionIds)
      ? question.correctOptionIds
      : []
  return rawCorrectIds.map((id) => String(id))
}

function generatedQuestionContentSignals(questions) {
  const safeQuestions = Array.isArray(questions) ? questions : []
  return {
    codeQuestionCount: safeQuestions.filter((question) => (
      /<code\b/i.test(`${question?.prompt ?? ''}\n${question?.groupPrompt ?? ''}`)
    )).length,
    imageQuestionCount: safeQuestions.filter((question) => (
      extractImageTags(question?.prompt).length > 0 ||
      extractImageTags(question?.groupPrompt).length > 0 ||
      (Array.isArray(question?.imagePaths) && question.imagePaths.length > 0)
    )).length,
    groupedQuestionCount: safeQuestions.filter((question) => question?.groupId).length,
  }
}

function questionReference(question) {
  const number = String(question?.number ?? '').trim()
  const id = String(question?.id ?? '').trim()
  const title = String(question?.title ?? '').trim()
  const label = [
    number ? `#${number}` : '',
    id || '',
  ].filter(Boolean).join(' ')
  const fallback = label || title || 'multi-select question'
  return title && title !== id
    ? `${fallback} "${title.slice(0, 80)}"`
    : fallback
}

function formatQuestionReferences(questions) {
  const refs = questions.slice(0, feedbackQuestionReferenceLimit).map((question) => question.reference || questionReference(question))
  const extraCount = questions.length - refs.length
  return `${refs.join(', ')}${extraCount > 0 ? `, and ${extraCount} more` : ''}`
}

function formatCountMap(counts) {
  const entries = Object.entries(counts || {})
  return entries.length > 0
    ? entries.map(([key, count]) => `${key}: ${count}`).join(', ')
    : 'none'
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

function duplicateHistory(sets) {
  return sets.flatMap((set) => (
    Array.isArray(set?.questions) ? set.questions : []
  ).map((question) => ({
    setId: set.id,
    questionId: question?.id,
    type: question?.type,
    concepts: Array.isArray(question?.concepts) ? question.concepts : [],
    signature: textSignature([
      question?.groupTitle,
      question?.groupPrompt,
      question?.title,
      question?.prompt,
      ...(Array.isArray(question?.options) ? question.options.map((option) => option?.text) : []),
    ].filter(Boolean).join(' ')),
  }))).filter((entry) => entry.signature)
}

function normalizeCourseContext(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function courseContextSections(value) {
  const text = normalizeCourseContext(value)
  if (!text) return []
  const lines = text.split('\n')
  const sections = []
  let current = null

  for (const line of lines) {
    const heading = /^(#{2,4})\s+(.+?)\s*$/.exec(line)
    if (heading && heading[1].length === 3) {
      if (current) sections.push(trimCourseSection(current))
      current = { title: heading[2].trim(), lines: [] }
      continue
    }
    if (current) current.lines.push(line)
  }
  if (current) sections.push(trimCourseSection(current))
  return sections.filter((section) => section.title && section.text)
}

function trimCourseSection(section) {
  return {
    title: section.title,
    text: section.lines.join('\n').trim().slice(0, 2200),
  }
}

function courseContextPromptBlock(promptContext) {
  const contextText = normalizeCourseContext(promptContext?.courseContext)
  const sections = Array.isArray(promptContext?.courseSections) ? promptContext.courseSections : []
  if (!contextText && sections.length === 0) return 'No persistent course context is available. Use retrieved source evidence conservatively.'
  return [
    contextText,
    '',
    'Parsed course sections:',
    JSON.stringify(sections.map((section) => section.title), null, 2),
  ].filter(Boolean).join('\n')
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
    codeSignature: codeSignature(`${question?.prompt ?? ''}\n${question?.groupPrompt ?? ''}`),
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

function normalizeSectionTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function signatureSimilarity(a, b) {
  const aTokens = new Set(String(a || '').split(/\s+/).filter(Boolean))
  const bTokens = new Set(String(b || '').split(/\s+/).filter(Boolean))
  if (aTokens.size < 4 || bTokens.size < 4) return 0
  let intersection = 0
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1
  }
  const union = new Set([...aTokens, ...bTokens]).size
  const jaccard = union > 0 ? intersection / union : 0
  const containment = intersection / Math.min(aTokens.size, bTokens.size)
  return Math.max(jaccard, containment * 0.9)
}

function codeSignature(text) {
  const snippets = [...String(text ?? '').matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/gi)]
    .map((match) => match[1])
    .join('\n')
  if (!snippets.trim()) return ''
  return snippets
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, ' string ')
    .replace(/\b\d+(?:\.\d+)?\b/g, ' number ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 420)
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

function sourceMaterialBlock({ sourceManifest, usableFiles, codeExampleFiles }) {
  if (sourceManifest) {
    if (sourceManifest.sourceAccessMode === 'internal-search-only') {
      return `${JSON.stringify(sourceManifest, null, 2)}

Internal source access rules:
- The internal search command is the ONLY allowed way to inspect course source material.
- The search pattern is ALWAYS a JavaScript regular expression, not literal text search.
- Use the command template from internalSearch.commandTemplate and replace <regex> with a precise regex pattern.
- Express boundaries yourself. For example, use "Dyna\\s" or "Dyna " for Dyna followed by whitespace, "Q\\(s,\\s*a\\)" for Q(s,a), and "Monte\\s+Carlo|TD\\(0\\)" for alternatives.
- Spaces inside quotes are preserved, including trailing spaces in patterns such as "Dyna ".
- --limit is the maximum number of matching source snippets to display; if at least that many matches exist, that many SOURCE entries will be shown.
- Search output is a compact sampled evidence blob when there are more matches than the limit; rerun or vary focused terms to gather additional support.
- Do not read, cat, sed, head, tail, grep, rg, awk, Python-read, pdftotext, or otherwise inspect files under source-material, sources, extracted, or context-source-material.
- Do not inspect raw PDFs, extracted text files, or copied source archives directly.
- Every generated question must include courseSection, sourceSearchTerms, and sourceEvidence based on internal search results. sourceSearchTerms must list the exact regex patterns used. Prefer source/page/note evidence from the search blob; line numbers are optional.
- If internal search returns weak evidence for a planned standalone question, revise the plan or merge that section into a stronger testable question.`
    }

    return `${JSON.stringify(sourceManifest, null, 2)}

Use these paths directly. You are a coding agent with filesystem access:
- Inspect the listed lecture files and assignment folders yourself with shell commands.
- For PDFs, use local tools such as pdftotext when useful; do not ask for pasted PDF text.
- Read only the portions needed to ground the exam.
- Use assignment folders/code examples to match languages, APIs, helper names, style, difficulty, and bug patterns.
- Do not invent unrelated programming domains, libraries, or APIs that are absent from these sources.
- Do not copy full assignment solutions verbatim; write fresh exam questions using the same scope and idioms.`
  }

  return [
    'Selected source text:',
    lectureTextBlock(usableFiles || []),
    '',
    'Course code examples and assignment scope:',
    codeExampleBlock(codeExampleFiles || []),
  ].join('\n')
}

function codeExampleBlock(codeExampleFiles) {
  if (!Array.isArray(codeExampleFiles) || codeExampleFiles.length === 0) {
    return 'none'
  }

  return codeExampleFiles.map((file) => `
--- BEGIN CODE EXAMPLE: ${file.name} ---
${file.text}
--- END CODE EXAMPLE: ${file.name} ---
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

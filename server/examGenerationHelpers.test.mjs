import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildExamDraftGenerationPrompt,
  buildExamReviewPrompt,
  createExamGenerationPromptContext,
} from './examGenerationHelpers.mjs'

const baseBank = {
  schema: { version: 2 },
  sets: [
    {
      id: 'practice-exam',
      title: 'Practice Exam',
      sourceType: 'static',
      description: 'Real exam.',
      questions: [
        question({
          id: 'practice-exam-q1',
          prompt: 'Which metric is best for imbalanced binary classification?',
          concepts: ['metrics'],
        }),
      ],
    },
    {
      id: 'generated-20260618131230-c6923755',
      title: 'Generated ML Exam',
      sourceType: 'generated',
      description: 'Generated exam.',
      questions: [
        question({
          id: 'generated-q1',
          prompt: 'A generated prompt about kernelized classifiers.',
          concepts: ['kernels'],
        }),
      ],
    },
  ],
}

test('style examples include real exams but exclude generated exams', () => {
  const context = createExamGenerationPromptContext(baseBank)

  assert.deepEqual(
    context.styleExamples.sets.map((set) => set.id),
    ['practice-exam'],
  )
  assert.equal(context.styleExamples.styleMetrics.realExamCount, 1)
})

test('coverage history includes generated exams', () => {
  const context = createExamGenerationPromptContext(baseBank)

  assert.deepEqual(
    context.coverageProfile.sets.map((set) => [set.id, set.sourceRole]),
    [
      ['practice-exam', 'real-style-and-coverage'],
      ['generated-20260618131230-c6923755', 'coverage-only-generated'],
    ],
  )
  assert.equal(context.coverageProfile.conceptCounts.metrics, 1)
  assert.equal(context.coverageProfile.conceptCounts.kernels, 1)
})

test('draft and review prompts distinguish style examples from coverage history', () => {
  const promptContext = createExamGenerationPromptContext(baseBank)
  const commonArgs = {
    topicId: 'machine-learning',
    examId: 'generated-test',
    examAssetDir: '/tmp/generated-test',
    usableFiles: [{ name: 'lecture.md', text: 'Metrics, kernels, and SVM lecture notes.' }],
    failedFiles: [],
    promptContext,
  }

  const draftPrompt = buildExamDraftGenerationPrompt(commonArgs)
  const reviewPrompt = buildExamReviewPrompt({
    ...commonArgs,
    draftSet: {
      id: 'generated-test',
      title: 'Generated Exam',
      description: 'Draft.',
      sourcePath: '',
      questions: [question({ id: 'generated-test-q1', prompt: 'Draft question.' })],
    },
  })

  assert.match(draftPrompt, /Real exam style examples:/)
  assert.match(draftPrompt, /Coverage history from all prior exams:/)
  assert.match(draftPrompt, /Generated prior exams are coverage history only|Do not imitate generated exams' style/)
  assert.match(draftPrompt, /do not repeat that same <image> in child prompts/)
  assert.match(reviewPrompt, /Review and repair this draft TurboLearner exam/)
  assert.match(reviewPrompt, /Draft exam JSON:/)
  assert.match(reviewPrompt, /remove duplicate child-level <image> tags/)
})

function question(overrides = {}) {
  return {
    id: 'q1',
    setId: 'set',
    source: 'Exam',
    number: '1',
    title: 'Question 1',
    type: 'single',
    prompt: 'Question prompt.',
    options: [
      { id: 'A', text: 'Option A' },
      { id: 'B', text: 'Option B' },
      { id: 'C', text: 'Option C' },
      { id: 'D', text: 'Option D' },
    ],
    answer: { correctOptionIds: ['A'], expectedText: null, source: 'inferred' },
    concepts: [],
    ...overrides,
  }
}

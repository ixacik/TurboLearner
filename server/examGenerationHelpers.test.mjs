import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  assertGeneratedChoiceAnswerDistribution,
  assertGeneratedMultiSelectAnswerVariety,
  buildExamDraftGenerationPrompt,
  buildExamReviewPrompt,
  buildGeneratedExamProgrammaticFeedback,
  createExamGenerationPromptContext,
} from './examGenerationHelpers.mjs'
import {
  extractNotebookText,
  extractSourceFile,
  formatCodeText,
  isTopicContextSource,
  normalizeSourceKind,
  publicSourceFromRow,
  shouldSkipFolderSource,
} from './sourceExtraction.mjs'

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
    outputPath: '/tmp/generated-test/draft-question-set.json',
    sourceManifest: {
      root: '/tmp/generated-test/source-material',
      lectureFiles: [{ name: 'lecture.md', path: '/tmp/generated-test/source-material/lectures/lecture.md' }],
      assignmentFolders: [{ name: 'assignments', path: '/tmp/generated-test/source-material/folders/assignments', files: [] }],
      codeFiles: [],
    },
    failedFiles: [],
    promptContext,
  }

  const draftPrompt = buildExamDraftGenerationPrompt(commonArgs)
  const reviewPrompt = buildExamReviewPrompt({
    ...commonArgs,
    outputPath: '/tmp/generated-test/final-question-set.json',
    draftPath: '/tmp/generated-test/draft-question-set.json',
    draftSet: {
      id: 'generated-test',
      title: 'Generated Exam',
      description: 'Draft.',
      sourcePath: '',
      questions: [question({ id: 'generated-test-q1', prompt: 'Draft question.' })],
    },
    programmaticFeedback: [
      'Blocking issues detected (1):',
      '- Generated multi-select answer counts are too predictable: 4/4 use 3/4 correct options.',
    ].join('\n'),
  })

  assert.match(draftPrompt, /Real exam style examples:/)
  assert.match(draftPrompt, /Coverage history from all prior exams:/)
  assert.match(draftPrompt, /Course source manifest:/)
  assert.match(draftPrompt, /\/tmp\/generated-test\/source-material\/lectures\/lecture\.md/)
  assert.match(draftPrompt, /Save the JSON file here: \/tmp\/generated-test\/draft-question-set\.json/)
  assert.match(draftPrompt, /Do not invent unrelated programming domains, libraries, or APIs/)
  assert.doesNotMatch(draftPrompt, /Metrics, kernels, and SVM lecture notes/)
  assert.doesNotMatch(draftPrompt, /BEGIN CODE EXAMPLE/)
  assert.match(draftPrompt, /Shared question-set guidelines:/)
  assert.match(reviewPrompt, /Shared question-set guidelines:/)
  assert.match(draftPrompt, /Generated prior exams are coverage history only|Do not imitate generated exams' style/)
  assert.match(draftPrompt, /Multi-select questions may have any number of correct options from exactly one through all options/)
  assert.match(draftPrompt, /All-correct and single-correct multi-select questions are valid/)
  assert.doesNotMatch(draftPrompt, /at least one incorrect option/)
  assert.doesNotMatch(draftPrompt, /consider making it a single-choice question/)
  assert.match(draftPrompt, /do not repeat that same <image> in child prompts/)
  assert.match(draftPrompt, /Do not ask what happened in the lecture/)
  assert.match(draftPrompt, /Only include formula manipulation, derivations, or exact feature mappings when real exam examples clearly use that same level/)
  assert.match(reviewPrompt, /Review and repair this draft TurboLearner exam/)
  assert.match(reviewPrompt, /Programmatic draft audit:/)
  assert.match(reviewPrompt, /Generated multi-select answer counts are too predictable: 4\/4 use 3\/4 correct options/)
  assert.match(reviewPrompt, /These checks run again after review/)
  assert.match(reviewPrompt, /Draft exam JSON:/)
  assert.match(reviewPrompt, /Read the draft JSON from: \/tmp\/generated-test\/draft-question-set\.json/)
  assert.match(reviewPrompt, /Save the corrected JSON file here: \/tmp\/generated-test\/final-question-set\.json/)
  assert.match(reviewPrompt, /Course source manifest:/)
  assert.match(reviewPrompt, /Do not copy full assignment solutions verbatim/)
  assert.match(reviewPrompt, /Do not ask what happened in the lecture/)
  assert.match(reviewPrompt, /Only include formula manipulation, derivations, or exact feature mappings when real exam examples clearly use that same level/)
  assert.match(reviewPrompt, /remove duplicate child-level <image> tags/)
  assert.match(reviewPrompt, /Fix multi-select questions where no options are correct/)
  assert.doesNotMatch(reviewPrompt, /where all options are correct or no options are correct/)
  assert.match(reviewPrompt, /Replace questions that ask what happened in the lecture/)
  assert.match(reviewPrompt, /Reject lecture-memorization trivia/)
})

test('draft prompt falls back to text mode when no source manifest is provided', () => {
  const prompt = buildExamDraftGenerationPrompt({
    topicId: 'machine-learning',
    examId: 'generated-test',
    examAssetDir: '/tmp/generated-test',
    usableFiles: [{ name: 'lecture.md', text: 'Lecture text.' }],
    failedFiles: [],
    codeExampleFiles: [],
    promptContext: createExamGenerationPromptContext(baseBank),
  })

  assert.match(prompt, /Course code examples and assignment scope:\nnone/)
  assert.match(prompt, /If no code examples are provided, avoid forced code questions/)
})

test('notebook extraction preserves markdown and code cells but skips outputs', () => {
  const text = extractNotebookText(JSON.stringify({
    cells: [
      { cell_type: 'markdown', source: ['# Assignment note\n', 'Use sklearn-style arrays.'] },
      {
        cell_type: 'code',
        source: ['def train(x):\n', '    return x\n'],
        outputs: [{ text: 'secret output that should not appear' }],
      },
      { cell_type: 'raw', source: ['ignored raw cell'] },
    ],
  }), {
    originalName: 'scope.ipynb',
    relativePath: 'assignments/scope.ipynb',
  })

  assert.match(text, /Path: assignments\/scope\.ipynb/)
  assert.match(text, /Language: jupyter-notebook/)
  assert.match(text, /markdown cell 1/)
  assert.match(text, /code cell 2/)
  assert.match(text, /def train/)
  assert.doesNotMatch(text, /secret output/)
  assert.doesNotMatch(text, /ignored raw cell/)
})

test('code extraction adds path and language headers', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'turbolearner-source-'))
  const filePath = path.join(tmpDir, 'model.py')
  await fs.writeFile(filePath, 'def score(y_true, y_pred):\n    return 1\n', 'utf8')

  const extracted = await extractSourceFile({
    originalName: 'model.py',
    relativePath: 'assignments/hw2/model.py',
    path: filePath,
    extension: '.py',
  })

  assert.equal(extracted.error, null)
  assert.match(extracted.text, /^Path: assignments\/hw2\/model\.py\nLanguage: python/)
  assert.match(extracted.text, /def score/)
})

test('folder noise is skipped only for folder uploads', () => {
  assert.equal(shouldSkipFolderSource('project/node_modules/pkg/index.js', '.js'), true)
  assert.equal(shouldSkipFolderSource('project/dist/app.js', '.js'), true)
  assert.equal(shouldSkipFolderSource('project/package-lock.json', '.json'), true)
  assert.equal(shouldSkipFolderSource('package-lock.json', '.json'), false)
  assert.equal(shouldSkipFolderSource('project/src/model.py', '.py'), false)
  assert.equal(shouldSkipFolderSource('project/image.png', '.png'), true)
})

test('source kind defaults to lecture unless explicitly code-example', () => {
  assert.equal(normalizeSourceKind('code-example'), 'code-example')
  assert.equal(normalizeSourceKind('lecture'), 'lecture')
  assert.equal(normalizeSourceKind('folder'), 'lecture')
  assert.match(formatCodeText('console.log(1)', {
    originalName: 'app.js',
    relativePath: 'examples/app.js',
    extension: '.js',
  }), /Language: javascript/)
})

test('topic context sources are only non-code PDF, TXT, and MD files', () => {
  assert.equal(isTopicContextSource({ extension: '.pdf', sourceKind: 'lecture' }), true)
  assert.equal(isTopicContextSource({ extension: '.txt', sourceKind: 'lecture' }), true)
  assert.equal(isTopicContextSource({ extension: '.md', sourceKind: 'lecture' }), true)
  assert.equal(isTopicContextSource({ extension: '.md', sourceKind: 'code-example' }), false)
  assert.equal(isTopicContextSource({ extension: '.py', sourceKind: 'code-example' }), false)
  assert.equal(isTopicContextSource({ extension: '.json', sourceKind: 'lecture' }), false)
})

test('public source serialization includes kind and relative path', () => {
  assert.deepEqual(publicSourceFromRow({
    id: 'source-1',
    original_name: 'model.py',
    source_kind: 'code-example',
    relative_path: 'assignments/hw1/model.py',
    size: 128,
    extension: '.py',
    extraction_status: 'ready',
    extraction_error: null,
    created_at: '2026-06-19T00:00:00.000Z',
    updated_at: '2026-06-19T00:00:00.000Z',
  }), {
    id: 'source-1',
    name: 'model.py',
    sourceKind: 'code-example',
    relativePath: 'assignments/hw1/model.py',
    size: 128,
    extension: '.py',
    extractionStatus: 'ready',
    extractionError: null,
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
  })
})

test('multi-select validation allows single-correct and all-correct generated questions', () => {
  const options = [
    { id: 'A', text: 'A' },
    { id: 'B', text: 'B' },
    { id: 'C', text: 'C' },
    { id: 'D', text: 'D' },
  ]

  assert.doesNotThrow(() => assertGeneratedChoiceAnswerDistribution({
    questionId: 'generated-q1',
    type: 'multiple',
    options,
    correctOptionIds: ['A'],
  }))
  assert.doesNotThrow(() => assertGeneratedChoiceAnswerDistribution({
    questionId: 'generated-q2',
    type: 'multiple',
    options,
    correctOptionIds: ['A', 'C'],
  }))
  assert.doesNotThrow(() => assertGeneratedChoiceAnswerDistribution({
    questionId: 'generated-q3',
    type: 'multiple',
    options,
    correctOptionIds: ['A', 'B', 'C', 'D'],
  }))
  assert.throws(
    () => assertGeneratedChoiceAnswerDistribution({
      questionId: 'generated-q4',
      type: 'multiple',
      options,
      correctOptionIds: [],
    }),
    /invalid multi-select answer count/,
  )
})

test('multi-select set validation rejects predictable answer-count patterns', () => {
  const repeated = Array.from({ length: 4 }, (_, index) => question({
    id: `generated-q${index + 1}`,
    number: String(index + 1),
    type: 'multiple',
    options: [
      { id: 'A', text: 'A' },
      { id: 'B', text: 'B' },
      { id: 'C', text: 'C' },
      { id: 'D', text: 'D' },
    ],
    answer: { correctOptionIds: ['A', 'B', 'C'], expectedText: null, source: 'inferred' },
  }))

  assert.throws(
    () => assertGeneratedMultiSelectAnswerVariety(repeated),
    /too predictable/,
  )

  const varied = repeated.map((item, index) => ({
    ...item,
    answer: {
      ...item.answer,
      correctOptionIds: [
        ['A'],
        ['A', 'B'],
        ['A', 'B', 'C'],
        ['A', 'B', 'C', 'D'],
      ][index],
    },
  }))
  assert.doesNotThrow(() => assertGeneratedMultiSelectAnswerVariety(varied))
})

test('programmatic draft audit reports predictable multi-select patterns', () => {
  const repeated = Array.from({ length: 4 }, (_, index) => question({
    id: `generated-q${index + 1}`,
    number: String(index + 1),
    type: 'multiple',
    options: [
      { id: 'A', text: 'A' },
      { id: 'B', text: 'B' },
      { id: 'C', text: 'C' },
      { id: 'D', text: 'D' },
    ],
    answer: { correctOptionIds: ['A', 'B', 'C'], expectedText: null, source: 'inferred' },
  }))

  const feedback = buildGeneratedExamProgrammaticFeedback({ questions: repeated })

  assert.equal(feedback.hasIssues, true)
  assert.equal(feedback.issues.some((issue) => issue.code === 'predictable-multi-select-answer-counts'), true)
  assert.match(feedback.text, /Blocking issues detected/)
  assert.match(feedback.text, /4\/4 use 3\/4 correct options/)
  assert.match(feedback.text, /generated-q1/)
  assert.match(feedback.text, /Multi-select answer-count distribution: 3\/4: 4/)
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

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
import { buildQuestionSetLatex, sanitizePdfFileName } from './examPdfExport.mjs'
import {
  extractNotebookText,
  extractSourceFile,
  formatCodeText,
  isTopicContextSource,
  normalizeSourceKind,
  publicSourceFromRow,
  shouldSkipFolderSource,
} from './sourceExtraction.mjs'
import {
  buildSourceCorpusText,
  searchSourceCorpus,
  writeSourceCorpus,
} from './sourceCorpus.mjs'

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

test('prompt context keeps generated exams out of creative coverage but records duplicate history', () => {
  const context = createExamGenerationPromptContext(baseBank)

  assert.deepEqual(
    context.realExamCoverageProfile.sets.map((set) => [set.id, set.sourceRole]),
    [
      ['practice-exam', 'real-style-and-coverage'],
    ],
  )
  assert.equal(context.realExamCoverageProfile.conceptCounts.metrics, 1)
  assert.equal(context.realExamCoverageProfile.conceptCounts.kernels, undefined)
  assert.equal(context.generatedDuplicateHistory.length, 1)
  assert.equal(context.generatedDuplicateHistory[0].setId, 'generated-20260618131230-c6923755')
})

test('draft and review prompts use internal source search instead of raw source paths', () => {
  const promptContext = createExamGenerationPromptContext({
    ...baseBank,
    courseContext: [
      '# Course Scope',
      '## Covered Topics',
      '### Metrics',
      '- Covered: precision and recall.',
    ].join('\n'),
  })
  const commonArgs = {
    topicId: 'machine-learning',
    examId: 'generated-test',
    examAssetDir: '/tmp/generated-test',
    outputPath: '/tmp/generated-test/draft-question-set.json',
    sourceManifest: {
      sourceAccessMode: 'internal-search-only',
      instructions: 'Use only the internal search command below for course-source grounding. Do not inspect source files directly.',
      internalSearch: {
        commandTemplate: 'node scripts/searchTopicSource.mjs machine-learning "<regex>" --context 20 --limit 30',
        topicId: 'machine-learning',
        corpus: { exists: true, sourceCount: 1, lineCount: 20, sizeBytes: 500 },
      },
      availableSources: [{ name: 'lecture.md', sourceKind: 'lecture', extension: '.md' }],
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
  assert.match(draftPrompt, /Real exam coverage profile:/)
  assert.match(draftPrompt, /Course context coverage map:/)
  assert.match(draftPrompt, /Metrics/)
  assert.match(draftPrompt, /Course source manifest:/)
  assert.match(draftPrompt, /node scripts\/searchTopicSource\.mjs machine-learning/)
  assert.match(draftPrompt, /JavaScript regular expression, not literal text search/)
  assert.match(draftPrompt, /replace <regex> with a precise regex pattern/)
  assert.match(draftPrompt, /Dyna\\s/)
  assert.match(draftPrompt, /The internal search command is the ONLY allowed way/)
  assert.doesNotMatch(draftPrompt, /\/tmp\/generated-test\/source-material\/lectures\/lecture\.md/)
  assert.match(draftPrompt, /Save the JSON file here: \/tmp\/generated-test\/draft-question-set\.json/)
  assert.doesNotMatch(draftPrompt, /Metrics, kernels, and SVM lecture notes/)
  assert.doesNotMatch(draftPrompt, /BEGIN CODE EXAMPLE/)
  assert.match(draftPrompt, /Shared question-set guidelines:/)
  assert.match(reviewPrompt, /Shared question-set guidelines:/)
  assert.match(draftPrompt, /generated exams are duplicate-check history only/i)
  assert.match(draftPrompt, /courseSection, sourceSearchTerms, and sourceEvidence/)
  assert.match(draftPrompt, /Multi-select questions may have any number of correct options from exactly one through all options/)
  assert.match(draftPrompt, /All-correct and single-correct multi-select questions are valid/)
  assert.doesNotMatch(draftPrompt, /at least one incorrect option/)
  assert.doesNotMatch(draftPrompt, /consider making it a single-choice question/)
  assert.match(draftPrompt, /do not repeat that same <image> in child prompts/)
  assert.match(draftPrompt, /Do not ask what happened in the lecture/)
  assert.match(draftPrompt, /Only include formula manipulation, derivations, or exact feature mappings when real exam examples clearly use that same level/)
  assert.match(draftPrompt, /Choice options must be balanced/)
  assert.match(draftPrompt, /Hard MCQs should use near-miss options/)
  assert.match(reviewPrompt, /Review and repair this draft TurboLearner exam/)
  assert.match(reviewPrompt, /Programmatic draft audit:/)
  assert.match(reviewPrompt, /Generated multi-select answer counts are too predictable: 4\/4 use 3\/4 correct options/)
  assert.match(reviewPrompt, /These checks run again after review/)
  assert.match(reviewPrompt, /Draft exam JSON:/)
  assert.match(reviewPrompt, /Read the draft JSON from: \/tmp\/generated-test\/draft-question-set\.json/)
  assert.match(reviewPrompt, /Save the corrected JSON file here: \/tmp\/generated-test\/final-question-set\.json/)
  assert.match(reviewPrompt, /Course source manifest:/)
  assert.match(reviewPrompt, /Do not inspect raw PDFs/)
  assert.match(reviewPrompt, /Do not ask what happened in the lecture/)
  assert.match(reviewPrompt, /Only include formula manipulation, derivations, or exact feature mappings when real exam examples clearly use that same level/)
  assert.match(reviewPrompt, /remove duplicate child-level <image> tags/)
  assert.match(reviewPrompt, /Fix multi-select questions where no options are correct/)
  assert.doesNotMatch(reviewPrompt, /where all options are correct or no options are correct/)
  assert.match(reviewPrompt, /Replace questions that ask what happened in the lecture/)
  assert.match(reviewPrompt, /Reject lecture-memorization trivia/)
  assert.match(reviewPrompt, /Fix weak choice options/)
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

test('blank exam steering prompt is omitted from draft and review prompts', () => {
  const promptContext = createExamGenerationPromptContext(baseBank)
  const commonArgs = {
    topicId: 'machine-learning',
    examId: 'generated-test',
    examAssetDir: '/tmp/generated-test',
    usableFiles: [{ name: 'lecture.md', text: 'Lecture text.' }],
    failedFiles: [],
    codeExampleFiles: [],
    promptContext,
    steeringPrompt: '   ',
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

  assert.doesNotMatch(draftPrompt, /User exam steering prompt:/)
  assert.doesNotMatch(reviewPrompt, /User exam steering prompt:/)
})

test('exam steering prompt is included in both draft and review prompts', () => {
  const steeringPrompt = [
    'Make this more like the original exams.',
    'All options should be very hard with minor technical wording changes.',
  ].join('\n')
  const promptContext = createExamGenerationPromptContext(baseBank)
  const commonArgs = {
    topicId: 'machine-learning',
    examId: 'generated-test',
    examAssetDir: '/tmp/generated-test',
    usableFiles: [{ name: 'lecture.md', text: 'Lecture text.' }],
    failedFiles: [],
    codeExampleFiles: [],
    promptContext,
    steeringPrompt,
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

  assert.match(draftPrompt, /User exam steering prompt:/)
  assert.match(reviewPrompt, /User exam steering prompt:/)
  assert.match(draftPrompt, /Make this more like the original exams\./)
  assert.match(reviewPrompt, /minor technical wording changes/)
  assert.match(draftPrompt, /Shared question-set guidelines:/)
  assert.match(reviewPrompt, /Real exam style examples:/)
})

test('PDF export latex renders math tags and raw formula options', () => {
  const latex = buildQuestionSetLatex({
    topicName: 'Introduction to Reinforcement Learning',
    set: {
      title: 'Generated Exam 4',
      questions: [
        question({
          id: 'q1',
          number: '15',
          prompt: 'What is the correct form of the 3-step return?',
          options: [
            { id: 'A', text: '<math display>R_{t+1}+\\gamma R_{t+2}+\\gamma^2R_{t+3}</math>' },
            { id: 'B', text: '<math display>\\sum_s p(s\\mid S_t,A_t)V(s)</math>' },
            { id: 'C', text: '\\max_a Q(S_{t+1},a)' },
          ],
          correctOptionIds: ['B'],
        }),
      ],
    },
  })

  assert.match(latex, /\\item\[\\textbf\{A\.\}\] \\\(R_\{t\+1\}\+\\gamma R_\{t\+2\}\+\\gamma\^2R_\{t\+3\}\\\)/)
  assert.match(latex, /\\item\[\\textbf\{B\.\}\] \\\(\\sum_\{s\} p\(s\\mid S_t,A_t\)V\(s\)\\\)/)
  assert.match(latex, /\\item\[\\textbf\{C\.\}\] \\\(\\max_\{a\} Q\(S_\{t\+1\},a\)\\\)/)
  assert.doesNotMatch(latex, /R\\_\\\{t/)
  assert.match(latex, /\\textbf\{15\.\} B/)
})

test('PDF export latex keeps images inline inside questions', () => {
  const latex = buildQuestionSetLatex({
    topicName: 'Introduction to Reinforcement Learning',
    resolveImagePath: (imagePath) => imagePath === '/api/generated-assets/topic/exam/q34.png'
      ? '/tmp/q34.png'
      : null,
    set: {
      title: 'Generated Exam 4',
      questions: [
        question({
          id: 'q34',
          number: '34',
          type: 'open',
          prompt: [
            'Compute the update.',
            '<image>/api/generated-assets/topic/exam/q34.png</image>',
            'Use Q-learning.',
          ].join('\n\n'),
          options: [],
          answer: {
            correctOptionIds: null,
            expectedText: 'The new estimate is <math>q(s,a)=5.5</math>.',
            source: 'inferred',
          },
        }),
      ],
    },
  })

  assert.match(latex, /Compute the update\.[\s\S]*\\includegraphics\[[^\]]+\]\{\\detokenize\{\/tmp\/q34\.png\}\}[\s\S]*Use Q-learning\./)
  assert.doesNotMatch(latex, /\\begin\{figure\}/)
  assert.match(latex, /\\textbf\{34\.\} The new estimate is \\\(q\(s,a\)=5\.5\\\)\./)
})

test('PDF export filenames are sanitized', () => {
  assert.equal(sanitizePdfFileName('Generated Exam 4'), 'Generated Exam 4.pdf')
  assert.equal(sanitizePdfFileName('Exam: RL / AlphaGo?.pdf'), 'Exam- RL - AlphaGo-.pdf')
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

test('source corpus generation and search return bounded context blobs', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'turbolearner-corpus-'))
  const summary = writeSourceCorpus({
    topicId: 'intro-rl',
    topicDir: tmpDir,
    sources: [
      {
        id: 's1',
        name: 'Bandits.pdf',
        relativePath: '',
        extension: '.pdf',
        text: 'Intro\nBandit action value uses partial feedback.\nRegret compares with best arm.',
      },
      {
        id: 's2',
        name: 'MDP.pdf',
        relativePath: '',
        extension: '.pdf',
        text: 'States\nTransitions\nValues',
      },
    ],
  })

  assert.equal(summary.exists, true)
  assert.equal(summary.sourceCount, 2)
  const result = searchSourceCorpus({
    corpusPath: summary.path,
    query: 'partial feedback',
    context: 1,
    limit: 5,
    randomize: false,
  })

  assert.equal(result.hitCount, 1)
  assert.match(result.output, /SOURCE 1: Bandits\.pdf/)
  assert.match(result.output, /Intro Bandit action value uses partial feedback\. Regret compares with best arm\./)
  assert.match(result.output, /Bandit action value uses partial feedback/)
  assert.doesNotMatch(result.output, /Intro\nBandit action value/)
  assert.doesNotMatch(result.output, /^\s*>?\s*\d+\s+\|/m)
  assert.doesNotMatch(result.output, /Transitions/)
})

test('source corpus search samples after collecting matches and uses raw regex patterns', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'turbolearner-corpus-'))
  const summary = writeSourceCorpus({
    topicId: 'intro-rl',
    topicDir: dir,
    sources: [{
      id: 's1',
      name: 'Planning.pdf',
      relativePath: '',
      extension: '.pdf',
      text: [
        'Dynamic programming introduces full sweeps.',
        'Dyna alternates real experience and model-generated planning updates.',
        'Dyna-Q samples simulated transitions from a learned model.',
      ].join('\f'),
    }],
  })

  const exact = searchSourceCorpus({
    corpusPath: summary.path,
    query: 'Dyna ',
    context: 0,
    limit: 10,
    randomize: false,
  })
  assert.equal(exact.hitCount, 1)
  assert.match(exact.output, /TurboLearner source regex: "Dyna "/)
  assert.doesNotMatch(exact.output, /Dynamic programming/)
  assert.match(exact.output, /Dyna alternates real experience/)
  assert.doesNotMatch(exact.output, /Dyna-Q samples simulated transitions/)

  const broad = searchSourceCorpus({
    corpusPath: summary.path,
    query: 'Dyna',
    context: 0,
    limit: 10,
    randomize: false,
  })
  assert.equal(broad.hitCount, 3)
  assert.match(broad.output, /Dynamic programming/)
  assert.match(broad.output, /Dyna-Q samples simulated transitions/)
})

test('source corpus search limit is the maximum number of displayed hits', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'turbolearner-corpus-'))
  const summary = writeSourceCorpus({
    topicId: 'intro-rl',
    topicDir: dir,
    sources: [{
      id: 's1',
      name: 'Repeated.pdf',
      relativePath: '',
      extension: '.pdf',
      text: ['Dyna one', 'Dyna two', 'Dyna three', 'Dyna four', 'Dyna five'].join('\f'),
    }],
  })

  const limited = searchSourceCorpus({
    corpusPath: summary.path,
    query: 'Dyna ',
    context: 0,
    limit: 3,
    randomize: false,
  })
  assert.equal(limited.totalMatchCount, 5)
  assert.equal(limited.hitCount, 3)
  assert.match(limited.output, /Showing 3 snippets from 5 matches \(limit 3\)\./)

  const all = searchSourceCorpus({
    corpusPath: summary.path,
    query: 'Dyna ',
    context: 0,
    limit: 5,
    randomize: false,
  })
  assert.equal(all.hitCount, 5)
  assert.match(all.output, /SOURCE 5: Repeated\.pdf/)
})

test('source corpus text preserves source newlines without page markers or blank OCR gaps', () => {
  const text = buildSourceCorpusText({
    topicId: 'intro-rl',
    sources: [{
      id: 's1',
      name: 'Slides.pdf',
      relativePath: '',
      extension: '.pdf',
      text: 'Slide\n\none\n\n\nhas   gaps\fSlide\n two',
    }],
  })

  assert.doesNotMatch(text, /@@TURBOLEARNER_PAGE/)
  assert.match(text, /@@TURBOLEARNER_SOURCE/)
  assert.match(text, /Slide\none\nhas gaps\nSlide\ntwo/)
  assert.doesNotMatch(text, /Slide\n\none/)
  assert.doesNotMatch(text, /\n\n\nhas/)
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

test('programmatic draft audit does not block subjective option-quality heuristics', () => {
  const feedback = buildGeneratedExamProgrammaticFeedback({
    questions: [
      question({
        id: 'generated-q1',
        number: '1',
        prompt: 'Which statement best describes the role of the critic in actor-critic methods?',
        options: [
          { id: 'A', text: 'It performs exhaustive tree search at every decision.' },
          { id: 'B', text: 'It replaces the policy with a model of transition probabilities.' },
          { id: 'C', text: 'It stores expert demonstrations for behavior cloning.' },
          { id: 'D', text: 'It learns value estimates that assess actions or states, often with single-step TD, while the actor updates the policy.' },
        ],
        answer: { correctOptionIds: ['D'], expectedText: null, source: 'inferred' },
      }),
    ],
  })

  assert.equal(feedback.issues.some((issue) => issue.code === 'weak-choice-options'), false)
  assert.doesNotMatch(feedback.text, /Weak choice-option/)
})

test('programmatic draft audit requires internal-search evidence when enabled', () => {
  const feedback = buildGeneratedExamProgrammaticFeedback({
    questions: [
      question({
        id: 'generated-q1',
        courseSection: 'Model-Free Learning From Experience',
      }),
    ],
  }, {
    requireSourceEvidence: true,
    courseSections: [{ title: 'Model-Free Learning From Experience' }],
    generatedDuplicateHistory: [],
  })

  assert.equal(feedback.hasIssues, true)
  assert.equal(feedback.issues.some((issue) => issue.code === 'missing-source-evidence'), true)
  assert.match(feedback.text, /Missing source evidence: 1/)
})

test('programmatic draft audit flags near-duplicates from generated history', () => {
  const feedback = buildGeneratedExamProgrammaticFeedback({
    questions: [
      question({
        id: 'generated-q1',
        prompt: 'A generated prompt about kernelized classifiers.',
        options: [
          { id: 'A', text: 'Kernel option A' },
          { id: 'B', text: 'Kernel option B' },
          { id: 'C', text: 'Kernel option C' },
          { id: 'D', text: 'Kernel option D' },
        ],
        courseSection: 'Kernels',
        sourceSearchTerms: ['kernelized classifiers'],
        sourceEvidence: [{ source: 'lecture.md', lineStart: 1, lineEnd: 5 }],
      }),
    ],
  }, createExamGenerationPromptContext(baseBank))

  assert.equal(feedback.hasIssues, true)
  assert.equal(feedback.issues.some((issue) => issue.code === 'generated-history-near-duplicates'), true)
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

# Exam Generation Design

This document describes the advanced TurboLearner exam-generation pipeline. The goal is to make high-quality exams by giving Codex a deterministic, auditable task: cover the course blueprint, ground questions in real source material, match the real exam style, and avoid generated-exam drift.

## Core Principle

LLMs are useful here as exam writers, not as randomizers or source selectors.

The system therefore separates responsibilities:

- Programmatic code chooses constraints, validates coverage, checks duplicates, and records logs.
- Codex writes questions only inside those constraints.
- Source material is accessed through a narrow internal regex search tool.
- Prior generated exams are used only for duplicate detection, not as creative examples.

This keeps the generator from repeatedly drifting toward its own previous outputs.

## Data Roles

### Course Context

The generated course context is the exam blueprint. It defines the course sections, expected depth, terminology, caveats, and topic mix.

The context should be inclusive: it should represent the course scope more completely than any single slide deck or extracted source chunk. During generation, Codex should map every question to a `courseSection` from this blueprint.

### Real Practice Exams

Real exams are used for style calibration only:

- question mix
- difficulty
- phrasing style
- option style
- single/open/numeric/image balance
- how much calculation is expected

Real exams should not be treated as a source of course coverage by themselves.

### Source Corpus

Uploaded topic sources are extracted into:

```text
.turbolearner/topics/<topicId>/source-corpus.txt
```

This corpus is the grounding layer. It is intentionally searched through the internal source-search tool instead of being fully dumped into the Codex prompt.

### Generated Exam History

Previously generated exams are not fed back to Codex as examples.

They are reduced to compact programmatic duplicate-history signatures. These signatures are used to flag repeated stems, repeated concepts, and near-duplicate generated questions without biasing the writer toward prior generated wording.

## Pipeline

1. Topic sources are extracted and normalized into `source-corpus.txt`.
2. Course context is generated or loaded as the inclusive coverage blueprint.
3. A generation job starts with an exam id, job id, asset directory, and append-only log file.
4. The server builds a deterministic `exam-blueprint.json` from course context, real-exam type mix, generated-history debt, and the user-selected seed/settings.
5. The draft Codex thread receives assigned blueprint slots, real-exam style guidance, generation constraints, source-search contract, and duplicate-history signatures.
6. Codex writes `draft-question-set.json`.
7. A programmatic draft audit checks structure, blueprint adherence, coverage, grounding, duplicate risk, answer distribution, and image references.
8. The review Codex thread receives the draft plus audit findings and writes `final-question-set.json`.
9. A final audit validates the reviewed exam before it is persisted to SQLite.

If the final audit fails, the exam should not be treated as successfully generated.

## Internal Source Search

Codex is expected to inspect course sources only through:

```bash
node scripts/searchTopicSource.mjs <topicId> "<regex>" --context <n> --limit <n> --seed <seed>
```

Search is regex-based, not fuzzy semantic search. This lets Codex search precisely for course terms such as:

```bash
node scripts/searchTopicSource.mjs introduction-to-rl "Dyna " --context 12 --limit 8 --seed abc123
```

The search output is a compact text dump of matched source context. `--context 12` means include up to 12 surrounding source lines before and after each regex match. `--limit 8` means return at most 8 hits. The exact values come from the generation settings selected before the run starts.

When the source corpus has more matches than the limit, the search tool samples hits with the provided seed. Lower limits expose Codex to fewer snippets per search and therefore force narrower, more varied retrieval. Higher limits give more local evidence per search but can make repeated broad terms dominate.

The server watches Codex tool calls. If a `searchTopicSource.mjs` command omits or changes the required `--context`, `--limit`, or `--seed` flags, the generation fails as a source-search contract violation.

The generator must record the regexes it used in each question's `sourceSearchTerms`.

Forbidden source access includes direct reads of raw PDFs, extracted source folders, `source-material`, `sources`, `context-source-material`, or other bypass paths. The server watches for these access violations and records them in the job log.

## Question Metadata

Generated questions should include grounding and coverage metadata:

- `blueprintSlotId`: the exact primary or backup slot used.
- `blueprintTarget`: the assigned slot target restated briefly.
- `blueprintStatus`: `primary` or `backup`.
- `blueprintReplacementReason`: required when a backup slot replaces a weak primary slot.
- `courseSection`: the blueprint section the question is meant to cover.
- `sourceSearchTerms`: regex searches used to find relevant source evidence.
- `sourceEvidence`: short source-grounding snippets or source references supporting the question.

This metadata is not just descriptive. It is used by audits to verify that questions were intentionally grounded and that the exam is not over-concentrated in a few familiar concepts.

## Deterministic Coverage Blueprint

The server, not Codex, chooses the question slots. The blueprint contains:

- primary slots, one per intended question
- backup slots, used only when source search shows a primary slot is weak
- assigned `courseSection`, target, intended type, exam-worthiness label, and search hints
- section allocation counts and generation settings

The allocation is seeded. The same course context, generated-history state, real-exam style profile, and seed produce the same blueprint. A different seed can change slot order and weighted selections.

The allocator gives each course section a floor when there are enough questions, caps per-section dominance, downweights sections that are already heavily represented in generated history, and still weights toward testable objectives instead of low-yield course-administration fluff. Codex can reject a weak primary slot, but only by using a precomputed backup slot and explaining why.

## Audits

The pipeline uses programmatic audits because Codex should not be trusted to judge its own coverage quality.

Draft and final audits can check:

- valid JSON shape and required fields
- question count and type mix
- answer-key mirrors
- image paths and image tags
- missing or invalid blueprint slots
- omitted primary slots without backup replacements
- backup slots used without replacement reasons
- course-section mismatch against blueprint slots
- missing `courseSection`
- missing source evidence
- course-section coverage
- over-concentration in one section
- repeated concepts within the exam
- near duplicates against generated-history signatures
- option-pattern issues such as answer-key imbalance
- multi-select answer-pattern problems

The final audit is the gate that determines whether the result is safe to persist.

Subjective option quality is handled through prompt and review-rubric guidance, not a deterministic blocker. Codex is told to avoid obvious length, specificity, and extreme-wording tells, but the app does not reject questions with a crude option-quality heuristic.

## Logging

Every generation has an append-only JSONL log:

```text
.turbolearner/topics/<topicId>/generation-logs/<examId>-<jobId>.jsonl
```

The UI shows a compact live feed for humans, but the JSONL file is the durable audit trail. It is meant for debugging exact behavior after the fact.

Typical log events include:

- `job_started`
- `coverage_blueprint_created`
- `ui_log`
- `codex_thread_started`
- `codex_turn_input`
- `codex_notification`
- `codex_turn_completed`
- `source_access_violation`
- `job_updated`

The generation modal links to the raw JSONL log so the exact draft and review thread events can be inspected later.

## Why Generated Exams Are Not Prompt Examples

Feeding generated exams back into the next generation creates a bias loop. Even if the wording changes, the model tends to reuse the same broad concepts, answer structures, and distractor shapes.

The current design avoids that by using generated history only as machine-readable duplicate evidence. Codex sees the warning constraints, not the full prior generated exams.

## Tuning Levers

The pre-generation modal exposes the first practical knobs:

- `seed`: deterministic coverage/search seed
- `search limit`: maximum sampled hits returned by each regex source search
- `search context`: source lines before/after each hit
- `coverage randomness`: how much the blueprint allocator lets seeded randomness perturb deterministic section weights

Additional useful knobs are mostly programmatic:

- course-section coverage thresholds
- maximum questions per section
- duplicate-similarity threshold
- minimum source evidence requirements
- required search-term count per question
- open/numeric/code/image question mix
- per-source or per-section caps
- real-exam style guidance
- audit strictness

Embeddings can be added later, but v1 intentionally uses the simpler regex corpus search. That keeps behavior inspectable while the quality rules are still being tuned.

## Known Limitations

Coverage is currently controlled by course sections and source evidence, not by forcing every individual uploaded source file to produce a question. Some source files may be duplicates, administrative slides, or low-yield overview material.

Regex search can still return weak or repetitive source hits if the search term is too broad. The fix is to tune search-term selection, section coverage constraints, and audits rather than dump more source text into the prompt.

The system is designed to be auditable and adjustable over time, not magically final on the first pass.

## Key Files

- `server/examGenerationHelpers.mjs`: prompt construction, audit helpers, duplicate-history shaping, and generation constraints.
- `server/index.mjs`: generation job orchestration, persistence, logs, and API routes.
- `server/sourceCorpus.mjs`: source-corpus construction and normalization.
- `scripts/searchTopicSource.mjs`: internal regex source-search command.
- `.turbolearner/topics/<topicId>/source-corpus.txt`: flattened searchable source corpus.
- `.turbolearner/topics/<topicId>/generation-logs/`: append-only generation logs.

# Transcription Audit

The current `public/questions.json` is not a byte-for-byte copy of the chat messages. It is a normalized question bank generated from:

- `/Users/plevi/ML-Exam/practice_exam_questions.md`
- `/Users/plevi/ML-Exam/last_year_exam_questions.md`

## What Is Preserved

- The question/order structure from the stored Markdown sources.
- MCQ/multi-select/open question modes where detectable or manually corrected.
- Options that were present in the stored Markdown sources.
- Screenshot references as `<image>...</image>` tags.
- Code and inline code as `<code>...</code>` tags.

## Known Non-Exact Areas

- The text has been cleaned in places: typos, casing, punctuation, and formatting were normalized.
- Math/code/image markup has been converted into TurboLearner tags.
- Compound screenshot questions were split into subquestions, for example `18a`-`18d` and `19a`-`19d`.
- Practice `Question 25` contains the placeholder `Python code shown in practice exam.` because the actual code from that screenshot was not captured in the stored Markdown.
- Last year's `Question 18` code was transcribed from the screenshot and normalized into code blocks; it may not preserve every visual comment/spacing detail exactly.
- Practice single-answer questions with non-standard option counts remain exactly as stored in the Markdown source, but they should be checked against the original exam UI:
  - Q1: 5 options
  - Q2: 5 options
  - Q3: 5 options
  - Q4: 5 options
  - Q8: 3 options
  - Q10: 3 options
- Last year's true/false questions are stored as two-option single-answer questions:
  - Q18a
  - Q18c

## Current Verdict

Use the current bank for practice, but do not treat it as an exact canonical copy of the original exams until the flagged items are checked against screenshots or exported exam text.

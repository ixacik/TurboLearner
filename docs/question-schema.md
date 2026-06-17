# TurboLearner Question Schema

Canonical schema: [`schemas/question-bank.schema.json`](../schemas/question-bank.schema.json)

Copy-paste example: [`examples/question-bank.example.json`](../examples/question-bank.example.json)

The app consumes `public/questions.json`. A question bank contains one or more exam sets:

```json
{
  "schema": {
    "version": 2,
    "schemaRef": "schemas/question-bank.schema.json",
    "description": "Question bank for TurboLearner.",
    "contentTags": {
      "math": "<math>x^2</math> or <math display>...</math>",
      "image": "<image>/absolute/local/path.png</image>",
      "code": "<code lang=\"python\">...</code>"
    }
  },
  "generatedAt": "2026-06-17T00:00:00.000Z",
  "sets": []
}
```

## Question Types

Use `type` to choose the UI and grading mode:

- `single`: one-answer MCQ, rendered as radio buttons.
- `multiple`: multi-select MCQ, rendered as checkboxes.
- `open`: free-text answer, rendered as a textarea. `options` must be `[]`.

## Question Shape

```json
{
  "id": "practice-exam-q1",
  "setId": "practice-exam",
  "source": "Practice Exam",
  "number": "1",
  "title": "Question 1",
  "type": "single",
  "prompt": "Question text here.",
  "points": 1,
  "options": [
    { "id": "A", "text": "First option" },
    { "id": "B", "text": "Second option" }
  ],
  "answer": {
    "correctOptionIds": null,
    "expectedText": null,
    "source": "missing"
  },
  "concepts": ["classification"]
}
```

If there is an official answer key, use:

```json
"answer": {
  "correctOptionIds": ["B"],
  "expectedText": null,
  "source": "provided"
}
```

For open questions:

```json
"answer": {
  "correctOptionIds": null,
  "expectedText": "A short rubric or expected answer.",
  "source": "provided"
}
```

When no answer key exists, keep `source` as `missing`. Codex will infer and explain during training.

## Content Tags

Prompts and option text are Markdown-compatible and support TurboLearner tags.

Inline LaTeX:

```html
<math>P(Y | X)</math>
```

Display LaTeX:

```html
<math display>\frac{P(X | Y)P(Y)}{P(X)}</math>
```

Image:

```html
<image>/absolute/path/to/image.png</image>
```

Generated app asset:

```html
<image>/generated-assets/bias-variance-wiggly-boundary.svg</image>
```

Code block:

```html
<code lang="python">
def recall(tp, fn):
    return tp / (tp + fn)
</code>
```

Mermaid graph:

```html
<code lang="mermaid">
flowchart LR
  A[Data] --> B[Model]
</code>
```

Inline code:

```html
<code>k</code>
```

## Adding A New Exam

1. Copy `examples/question-bank.example.json`.
2. Add a new set under `sets`.
3. Give every question a stable `id`, matching `setId`, explicit `type`, `options`, and `answer`.
4. Use `<math>`, `<image>`, and `<code>` tags for structured content.
5. Put the finished bank at `public/questions.json`, or update the importer to merge your new source.

## Generating Exam-Style Diagrams

Run:

```bash
npm run generate:assets
```

This writes SVG files to `public/generated-assets/` and a manifest to:

```text
public/generated-assets/manifest.json
```

The generated assets include decision boundaries, one-dimensional class layouts, ROC curves, confusion matrices, and simple decision-tree diagrams. Reference them from a question prompt with `<image>...</image>`.

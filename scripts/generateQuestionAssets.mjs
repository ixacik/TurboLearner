import fs from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('public/generated-assets')
const manifestPath = path.join(outDir, 'manifest.json')

const assets = [
  {
    id: 'bias-variance-wiggly-boundary',
    title: 'High variance / low bias decision boundary',
    filename: 'bias-variance-wiggly-boundary.svg',
    kind: 'decision-boundary',
    svg: decisionBoundarySvg(),
    promptSnippet:
      '<image>/generated-assets/bias-variance-wiggly-boundary.svg</image>',
  },
  {
    id: 'one-dimensional-nonlinear-classes',
    title: 'One-dimensional non-linear class layout',
    filename: 'one-dimensional-nonlinear-classes.svg',
    kind: 'one-dimensional-classification',
    svg: oneDimensionalClassesSvg(),
    promptSnippet:
      '<image>/generated-assets/one-dimensional-nonlinear-classes.svg</image>',
  },
  {
    id: 'roc-curve-comparison',
    title: 'ROC curve comparison',
    filename: 'roc-curve-comparison.svg',
    kind: 'roc',
    svg: rocCurveSvg(),
    promptSnippet: '<image>/generated-assets/roc-curve-comparison.svg</image>',
  },
  {
    id: 'confusion-matrix-binary',
    title: 'Binary confusion matrix',
    filename: 'confusion-matrix-binary.svg',
    kind: 'confusion-matrix',
    svg: confusionMatrixSvg(),
    promptSnippet: '<image>/generated-assets/confusion-matrix-binary.svg</image>',
  },
  {
    id: 'decision-tree-weather',
    title: 'Small decision tree',
    filename: 'decision-tree-weather.svg',
    kind: 'decision-tree',
    svg: decisionTreeSvg(),
    promptSnippet: '<image>/generated-assets/decision-tree-weather.svg</image>',
  },
]

fs.mkdirSync(outDir, { recursive: true })

const manifest = {
  generatedAt: new Date().toISOString(),
  description:
    'Generated TurboLearner question assets. Reference these from question prompts with <image>/generated-assets/file.svg</image>.',
  assets: assets.map(({ id, title, filename, kind, promptSnippet }) => ({
    id,
    title,
    kind,
    path: `/generated-assets/${filename}`,
    promptSnippet,
  })),
}

for (const asset of assets) {
  fs.writeFileSync(path.join(outDir, asset.filename), `${asset.svg}\n`)
}

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`Wrote ${assets.length} SVG assets to ${outDir}`)
for (const asset of manifest.assets) {
  console.log(`${asset.id}: ${asset.promptSnippet}`)
}

function svgFrame({ width = 900, height = 620, children }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">
  <defs>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#0f172a" flood-opacity="0.18"/>
    </filter>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#111827"/>
    </marker>
  </defs>
  <rect width="100%" height="100%" fill="#ffffff"/>
  ${children}
</svg>`
}

function axis2d({ x = 110, y = 500, width = 650, height = 390, xLabel = 'F2', yLabel = 'F1' }) {
  return `
  <line x1="${x}" y1="${y}" x2="${x + width}" y2="${y}" stroke="#111827" stroke-width="9" stroke-linecap="round" marker-end="url(#arrow)"/>
  <line x1="${x}" y1="${y}" x2="${x}" y2="${y - height}" stroke="#111827" stroke-width="9" stroke-linecap="round" marker-end="url(#arrow)"/>
  <text x="${x + width / 2}" y="${y + 55}" font-family="Inter, Arial, sans-serif" font-size="36" font-weight="700" fill="#374151">${xLabel}</text>
  <text x="${x - 58}" y="${y - height / 2}" font-family="Inter, Arial, sans-serif" font-size="36" font-weight="700" fill="#374151">${yLabel}</text>`
}

function decisionBoundarySvg() {
  const red = [
    [260, 400],
    [225, 310],
    [295, 270],
    [285, 195],
    [340, 130],
    [445, 420],
  ]
  const green = [
    [330, 330],
    [390, 310],
    [460, 300],
    [375, 235],
    [475, 225],
    [395, 160],
  ]

  return svgFrame({
    children: `
  ${axis2d({})}
  <path d="M 430 505 C 430 465 375 445 300 450 C 235 455 220 390 255 360 C 295 325 270 285 305 255 C 345 225 320 185 365 165 C 405 145 405 120 405 92" fill="none" stroke="#111827" stroke-width="8" stroke-linecap="round" stroke-dasharray="16 16"/>
  ${red.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="19" fill="#fff" stroke="#dc2626" stroke-width="10" filter="url(#softShadow)"/>`).join('\n  ')}
  ${green.map(([x, y]) => greenCross(x, y)).join('\n  ')}
  <text x="170" y="75" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800" fill="#111827">Decision boundary learned from two features</text>`,
  })
}

function oneDimensionalClassesSvg() {
  const negatives = [140, 190, 240, 580, 640, 700, 760]
  const positives = [295, 355, 415, 475]

  return svgFrame({
    width: 920,
    height: 300,
    children: `
  <line x1="110" y1="165" x2="810" y2="165" stroke="#2563eb" stroke-width="6" marker-end="url(#arrow)"/>
  ${negatives.map((x) => `<circle cx="${x}" cy="130" r="13" fill="#2563eb"/>`).join('\n  ')}
  ${positives.map((x) => plusSymbol(x, 130, 26, '#2563eb')).join('\n  ')}
  <text x="110" y="225" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="700" fill="#374151">single numerical feature</text>
  <text x="306" y="75" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="900" fill="#2563eb">+</text>
  <text x="128" y="75" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="900" fill="#2563eb">-</text>
  <text x="615" y="75" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="900" fill="#2563eb">-</text>`,
  })
}

function rocCurveSvg() {
  return svgFrame({
    width: 820,
    height: 620,
    children: `
  <line x1="115" y1="500" x2="710" y2="500" stroke="#111827" stroke-width="5" marker-end="url(#arrow)"/>
  <line x1="115" y1="500" x2="115" y2="85" stroke="#111827" stroke-width="5" marker-end="url(#arrow)"/>
  <line x1="115" y1="500" x2="675" y2="115" stroke="#9ca3af" stroke-width="4" stroke-dasharray="10 10"/>
  <path d="M 115 500 C 150 315 250 185 405 125 C 515 82 610 78 680 75" fill="none" stroke="#16a34a" stroke-width="8"/>
  <path d="M 115 500 C 195 410 315 335 470 278 C 585 235 645 180 680 140" fill="none" stroke="#dc2626" stroke-width="8"/>
  <text x="344" y="560" font-family="Inter, Arial, sans-serif" font-size="26" font-weight="800" fill="#111827">False positive rate</text>
  <text x="20" y="330" transform="rotate(-90 20 330)" font-family="Inter, Arial, sans-serif" font-size="26" font-weight="800" fill="#111827">True positive rate</text>
  <rect x="475" y="360" width="230" height="92" rx="8" fill="#ffffff" stroke="#d1d5db"/>
  <line x1="500" y1="390" x2="560" y2="390" stroke="#16a34a" stroke-width="7"/>
  <text x="575" y="398" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="700" fill="#111827">clf1</text>
  <line x1="500" y1="425" x2="560" y2="425" stroke="#dc2626" stroke-width="7"/>
  <text x="575" y="433" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="700" fill="#111827">clf2</text>`,
  })
}

function confusionMatrixSvg() {
  const cell = (x, y, label, value, fill) => `
  <rect x="${x}" y="${y}" width="180" height="120" fill="${fill}" stroke="#111827" stroke-width="3"/>
  <text x="${x + 90}" y="${y + 50}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="900" fill="#111827">${label}</text>
  <text x="${x + 90}" y="${y + 88}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="900" fill="#111827">${value}</text>`

  return svgFrame({
    width: 820,
    height: 560,
    children: `
  <text x="340" y="55" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="900" fill="#111827">Predicted label</text>
  <text x="45" y="340" transform="rotate(-90 45 340)" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="900" fill="#111827">True label</text>
  <text x="315" y="110" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800" fill="#374151">Positive</text>
  <text x="495" y="110" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800" fill="#374151">Negative</text>
  <text x="125" y="210" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800" fill="#374151">Positive</text>
  <text x="125" y="330" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800" fill="#374151">Negative</text>
  ${cell(225, 140, 'TP', 42, '#dcfce7')}
  ${cell(405, 140, 'FN', 8, '#fee2e2')}
  ${cell(225, 260, 'FP', 12, '#fef3c7')}
  ${cell(405, 260, 'TN', 38, '#dbeafe')}
  <text x="225" y="465" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="700" fill="#374151">Precision = TP / (TP + FP)</text>
  <text x="225" y="500" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="700" fill="#374151">Recall = TP / (TP + FN)</text>`,
  })
}

function decisionTreeSvg() {
  return svgFrame({
    width: 920,
    height: 560,
    children: `
  ${treeNode(460, 80, 'Outlook?', '#dbeafe')}
  ${treeNode(230, 235, 'Humidity?', '#ede9fe')}
  ${treeNode(690, 235, 'Wind?', '#ede9fe')}
  ${leafNode(115, 400, 'No', '#fee2e2')}
  ${leafNode(345, 400, 'Yes', '#dcfce7')}
  ${leafNode(575, 400, 'Yes', '#dcfce7')}
  ${leafNode(805, 400, 'No', '#fee2e2')}
  ${edge(460, 120, 230, 195, 'sunny')}
  ${edge(460, 120, 690, 195, 'rain')}
  ${edge(230, 275, 115, 365, 'high')}
  ${edge(230, 275, 345, 365, 'normal')}
  ${edge(690, 275, 575, 365, 'weak')}
  ${edge(690, 275, 805, 365, 'strong')}`,
  })
}

function greenCross(x, y) {
  return plusSymbol(x, y, 21, '#16a34a')
}

function plusSymbol(x, y, size, color) {
  const half = size
  return `<line x1="${x - half}" y1="${y}" x2="${x + half}" y2="${y}" stroke="${color}" stroke-width="10" stroke-linecap="square"/>
  <line x1="${x}" y1="${y - half}" x2="${x}" y2="${y + half}" stroke="${color}" stroke-width="10" stroke-linecap="square"/>`
}

function treeNode(x, y, text, fill) {
  return `<rect x="${x - 95}" y="${y - 38}" width="190" height="76" rx="10" fill="${fill}" stroke="#111827" stroke-width="3"/>
  <text x="${x}" y="${y + 8}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="900" fill="#111827">${escapeXml(text)}</text>`
}

function leafNode(x, y, text, fill) {
  return `<rect x="${x - 70}" y="${y - 34}" width="140" height="68" rx="999" fill="${fill}" stroke="#111827" stroke-width="3"/>
  <text x="${x}" y="${y + 8}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="900" fill="#111827">${escapeXml(text)}</text>`
}

function edge(x1, y1, x2, y2, label) {
  const lx = (x1 + x2) / 2
  const ly = (y1 + y2) / 2 - 8
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#374151" stroke-width="3"/>
  <text x="${lx}" y="${ly}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="700" fill="#374151">${escapeXml(label)}</text>`
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

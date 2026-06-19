import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const documentTextExtensions = new Set(['.txt', '.md', '.csv', '.json', '.log'])
const codeTextExtensions = new Set([
  '.py',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.ipynb',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.go',
  '.rs',
  '.rb',
  '.php',
  '.html',
  '.css',
  '.sql',
  '.sh',
  '.yml',
  '.yaml',
])
const acceptedContextExtensions = new Set(['.pdf', ...documentTextExtensions, ...codeTextExtensions])
const topicContextExtensions = new Set(['.pdf', '.txt', '.md'])
const codeLanguageByExtension = new Map([
  ['.py', 'python'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript-react'],
  ['.ts', 'typescript'],
  ['.tsx', 'typescript-react'],
  ['.ipynb', 'jupyter-notebook'],
  ['.java', 'java'],
  ['.c', 'c'],
  ['.cpp', 'cpp'],
  ['.h', 'c-cpp-header'],
  ['.hpp', 'cpp-header'],
  ['.cs', 'csharp'],
  ['.go', 'go'],
  ['.rs', 'rust'],
  ['.rb', 'ruby'],
  ['.php', 'php'],
  ['.html', 'html'],
  ['.css', 'css'],
  ['.sql', 'sql'],
  ['.sh', 'shell'],
  ['.yml', 'yaml'],
  ['.yaml', 'yaml'],
])
const ignoredFolderSegments = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.venv',
  'venv',
  '__pycache__',
])
const ignoredFolderFileNames = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'poetry.lock',
  'pipfile.lock',
  'cargo.lock',
  'composer.lock',
])

export function acceptedSourceExtensions() {
  return new Set(acceptedContextExtensions)
}

export function normalizeSourceKind(value) {
  return value === 'code-example' ? 'code-example' : 'lecture'
}

export function inferSourceKind(extension) {
  return codeTextExtensions.has(String(extension ?? '').toLowerCase()) ? 'code-example' : 'lecture'
}

export function isTopicContextSource({ extension, sourceKind }) {
  return normalizeSourceKind(sourceKind) !== 'code-example'
    && topicContextExtensions.has(String(extension ?? '').toLowerCase())
}

export function publicSourceFromRow(row) {
  return {
    id: row.id,
    name: row.original_name,
    sourceKind: normalizeSourceKind(row.source_kind),
    relativePath: row.relative_path || '',
    size: Number(row.size) || 0,
    extension: row.extension,
    extractionStatus: row.extraction_status,
    extractionError: row.extraction_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function sanitizeRelativePath(value) {
  const clean = String(value ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/')
  return clean || ''
}

export function shouldSkipFolderSource(relativePath, extension) {
  const cleanPath = sanitizeRelativePath(relativePath)
  if (!cleanPath.includes('/')) return false

  const segments = cleanPath.toLowerCase().split('/')
  if (segments.some((segment) => ignoredFolderSegments.has(segment))) return true
  if (ignoredFolderFileNames.has(segments.at(-1))) return true
  if (!acceptedContextExtensions.has(String(extension ?? '').toLowerCase())) return true
  return false
}

export async function extractSourceFile(file, { appRoot = process.cwd() } = {}) {
  const extension = String(file.extension || path.extname(file.originalName || '')).toLowerCase()
  if (!acceptedContextExtensions.has(extension)) {
    return {
      name: file.originalName,
      text: '',
      error: `Unsupported file type "${extension || '(none)'}".`,
    }
  }

  try {
    let text
    if (extension === '.pdf') {
      text = await extractPdfText(file.path, appRoot)
    } else if (extension === '.ipynb') {
      text = extractNotebookText(await fs.promises.readFile(file.path, 'utf8'), file)
    } else {
      text = await fs.promises.readFile(file.path, 'utf8')
      if (codeTextExtensions.has(extension)) text = formatCodeText(text, file)
    }

    return {
      name: file.relativePath || file.originalName,
      text: text.trim(),
      error: text.trim() ? null : 'No text was extracted.',
    }
  } catch (error) {
    return {
      name: file.relativePath || file.originalName,
      text: '',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function extractNotebookText(rawJson, file = {}) {
  const notebook = JSON.parse(rawJson)
  const cells = Array.isArray(notebook?.cells) ? notebook.cells : []
  const parts = []
  for (const [index, cell] of cells.entries()) {
    const cellType = String(cell?.cell_type || 'unknown')
    if (cellType !== 'markdown' && cellType !== 'code') continue
    const source = Array.isArray(cell?.source) ? cell.source.join('') : String(cell?.source ?? '')
    if (!source.trim()) continue
    const label = cellType === 'code' ? 'code' : 'markdown'
    parts.push(`--- ${label} cell ${index + 1} ---\n${source.trim()}`)
  }
  if (parts.length === 0) return ''
  return formatCodeText(parts.join('\n\n'), {
    ...file,
    extension: '.ipynb',
  })
}

export function formatCodeText(text, file = {}) {
  const extension = String(file.extension || path.extname(file.originalName || '')).toLowerCase()
  const relativePath = sanitizeRelativePath(file.relativePath || file.originalName || 'code-example')
  const language = codeLanguageByExtension.get(extension) || extension.replace(/^\./, '') || 'text'
  return [
    `Path: ${relativePath}`,
    `Language: ${language}`,
    '',
    text.trimEnd(),
  ].join('\n')
}

function extractPdfText(filePath, appRoot) {
  return runCommand('pdftotext', ['-layout', filePath, '-'], 60_000, appRoot)
}

function runCommand(command, args, timeoutMs, appRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: appRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s.`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `${command} exited with status ${code}.`))
    })
  })
}

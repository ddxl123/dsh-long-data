/**
 * Dockerfile discovery and parsing for the panel's build-file view.
 *
 * Two independent halves:
 *
 *   - a bounded filesystem walk that finds Dockerfiles under user-provided
 *     project roots. It never follows symlinked directories, never leaves a
 *     root, and stops on file/depth/result limits so a giant monorepo cannot
 *     stall the Host;
 *   - a pure, synchronous parser that turns one Dockerfile into the summary the
 *     panel explains in plain language (base images, ports, command, stages,
 *     per-instruction explanation keys). It never throws: malformed input turns
 *     into warnings.
 *
 * Only `node:fs/promises` and `node:path` are used; no YAML and no dependencies.
 *
 * @module dsh-long-data/dockerfiles
 */

import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

/** Directory names the walk never descends into. */
const IGNORED_DIRECTORY_NAMES = Object.freeze([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
  'coverage',
  'vendor',
  '.dsh',
  'Library',
  'site-packages',
  'Pods',
  'DerivedData',
])

/** Default bounds for one scan. */
export const DEFAULT_SCAN = Object.freeze({
  maxDepth: 6,
  maxFiles: 4000,
  maxDockerfiles: 100,
  maxBytes: 1024 * 1024,
  ignoreDirs: IGNORED_DIRECTORY_NAMES,
})

/** File names Docker itself recognises without reading the content. */
const DOCKERFILE_NAME_PATTERN = /^Dockerfile(\..+)?$/iu
const DOCKERFILE_SUFFIX_PATTERN = /\.dockerfile$/iu

/** How many bytes the content probe reads before giving up on a non-standard name. */
const CONTENT_PROBE_BYTES = 16 * 1024

/** Instructions Docker understands; everything else produces a warning. */
const KNOWN_INSTRUCTIONS = Object.freeze(new Set([
  'FROM', 'RUN', 'CMD', 'LABEL', 'MAINTAINER', 'EXPOSE', 'ENV', 'ADD', 'COPY',
  'ENTRYPOINT', 'VOLUME', 'USER', 'WORKDIR', 'ARG', 'ONBUILD', 'STOPSIGNAL',
  'HEALTHCHECK', 'SHELL',
]))

/** A legal environment/argument/label key. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/u

/**
 * @param {unknown} value - a candidate.
 * @returns {value is Record<string, any>} whether it is a plain object.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {unknown} error - a thrown value.
 * @returns {string} its message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {string} text - raw JSON text.
 * @returns {unknown} the parsed value, or undefined.
 */
function tryParseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Coerce an option into a bounded integer.
 *
 * @param {unknown} value - the caller's value.
 * @param {number} fallback - used when it is absent or unusable.
 * @param {number} min - inclusive lower bound.
 * @returns {number} the integer.
 */
function boundedInteger(value, fallback, min) {
  if (value === undefined || value === null || value === '') return fallback
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(number) && number >= min ? number : fallback
}

/**
 * Whether a file name is recognised as a Dockerfile without reading it.
 *
 * @param {string} baseName - the file's base name.
 * @returns {boolean} whether the name matches Docker's conventions.
 */
function isDockerfileName(baseName) {
  // `<Dockerfile-name>.dockerignore` is Docker's per-Dockerfile ignore file,
  // not a build file, even though it starts with "Dockerfile".
  if (/\.dockerignore$/iu.test(baseName)) return false
  return DOCKERFILE_NAME_PATTERN.test(baseName)
    || DOCKERFILE_SUFFIX_PATTERN.test(baseName)
    || baseName.toLowerCase() === 'containerfile'
}

/**
 * Read a bounded prefix of a file. Unreadable files return null so the walk can
 * skip them silently.
 *
 * @param {string} filePath - absolute file path.
 * @param {number} byteLimit - maximum bytes to read.
 * @returns {Promise<string | null>} the decoded prefix, or null.
 */
async function readHead(filePath, byteLimit) {
  /** @type {import('node:fs/promises').FileHandle | undefined} */
  let handle
  try {
    handle = await open(filePath, 'r')
    const buffer = Buffer.alloc(byteLimit)
    const { bytesRead } = await handle.read(buffer, 0, byteLimit, 0)
    return buffer.toString('utf8', 0, bytesRead)
  } catch {
    return null
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // A failed close on a file the walk is skipping is not interesting.
      }
    }
  }
}

/**
 * Find Dockerfiles under the given project roots.
 *
 * The walk is depth-first and bounded: ignored directories and symlinked
 * directories are never entered, only regular files are visited, and the
 * file/result/depth limits set `truncated` when they cut the scan short.
 * Unreadable roots are reported in `errors`; unreadable entries below a root
 * are skipped silently.
 *
 * @param {object} [options] - scan options.
 * @param {string[]} [options.roots] - absolute project directories.
 * @param {number} [options.maxDepth] - directory levels below each root.
 * @param {number} [options.maxFiles] - visited regular files before stopping.
 * @param {number} [options.maxDockerfiles] - recognised files returned.
 * @param {number} [options.maxBytes] - bytes read for content detection.
 * @param {string[]} [options.ignoreDirs] - extra directory names to skip.
 * @param {AbortSignal} [options.signal] - external cancellation.
 * @returns {Promise<{ roots: string[], files: object[], visitedFiles: number, truncated: boolean,
 *   errors: { root: string, message: string }[] }>} the scan result.
 */
export async function scanDockerfiles(options = {}) {
  const input = isRecord(options) ? options : {}
  const maxDepth = boundedInteger(input.maxDepth, DEFAULT_SCAN.maxDepth, 0)
  const maxFiles = boundedInteger(input.maxFiles, DEFAULT_SCAN.maxFiles, 1)
  const maxDockerfiles = boundedInteger(input.maxDockerfiles, DEFAULT_SCAN.maxDockerfiles, 1)
  const maxBytes = boundedInteger(input.maxBytes, DEFAULT_SCAN.maxBytes, 1)
  const probeBytes = Math.min(CONTENT_PROBE_BYTES, maxBytes)
  const ignoredDirectories = new Set(IGNORED_DIRECTORY_NAMES)
  if (Array.isArray(input.ignoreDirs)) {
    for (const name of input.ignoreDirs) {
      if (typeof name === 'string' && name.trim() !== '') ignoredDirectories.add(name.trim())
    }
  }
  const signal = input.signal

  /** @type {{ root: string, message: string }[]} */
  const errors = []
  /** @type {string[]} */
  const roots = []
  const seenRoots = new Set()
  if (Array.isArray(input.roots)) {
    for (const candidate of input.roots) {
      if (typeof candidate !== 'string' || candidate.trim() === '') continue
      const normalized = path.normalize(candidate.trim())
      if (seenRoots.has(normalized)) continue
      seenRoots.add(normalized)
      if (!path.isAbsolute(normalized)) {
        errors.push({ root: candidate, message: 'scan roots must be absolute directory paths' })
        continue
      }
      roots.push(normalized)
    }
  }

  /** @type {object[]} */
  const files = []
  let visitedFiles = 0
  let truncated = false
  let stopped = false

  for (const root of roots) {
    if (stopped) break
    if (signal !== undefined && signal.aborted === true) {
      truncated = true
      break
    }
    let rootInfo
    try {
      rootInfo = await stat(root)
    } catch (error) {
      errors.push({ root, message: messageOf(error) })
      continue
    }
    if (!rootInfo.isDirectory()) {
      errors.push({ root, message: 'not a directory' })
      continue
    }
    /** @type {{ directory: string, depth: number }[]} */
    const stack = [{ directory: root, depth: 0 }]
    while (stack.length > 0 && !stopped) {
      if (signal !== undefined && signal.aborted === true) {
        truncated = true
        stopped = true
        break
      }
      const { directory, depth } = stack.pop()
      /** @type {import('node:fs').Dirent[]} */
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch {
        // An unreadable entry below a root is skipped silently.
        continue
      }
      entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      for (const entry of entries) {
        if (stopped) break
        if (signal !== undefined && signal.aborted === true) {
          truncated = true
          stopped = true
          break
        }
        const fullPath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          if (ignoredDirectories.has(entry.name)) continue
          if (depth + 1 > maxDepth) {
            truncated = true
            continue
          }
          stack.push({ directory: fullPath, depth: depth + 1 })
          continue
        }
        // Symlinks and special files are deliberately not followed.
        if (!entry.isFile()) continue
        if (visitedFiles >= maxFiles) {
          truncated = true
          stopped = true
          break
        }
        visitedFiles += 1
        let detectedBy
        if (isDockerfileName(entry.name)) {
          detectedBy = 'name'
        } else if (path.extname(entry.name) === '') {
          const head = await readHead(fullPath, probeBytes)
          if (head === null || !looksLikeDockerfile(head)) continue
          detectedBy = 'content'
        } else {
          continue
        }
        let info
        try {
          info = await stat(fullPath)
        } catch {
          continue
        }
        if (!info.isFile()) continue
        if (files.length >= maxDockerfiles) {
          truncated = true
          stopped = true
          break
        }
        files.push({
          path: fullPath,
          relativePath: path.relative(root, fullPath),
          root,
          name: entry.name,
          size: info.size,
          modifiedAt: new Date(info.mtimeMs).toISOString(),
          detectedBy,
        })
      }
    }
  }

  files.sort((left, right) => {
    if (left.relativePath !== right.relativePath) return left.relativePath < right.relativePath ? -1 : 1
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  })

  return { roots, files, visitedFiles, truncated, errors }
}

/**
 * Tokenize a Dockerfile argument string, honouring single and double quotes.
 *
 * @param {string} text - the raw argument text.
 * @returns {string[]} the tokens.
 */
function tokenize(text) {
  /** @type {string[]} */
  const tokens = []
  let current = ''
  let quote = ''
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (quote !== '') {
      if (character === quote) {
        quote = ''
        continue
      }
      if (character === '\\' && quote === '"') {
        escaped = true
        continue
      }
      current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '\\') {
      const next = text[index + 1]
      if (next === undefined || next === '"' || next === "'" || next === '\\' || /\s/u.test(next)) {
        escaped = true
        continue
      }
      current += character
      continue
    }
    if (/\s/u.test(character)) {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += character
  }
  if (current !== '') tokens.push(current)
  return tokens
}

/**
 * Strip one layer of matching single or double quotes.
 *
 * @param {string} value - a token.
 * @returns {string} the unquoted token.
 */
function unquote(value) {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' || first === "'") && first === last) return value.slice(1, -1)
  }
  return value
}

/**
 * Parse `key=value …` / legacy `key value` argument lists (ENV, LABEL).
 *
 * @param {unknown} args - the instruction's argument text.
 * @returns {{ key: string, value: string | null }[]} the pairs.
 */
function parseKeyValuePairs(args) {
  const trimmed = String(args ?? '').trim()
  if (trimmed === '') return []
  const tokens = tokenize(trimmed)
  if (tokens.some((token) => token.includes('='))) {
    /** @type {{ key: string, value: string | null }[]} */
    const pairs = []
    for (const token of tokens) {
      const index = token.indexOf('=')
      if (index === -1) continue
      const key = token.slice(0, index)
      if (!KEY_PATTERN.test(key)) continue
      pairs.push({ key, value: token.slice(index + 1) })
    }
    return pairs
  }
  const [key, ...rest] = tokens
  if (key === undefined || !KEY_PATTERN.test(key)) return []
  const value = rest.join(' ')
  return [{ key, value: value === '' ? null : value }]
}

/**
 * Parse an ARG instruction into its declared names and defaults.
 *
 * @param {unknown} args - an ARG instruction's argument text.
 * @returns {{ name: string, value: string | null }[]} the declarations.
 */
function parseArgDefinitions(args) {
  /** @type {{ name: string, value: string | null }[]} */
  const definitions = []
  for (const token of tokenize(String(args ?? '').trim())) {
    const index = token.indexOf('=')
    const name = index === -1 ? token : token.slice(0, index)
    if (!KEY_PATTERN.test(name)) continue
    definitions.push({ name, value: index === -1 ? null : token.slice(index + 1) })
  }
  return definitions
}

/**
 * Expand `$NAME` / `${NAME}` / `${NAME:-fallback}` against the build arguments
 * seen so far. An unknown variable without a fallback is kept verbatim so the
 * panel can show what the file actually says.
 *
 * @param {string} value - the raw argument text.
 * @param {Map<string, string | null>} argValues - build arguments seen so far.
 * @returns {string} the expanded text.
 */
function expandArguments(value, argValues) {
  if (typeof value !== 'string' || value === '') return value
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_.-]*)(?::-([^}]*))?\}/gu, (match, name, fallback) => {
      const resolved = argValues.get(name)
      if (typeof resolved === 'string' && resolved !== '') return resolved
      if (typeof fallback === 'string') return fallback
      return match
    })
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/gu, (match, name) => {
      const resolved = argValues.get(name)
      return typeof resolved === 'string' && resolved !== '' ? resolved : match
    })
}

/**
 * @param {unknown} value - a candidate.
 * @returns {string[]} valid list entries.
 */
function stringList(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []
}

/**
 * Parse EXPOSE ports, stripping the protocol suffix.
 *
 * @param {unknown} args - the argument text.
 * @returns {string[]} the ports.
 */
function parseExposedPorts(args) {
  return tokenize(String(args ?? '').trim())
    .map((token) => token.replace(/\/(?:tcp|udp)$/iu, ''))
    .filter((port) => port !== '')
}

/**
 * Parse VOLUME values (JSON array or whitespace-separated words).
 *
 * @param {unknown} args - the argument text.
 * @returns {string[]} the volume paths.
 */
function parseVolumes(args) {
  const trimmed = String(args ?? '').trim()
  if (trimmed.startsWith('[')) {
    const parsed = tryParseJson(trimmed)
    const list = stringList(parsed)
    if (list.length > 0) return list.map(unquote)
  }
  return tokenize(trimmed).map(unquote).filter((entry) => entry !== '')
}

/**
 * Normalize a CMD/ENTRYPOINT value: exec-form JSON arrays become a plain
 * command line, shell form is kept as written.
 *
 * @param {unknown} args - the argument text.
 * @returns {string | null} the command, or null when absent.
 */
function formatCommand(args) {
  const trimmed = String(args ?? '').trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('[')) {
    const parsed = tryParseJson(trimmed)
    if (Array.isArray(parsed)) {
      const parts = stringList(parsed)
      if (parts.length > 0) return parts.join(' ')
    }
  }
  return trimmed
}

/**
 * Parse a FROM instruction (skipping `--platform=…` style flags).
 *
 * @param {unknown} args - the argument text.
 * @returns {{ baseImage: string | null, name: string | null }} the stage header.
 */
function parseFrom(args) {
  const tokens = tokenize(String(args ?? '').trim())
  let index = 0
  while (index < tokens.length && tokens[index].startsWith('--')) index += 1
  const baseImage = index < tokens.length && tokens[index] !== '' ? tokens[index] : null
  index += 1
  let name = null
  if (index < tokens.length && tokens[index].toUpperCase() === 'AS') {
    const alias = tokens[index + 1]
    name = alias !== undefined && alias !== '' ? alias : null
  }
  return { baseImage, name }
}

/**
 * @param {unknown[]} list - a list to append to.
 * @param {unknown} values - candidate values.
 * @returns {void}
 */
function pushUnique(list, values) {
  for (const value of values) {
    if (typeof value === 'string' && value !== '' && !list.includes(value)) list.push(value)
  }
}

/**
 * The shape an unparsable/empty document returns.
 *
 * @returns {object} an empty parse result.
 */
function emptyParsed() {
  return {
    instructions: [],
    stages: [],
    parserDirectives: [],
    instructionCount: 0,
    stageCount: 0,
    multiStage: false,
    baseImages: [],
    finalBaseImage: null,
    exposedPorts: [],
    workdir: null,
    user: null,
    entrypoint: null,
    cmd: null,
    command: null,
    volumes: [],
    envKeys: [],
    env: [],
    argNames: [],
    labelKeys: [],
    healthcheck: false,
    copyCount: 0,
    runCount: 0,
    warnings: [],
  }
}

/**
 * Parse one Dockerfile's text.
 *
 * Pure and synchronous. Unknown instructions, missing stages and empty
 * documents become warnings; malformed input never throws.
 *
 * @param {unknown} content - the Dockerfile text.
 * @returns {object} the parsed summary.
 */
export function parseDockerfile(content) {
  try {
    return parseDockerfileText(typeof content === 'string' ? content : '')
  } catch (error) {
    const parsed = emptyParsed()
    parsed.warnings.push({ line: 0, message: `could not parse the Dockerfile: ${messageOf(error)}` })
    return parsed
  }
}

/**
 * The throwing-free body of {@link parseDockerfile}.
 *
 * @param {string} content - the Dockerfile text.
 * @returns {object} the parsed summary.
 */
function parseDockerfileText(content) {
  const parsed = emptyParsed()
  /** @type {string[]} */
  const lines = content.split(/\r?\n/u)

  // Parser directives are only the contiguous `# key=value` lines at the top.
  for (const line of lines) {
    const match = /^#\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.+?)\s*$/u.exec(line.trim())
    if (match === null) break
    parsed.parserDirectives.push(`${match[1].toLowerCase()}=${match[2]}`)
  }

  /** @type {object[]} */
  const instructions = []
  /** @type {object[]} */
  const stages = []
  /** @type {{ envKeys: string[], env: { key: string, value: string | null }[] }[]} */
  const stageData = []
  let currentStage = null
  let currentData = null
  /** @type {string[]} */
  let globalArgNames = []
  /** @type {Map<string, string | null>} */
  const argValues = new Map()
  const warnings = parsed.warnings

  let index = 0
  while (index < lines.length) {
    const lineNumber = index + 1
    let logical = lines[index]
    index += 1
    const trimmed = logical.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    while (/\\\s*$/u.test(logical)) {
      logical = logical.replace(/\\\s*$/u, '').replace(/\s+$/u, '')
      let consumed = false
      while (index < lines.length) {
        const nextLine = lines[index]
        const nextTrimmed = nextLine.trim()
        index += 1
        if (nextTrimmed.startsWith('#')) continue
        if (nextTrimmed === '') continue
        logical += ` ${nextTrimmed}`
        consumed = true
        break
      }
      if (!consumed) break
    }
    const logicalTrimmed = logical.trim()
    if (logicalTrimmed === '') continue
    const match = /^(\S+)\s*([\s\S]*)$/u.exec(logicalTrimmed)
    if (match === null) continue
    const instruction = match[1].toUpperCase()
    const args = match[2].trim()
    const known = KNOWN_INSTRUCTIONS.has(instruction)
    if (!known) warnings.push({ line: lineNumber, message: `unknown instruction "${match[1]}"` })
    instructions.push({
      instruction,
      args,
      line: lineNumber,
      explanationKey: known ? instruction.toLowerCase() : 'other',
    })

    if (instruction === 'FROM') {
      const header = parseFrom(args)
      if (header.baseImage === null) warnings.push({ line: lineNumber, message: 'FROM needs a base image' })
      // Docker expands build args declared before the FROM (`FROM ${BASE}`),
      // which is how most multi-stage files parameterize their base image.
      const expandedBase = header.baseImage === null ? null : expandArguments(header.baseImage, argValues)
      currentStage = {
        index: stages.length,
        baseImage: expandedBase === null || expandedBase === '' ? null : expandedBase,
        name: header.name,
        instructions: 1,
        exposedPorts: [],
        workdir: null,
        user: null,
        entrypoint: null,
        cmd: null,
        volumes: [],
        envKeys: [],
        argNames: [],
        labelKeys: [],
        healthcheck: false,
        copyCount: 0,
        addCount: 0,
        runCount: 0,
      }
      currentData = { envKeys: [], env: [] }
      stages.push(currentStage)
      stageData.push(currentData)
      continue
    }

    if (currentStage === null) {
      if (instruction === 'ARG') {
        const definitions = parseArgDefinitions(args)
        if (definitions.length === 0) warnings.push({ line: lineNumber, message: 'ARG needs a name' })
        for (const definition of definitions) {
          if (!globalArgNames.includes(definition.name)) globalArgNames.push(definition.name)
          if (definition.value !== null) argValues.set(definition.name, definition.value)
          else if (!argValues.has(definition.name)) argValues.set(definition.name, null)
        }
      } else {
        warnings.push({ line: lineNumber, message: `${instruction} appears before the first FROM` })
      }
      continue
    }

    currentStage.instructions += 1
    switch (instruction) {
      case 'ARG': {
        const definitions = parseArgDefinitions(args)
        if (definitions.length === 0) warnings.push({ line: lineNumber, message: 'ARG needs a name' })
        pushUnique(currentStage.argNames, definitions.map((definition) => definition.name))
        for (const definition of definitions) {
          if (definition.value !== null) argValues.set(definition.name, definition.value)
          else if (!argValues.has(definition.name)) argValues.set(definition.name, null)
        }
        break
      }
      case 'ENV': {
        const pairs = parseKeyValuePairs(args)
        if (pairs.length === 0) warnings.push({ line: lineNumber, message: 'ENV needs a key and a value' })
        for (const pair of pairs) {
          if (currentData === null) break
          const existing = currentData.env.find((entry) => entry.key === pair.key)
          if (existing !== undefined) {
            existing.value = pair.value
          } else {
            currentData.env.push({ key: pair.key, value: pair.value })
            currentData.envKeys.push(pair.key)
          }
        }
        if (currentData !== null) currentStage.envKeys = [...currentData.envKeys]
        break
      }
      case 'LABEL': {
        const pairs = parseKeyValuePairs(args)
        if (pairs.length === 0) warnings.push({ line: lineNumber, message: 'LABEL needs a key and a value' })
        pushUnique(currentStage.labelKeys, pairs.map((pair) => pair.key))
        break
      }
      case 'EXPOSE': {
        const ports = parseExposedPorts(args)
        if (ports.length === 0) warnings.push({ line: lineNumber, message: 'EXPOSE needs at least one port' })
        pushUnique(currentStage.exposedPorts, ports)
        break
      }
      case 'VOLUME': {
        const volumes = parseVolumes(args)
        if (volumes.length === 0) warnings.push({ line: lineNumber, message: 'VOLUME needs at least one path' })
        pushUnique(currentStage.volumes, volumes)
        break
      }
      case 'WORKDIR':
        currentStage.workdir = args === '' ? null : args
        break
      case 'USER':
        currentStage.user = args === '' ? null : args
        break
      case 'ENTRYPOINT':
        currentStage.entrypoint = formatCommand(args)
        break
      case 'CMD':
        currentStage.cmd = formatCommand(args)
        break
      case 'HEALTHCHECK':
        currentStage.healthcheck = true
        break
      case 'COPY':
        currentStage.copyCount += 1
        break
      case 'ADD':
        currentStage.addCount += 1
        break
      case 'RUN':
        currentStage.runCount += 1
        break
      default:
        // Known instructions with no summary effect (SHELL, STOPSIGNAL, …).
        break
    }
  }

  if (instructions.length === 0) {
    warnings.push({ line: 0, message: 'the Dockerfile is empty' })
  } else if (stages.length === 0) {
    warnings.push({ line: 0, message: 'no FROM instruction: nothing can be built' })
  }

  const finalStage = stages.length > 0 ? stages[stages.length - 1] : null
  const finalData = stageData.length > 0 ? stageData[stageData.length - 1] : null
  const entrypoint = finalStage === null ? null : finalStage.entrypoint
  const cmd = finalStage === null ? null : finalStage.cmd
  /** @type {string | null} */
  const command = entrypoint !== null && cmd !== null
    ? `${entrypoint} ${cmd}`
    : entrypoint !== null ? entrypoint : cmd

  parsed.instructions = instructions
  parsed.stages = stages
  parsed.instructionCount = instructions.length
  parsed.stageCount = stages.length
  parsed.multiStage = stages.length > 1
  parsed.baseImages = stages.map((stage) => stage.baseImage).filter((baseImage) => baseImage !== null)
  parsed.finalBaseImage = finalStage === null ? null : finalStage.baseImage
  // Ports and health checks describe "what this build file opens / checks", so
  // they are the union over every stage: a multi-stage file usually exposes its
  // ports and defines its health check in an earlier stage than the final one.
  /** @type {string[]} */
  const allExposedPorts = []
  for (const stage of stages) {
    for (const port of stage.exposedPorts) {
      if (!allExposedPorts.includes(port)) allExposedPorts.push(port)
    }
  }
  parsed.exposedPorts = allExposedPorts
  parsed.healthcheck = stages.some((stage) => stage.healthcheck)
  parsed.workdir = finalStage === null ? null : finalStage.workdir
  parsed.user = finalStage === null ? null : finalStage.user
  parsed.entrypoint = entrypoint
  parsed.cmd = cmd
  parsed.command = command
  parsed.volumes = finalStage === null ? [] : [...finalStage.volumes]
  parsed.envKeys = finalStage === null ? [] : [...finalStage.envKeys]
  parsed.env = finalData === null ? [] : finalData.env.map((entry) => ({ key: entry.key, value: entry.value }))
  parsed.argNames = finalStage === null ? [...globalArgNames] : [...finalStage.argNames]
  parsed.labelKeys = finalStage === null ? [] : [...finalStage.labelKeys]
  parsed.copyCount = finalStage === null ? 0 : finalStage.copyCount
  parsed.runCount = finalStage === null ? 0 : finalStage.runCount
  return parsed
}

/**
 * Read one Dockerfile's text, bounded.
 *
 * @param {string} filePath - the file to read.
 * @param {number} [maxBytes=262144] - maximum bytes of content returned.
 * @returns {Promise<{ path: string, content: string, size: number, truncated: boolean }>} the text.
 */
export async function readDockerfileText(filePath, maxBytes = 262144) {
  const limit = boundedInteger(maxBytes, 262144, 1)
  const handle = await open(filePath, 'r')
  try {
    const info = await handle.stat()
    const buffer = Buffer.alloc(Math.min(limit, info.size))
    const { bytesRead } = buffer.length > 0 ? await handle.read(buffer, 0, buffer.length, 0) : { bytesRead: 0 }
    return {
      path: filePath,
      content: buffer.toString('utf8', 0, bytesRead),
      size: info.size,
      truncated: bytesRead < info.size,
    }
  } finally {
    try {
      await handle.close()
    } catch {
      // The read already failed or finished; a close error changes nothing.
    }
  }
}

/**
 * Cheap probe for non-standard file names: does the text start like a
 * Dockerfile (a FROM instruction within the first 16 KiB)?
 *
 * @param {unknown} text - file content (or its prefix).
 * @returns {boolean} whether it looks like a Dockerfile.
 */
export function looksLikeDockerfile(text) {
  if (typeof text !== 'string' || text === '') return false
  return /^\s*FROM\s+\S+/imu.test(text.slice(0, CONTENT_PROBE_BYTES))
}

/**
 * Sanitize a directory name into a Docker tag component.
 *
 * @param {string} value - the directory base name.
 * @returns {string} a lowercase tag-safe component ('' when unusable).
 */
function sanitizeTag(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[^a-z0-9]+/u, '')
    .replace(/-+/gu, '-')
    .replace(/[-.]+$/u, '')
    .slice(0, 128)
}

/**
 * Derive the `docker build` context directory and a suggested image tag for a
 * recognised Dockerfile.
 *
 * @param {unknown} parsed - the result of {@link parseDockerfile} (unused values tolerated).
 * @param {{ path?: string }} file - the recognised file entry.
 * @returns {{ contextPath: string, suggestedTag: string }} the build hints.
 */
export function summarizeDockerfile(parsed, file) {
  const fileEntry = isRecord(file) ? file : {}
  const filePath = typeof fileEntry.path === 'string' ? fileEntry.path : ''
  const contextPath = filePath === '' ? '' : path.dirname(filePath)
  const tagBase = sanitizeTag(contextPath === '' ? '' : path.basename(contextPath))
  return { contextPath, suggestedTag: `${tagBase === '' ? 'image' : tagBase}:latest` }
}

export default {
  DEFAULT_SCAN,
  scanDockerfiles,
  parseDockerfile,
  readDockerfileText,
  looksLikeDockerfile,
  summarizeDockerfile,
}

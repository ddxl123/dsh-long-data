/**
 * Tests for the Dockerfile scanner/parser.
 *
 * Parser tests are pure string fixtures. Scanner tests build a temporary
 * directory tree (mkdtemp) so they exercise the real filesystem walk, including
 * ignored directories, depth/file/result limits, missing roots and symlinks.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import {
  DEFAULT_SCAN,
  looksLikeDockerfile,
  parseDockerfile,
  readDockerfileText,
  scanDockerfiles,
  summarizeDockerfile,
} from '../src/dockerfiles.js'

/**
 * A multi-stage Dockerfile touching every instruction the summary reports.
 */
const MULTI_STAGE = [
  '# syntax=docker/dockerfile:1.7',
  '# escape=\\',
  'ARG BASE_IMAGE=nginx:1.31.6',
  'FROM ${BASE_IMAGE} AS web',
  'ARG BUILD_ENV=production',
  'ENV NODE_ENV=$BUILD_ENV APP_HOME=/app',
  'ENV LEGACY_VALUE yes',
  'EXPOSE 80 443',
  'WORKDIR /app',
  'COPY --from=builder /out/app /app',
  'COPY package.json ./',
  'RUN npm ci',
  'VOLUME ["/data", "/logs"]',
  'HEALTHCHECK --interval=30s CMD wget -q -O /dev/null http://localhost/ || exit 1',
  'USER node',
  'CMD ["node", "server.js"]',
  '',
  'FROM node:22-alpine AS builder',
  'ARG BUILD_ENV',
  'ENV BUILD_ENV=$BUILD_ENV',
  'WORKDIR /build',
  'COPY . .',
  'RUN npm run build',
  'ENTRYPOINT ["/docker-entrypoint.sh"]',
  'CMD ["--help"]',
].join('\n')

/**
 * Create a throwaway directory that the test runner cleans up afterwards.
 *
 * @param {import('node:test').TestContext} t - the test context.
 * @returns {string} the absolute directory.
 */
function makeRoot(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-long-data-dockerfiles-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

/**
 * Write a file below a fixture root, creating parent directories.
 *
 * @param {string} root - fixture root.
 * @param {string} relativePath - slash-separated relative path.
 * @param {string} content - file content.
 * @returns {string} the absolute file path.
 */
function writeFile(root, relativePath, content) {
  const filePath = join(root, ...relativePath.split('/'))
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content)
  return filePath
}

test('DEFAULT_SCAN keeps the documented, frozen bounds', () => {
  assert.equal(Object.isFrozen(DEFAULT_SCAN), true)
  assert.equal(DEFAULT_SCAN.maxDepth, 6)
  assert.equal(DEFAULT_SCAN.maxFiles, 4000)
  assert.equal(DEFAULT_SCAN.maxDockerfiles, 100)
  assert.equal(DEFAULT_SCAN.maxBytes, 1048576)
  assert.ok(Array.isArray(DEFAULT_SCAN.ignoreDirs))
  for (const name of ['node_modules', '.git', 'dist', 'build', 'target', 'Library', 'DerivedData', 'site-packages', 'Pods']) {
    assert.ok(DEFAULT_SCAN.ignoreDirs.includes(name), `${name} must be ignored by default`)
  }
})

test('parseDockerfile parses a multi-stage build', () => {
  const parsed = parseDockerfile(MULTI_STAGE)
  assert.deepEqual(parsed.parserDirectives, ['syntax=docker/dockerfile:1.7', 'escape=\\'])
  assert.deepEqual({
    instructionCount: parsed.instructionCount,
    stageCount: parsed.stageCount,
    multiStage: parsed.multiStage,
    baseImages: parsed.baseImages,
    finalBaseImage: parsed.finalBaseImage,
    exposedPorts: parsed.exposedPorts,
    workdir: parsed.workdir,
    user: parsed.user,
    entrypoint: parsed.entrypoint,
    cmd: parsed.cmd,
    command: parsed.command,
    volumes: parsed.volumes,
    envKeys: parsed.envKeys,
    env: parsed.env,
    argNames: parsed.argNames,
    labelKeys: parsed.labelKeys,
    healthcheck: parsed.healthcheck,
    copyCount: parsed.copyCount,
    runCount: parsed.runCount,
    warnings: parsed.warnings,
  }, {
    instructionCount: 22,
    stageCount: 2,
    multiStage: true,
    baseImages: ['nginx:1.31.6', 'node:22-alpine'],
    finalBaseImage: 'node:22-alpine',
    exposedPorts: ['80', '443'],
    workdir: '/build',
    user: null,
    entrypoint: '/docker-entrypoint.sh',
    cmd: '--help',
    command: '/docker-entrypoint.sh --help',
    volumes: [],
    envKeys: ['BUILD_ENV'],
    env: [{ key: 'BUILD_ENV', value: '$BUILD_ENV' }],
    argNames: ['BUILD_ENV'],
    labelKeys: [],
    healthcheck: true,
    copyCount: 1,
    runCount: 1,
    warnings: [],
  })
  assert.deepEqual(parsed.stages, [
    {
      index: 0,
      baseImage: 'nginx:1.31.6',
      name: 'web',
      instructions: 13,
      exposedPorts: ['80', '443'],
      workdir: '/app',
      user: 'node',
      entrypoint: null,
      cmd: 'node server.js',
      volumes: ['/data', '/logs'],
      envKeys: ['NODE_ENV', 'APP_HOME', 'LEGACY_VALUE'],
      argNames: ['BUILD_ENV'],
      labelKeys: [],
      healthcheck: true,
      copyCount: 2,
      addCount: 0,
      runCount: 1,
    },
    {
      index: 1,
      baseImage: 'node:22-alpine',
      name: 'builder',
      instructions: 8,
      exposedPorts: [],
      workdir: '/build',
      user: null,
      entrypoint: '/docker-entrypoint.sh',
      cmd: '--help',
      volumes: [],
      envKeys: ['BUILD_ENV'],
      argNames: ['BUILD_ENV'],
      labelKeys: [],
      healthcheck: false,
      copyCount: 1,
      addCount: 0,
      runCount: 1,
    },
  ])
  assert.deepEqual(parsed.instructions[0], {
    instruction: 'ARG',
    args: 'BASE_IMAGE=nginx:1.31.6',
    line: 3,
    explanationKey: 'arg',
  })
  assert.deepEqual(parsed.instructions.map((instruction) => instruction.explanationKey).slice(0, 2), ['arg', 'from'])
})

test('parseDockerfile handles line continuations and CRLF line endings', () => {
  const parsed = parseDockerfile(
    'FROM alpine:3.20\r\nRUN echo hello \\\r\n    && echo world\r\nCOPY a \\\r\n     b /dst/\r\nENV GREETING=hi\r\n',
  )
  assert.deepEqual(parsed.instructions.map((entry) => ({ instruction: entry.instruction, args: entry.args, line: entry.line })), [
    { instruction: 'FROM', args: 'alpine:3.20', line: 1 },
    { instruction: 'RUN', args: 'echo hello && echo world', line: 2 },
    { instruction: 'COPY', args: 'a b /dst/', line: 4 },
    { instruction: 'ENV', args: 'GREETING=hi', line: 6 },
  ])
  assert.deepEqual(parsed.env, [{ key: 'GREETING', value: 'hi' }])
  assert.equal(parsed.runCount, 1)
  assert.deepEqual(parsed.warnings, [])
})

test('parseDockerfile parses ENV syntaxes, ARG, EXPOSE, VOLUME, LABEL and exec commands', () => {
  const parsed = parseDockerfile([
    'FROM scratch',
    'ENV KEY=value OTHER="two words" EMPTY=',
    'ENV LEGACY some value',
    'ARG FOO=bar BAZ',
    'EXPOSE 8080/udp 9090/tcp 53',
    'VOLUME /data /logs',
    'VOLUME ["/cache"]',
    'LABEL maintainer="me" version=1',
    'COPY --from=build /a /b',
    'HEALTHCHECK NONE',
    'USER 1000:1000',
    'WORKDIR /srv',
    'ENTRYPOINT ["ep", "arg"]',
    'CMD exec form here',
  ].join('\n'))
  assert.deepEqual(parsed.env, [
    { key: 'KEY', value: 'value' },
    { key: 'OTHER', value: 'two words' },
    { key: 'EMPTY', value: '' },
    { key: 'LEGACY', value: 'some value' },
  ])
  assert.deepEqual(parsed.envKeys, ['KEY', 'OTHER', 'EMPTY', 'LEGACY'])
  assert.deepEqual(parsed.argNames, ['FOO', 'BAZ'])
  assert.deepEqual(parsed.exposedPorts, ['8080', '9090', '53'])
  assert.deepEqual(parsed.volumes, ['/data', '/logs', '/cache'])
  assert.deepEqual(parsed.labelKeys, ['maintainer', 'version'])
  assert.equal(parsed.copyCount, 1)
  assert.equal(parsed.healthcheck, true)
  assert.equal(parsed.user, '1000:1000')
  assert.equal(parsed.workdir, '/srv')
  assert.equal(parsed.entrypoint, 'ep arg')
  assert.equal(parsed.cmd, 'exec form here')
  assert.equal(parsed.command, 'ep arg exec form here')
  assert.equal(parsed.stages[0].instructions, 14)
})

test('parseDockerfile expands ARG defaults in FROM and keeps unknown placeholders', () => {
  const parsed = parseDockerfile([
    'ARG BASE=nginx:1.31.6',
    'ARG TAG',
    'FROM ${BASE} AS web',
    'FROM ${TAG:-alpine:3.20} AS fallback',
    'FROM ${UNSET} AS raw',
  ].join('\n'))
  assert.deepEqual(parsed.baseImages, ['nginx:1.31.6', 'alpine:3.20', '${UNSET}'])
  assert.deepEqual(parsed.stages.map((stage) => stage.baseImage), ['nginx:1.31.6', 'alpine:3.20', '${UNSET}'])
  // The instruction text keeps what the file says, before expansion.
  assert.equal(parsed.instructions[2].args, '${BASE} AS web')
  assert.deepEqual(parsed.warnings, [])
})

test('parseDockerfile skips FROM platform flags', () => {
  const parsed = parseDockerfile('FROM --platform=linux/arm64 alpine:3.20 AS base\nCMD ["true"]')
  assert.equal(parsed.stages.length, 1)
  assert.equal(parsed.stages[0].baseImage, 'alpine:3.20')
  assert.equal(parsed.stages[0].name, 'base')
  assert.deepEqual(parsed.warnings, [])
})

test('parseDockerfile warns on empty and comment-only documents', () => {
  const empty = parseDockerfile('')
  assert.equal(empty.instructionCount, 0)
  assert.equal(empty.stageCount, 0)
  assert.equal(empty.multiStage, false)
  assert.equal(empty.finalBaseImage, null)
  assert.deepEqual(empty.stages, [])
  assert.deepEqual(empty.instructions, [])
  assert.equal(empty.warnings.length, 1)
  assert.match(empty.warnings[0].message, /empty/u)

  const comments = parseDockerfile('# just a comment\n\n   \n# another\n')
  assert.equal(comments.instructionCount, 0)
  assert.equal(comments.warnings.length, 1)
})

test('parseDockerfile warns on garbage content but never throws', () => {
  const parsed = parseDockerfile('NOT A DOCKERFILE\n@#$%^&*(\n')
  assert.equal(parsed.stageCount, 0)
  assert.ok(parsed.instructions.length >= 1)
  assert.ok(parsed.warnings.some((warning) => /unknown instruction/u.test(warning.message)))
  assert.ok(parsed.warnings.some((warning) => /no FROM/u.test(warning.message)))
  assert.equal(parsed.instructions[0].explanationKey, 'other')

  for (const value of [undefined, null, 42, true, { text: 'FROM alpine' }]) {
    const result = parseDockerfile(value)
    assert.equal(result.stageCount, 0)
    assert.ok(Array.isArray(result.warnings))
  }
  // Unbalanced quotes and NUL bytes are tolerated too.
  assert.doesNotThrow(() => parseDockerfile('FROM alpine\nCMD ["unterminated\nRUN \u0000'))
})

test('parseDockerfile only treats leading # key=value lines as parser directives', () => {
  const parsed = parseDockerfile('# escape=\\\n# plain comment\n# syntax=docker/dockerfile:1\nFROM alpine')
  assert.deepEqual(parsed.parserDirectives, ['escape=\\'])
  assert.equal(parsed.instructionCount, 1)
  assert.equal(parsed.stageCount, 1)
})

test('looksLikeDockerfile requires a FROM at the start of a line', () => {
  assert.equal(looksLikeDockerfile('FROM nginx:1.31.6\nRUN true'), true)
  assert.equal(looksLikeDockerfile('  \nFROM node:22 AS build'), true)
  assert.equal(looksLikeDockerfile('#!/bin/sh\nFROM node:22\n'), true)
  assert.equal(looksLikeDockerfile('RUN echo hi\n'), false)
  assert.equal(looksLikeDockerfile('# FROM alpine\n'), false)
  assert.equal(looksLikeDockerfile(''), false)
  assert.equal(looksLikeDockerfile(null), false)
})

test('scanDockerfiles recognises names, Containerfile and content-prone files', async (t) => {
  const root = makeRoot(t)
  writeFile(root, 'Dockerfile', 'FROM alpine:3.20\nRUN true\n')
  writeFile(root, 'Dockerfile.dev', 'FROM node:22-alpine\nCMD ["npm", "start"]\n')
  // A lowercase name lives in its own directory: macOS filesystems are
  // case-insensitive, so it would otherwise overwrite the `Dockerfile` above.
  writeFile(root, 'case/dockerfile', 'FROM scratch\n')
  writeFile(root, 'app.dockerfile', 'FROM nginx:1.31.6\nEXPOSE 80\n')
  writeFile(root, 'Containerfile', 'FROM debian:12\n')
  writeFile(root, 'weird-build', 'FROM busybox:1.36\nRUN echo hi\n')
  writeFile(root, 'helper', '#!/bin/sh\necho hi\n')
  writeFile(root, 'notes.md', 'FROM alpine\n')
  writeFile(root, 'deep/Dockerfile', 'FROM python:3.12\n')
  writeFile(root, 'node_modules/pkg/Dockerfile', 'FROM alpine\n')
  writeFile(root, 'skipme/Dockerfile', 'FROM alpine\n')

  const result = await scanDockerfiles({ roots: [root], ignoreDirs: ['skipme'] })
  assert.deepEqual(result.roots, [root])
  assert.deepEqual(result.errors, [])
  assert.equal(result.truncated, false)
  assert.equal(result.visitedFiles, 9)
  assert.deepEqual(result.files.map((file) => file.relativePath), [
    'Containerfile',
    'Dockerfile',
    'Dockerfile.dev',
    'app.dockerfile',
    'case/dockerfile',
    'deep/Dockerfile',
    'weird-build',
  ])
  assert.deepEqual(result.files.map((file) => file.detectedBy), [
    'name', 'name', 'name', 'name', 'name', 'name', 'content',
  ])
  const first = result.files[0]
  assert.equal(first.name, 'Containerfile')
  assert.equal(first.root, root)
  assert.equal(first.path, join(root, 'Containerfile'))
  assert.equal(first.size, Buffer.byteLength('FROM debian:12\n'))
  assert.equal(typeof first.modifiedAt, 'string')
  assert.ok(Number.isFinite(Date.parse(first.modifiedAt)))
})

test('scanDockerfiles respects ignoreDirs and skips symlinked directories and files', async (t) => {
  const root = makeRoot(t)
  writeFile(root, 'dist/Dockerfile', 'FROM alpine\n')
  writeFile(root, '.git/Dockerfile', 'FROM alpine\n')
  writeFile(root, 'custom-ignore/Dockerfile', 'FROM alpine\n')
  writeFile(root, 'real/Dockerfile', 'FROM alpine\n')
  try {
    symlinkSync(join(root, 'real'), join(root, 'linked'), 'dir')
    symlinkSync(join(root, 'real', 'Dockerfile'), join(root, 'Dockerfile.link'), 'file')
  } catch (error) {
    t.skip(`symlinks are not available here: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  const result = await scanDockerfiles({ roots: [root], ignoreDirs: ['custom-ignore'] })
  assert.deepEqual(result.files.map((file) => file.relativePath), ['real/Dockerfile'])
  assert.equal(result.errors.length, 0)
})

test('scanDockerfiles bounds the depth and flags truncation', async (t) => {
  const root = makeRoot(t)
  writeFile(root, 'Dockerfile', 'FROM alpine\n')
  writeFile(root, 'a/Dockerfile', 'FROM alpine\n')
  writeFile(root, 'a/b/Dockerfile', 'FROM alpine\n')
  writeFile(root, 'a/b/c/Dockerfile', 'FROM alpine\n')

  const shallow = await scanDockerfiles({ roots: [root], maxDepth: 1 })
  assert.deepEqual(shallow.files.map((file) => file.relativePath), ['Dockerfile', 'a/Dockerfile'])
  assert.equal(shallow.truncated, true)

  const deep = await scanDockerfiles({ roots: [root], maxDepth: 6 })
  assert.deepEqual(deep.files.map((file) => file.relativePath), [
    'Dockerfile',
    'a/Dockerfile',
    'a/b/Dockerfile',
    'a/b/c/Dockerfile',
  ])
  assert.equal(deep.truncated, false)
})

test('scanDockerfiles bounds visited files', async (t) => {
  const root = makeRoot(t)
  writeFile(root, 'Dockerfile', 'FROM alpine\n')
  writeFile(root, 'aaa.txt', 'x')

  const tight = await scanDockerfiles({ roots: [root], maxFiles: 1 })
  assert.equal(tight.visitedFiles, 1)
  assert.deepEqual(tight.files.map((file) => file.relativePath), ['Dockerfile'])
  assert.equal(tight.truncated, true)

  const loose = await scanDockerfiles({ roots: [root], maxFiles: 2 })
  assert.equal(loose.visitedFiles, 2)
  assert.deepEqual(loose.files.map((file) => file.relativePath), ['Dockerfile'])
  assert.equal(loose.truncated, false)
})

test('scanDockerfiles bounds the number of results', async (t) => {
  const root = makeRoot(t)
  writeFile(root, 'Dockerfile', 'FROM alpine\n')
  writeFile(root, 'Dockerfile.a', 'FROM alpine\n')
  writeFile(root, 'Dockerfile.b', 'FROM alpine\n')

  const result = await scanDockerfiles({ roots: [root], maxDockerfiles: 1 })
  assert.deepEqual(result.files.map((file) => file.relativePath), ['Dockerfile'])
  assert.equal(result.truncated, true)
})

test('scanDockerfiles reports missing, relative and non-directory roots', async (t) => {
  const root = makeRoot(t)
  const fileRoot = writeFile(root, 'plain.txt', 'hi')
  const missing = join(root, 'missing')

  const result = await scanDockerfiles({ roots: [missing, 'relative/path', fileRoot, ''] })
  assert.deepEqual(result.roots, [missing, fileRoot])
  assert.deepEqual(result.files, [])
  assert.equal(result.visitedFiles, 0)
  assert.equal(result.errors.length, 3)
  // The relative root is rejected during validation, before any walk starts.
  assert.equal(result.errors[0].root, 'relative/path')
  assert.match(result.errors[0].message, /absolute/u)
  assert.equal(result.errors[1].root, missing)
  assert.match(result.errors[1].message, /ENOENT|no such file/iu)
  assert.equal(result.errors[2].root, fileRoot)
  assert.match(result.errors[2].message, /not a directory/u)
})

test('scanDockerfiles handles empty options and empty roots', async () => {
  const none = await scanDockerfiles()
  assert.deepEqual(none.roots, [])
  assert.deepEqual(none.files, [])
  assert.equal(none.visitedFiles, 0)
  assert.equal(none.truncated, false)
  assert.deepEqual(none.errors, [])

  const blank = await scanDockerfiles({ roots: ['', '   '] })
  assert.deepEqual(blank.roots, [])
  assert.deepEqual(blank.files, [])
})

test('readDockerfileText bounds the content it returns', async (t) => {
  const root = makeRoot(t)
  const filePath = writeFile(root, 'Dockerfile', 'x'.repeat(1000))

  const truncated = await readDockerfileText(filePath, 100)
  assert.equal(truncated.path, filePath)
  assert.equal(truncated.size, 1000)
  assert.equal(truncated.content.length, 100)
  assert.equal(truncated.truncated, true)

  const complete = await readDockerfileText(filePath, 5000)
  assert.equal(complete.content.length, 1000)
  assert.equal(complete.truncated, false)

  const standard = await readDockerfileText(filePath)
  assert.equal(standard.content.length, 1000)
  await assert.rejects(readDockerfileText(join(root, 'missing')))
})

test('summarizeDockerfile derives the build context and a tag', () => {
  assert.deepEqual(summarizeDockerfile({}, { path: '/tmp/My App/Dockerfile' }), {
    contextPath: '/tmp/My App',
    suggestedTag: 'my-app:latest',
  })
  assert.deepEqual(summarizeDockerfile({}, { path: '/tmp/Project_V1/Dockerfile' }), {
    contextPath: '/tmp/Project_V1',
    suggestedTag: 'project_v1:latest',
  })
  assert.deepEqual(summarizeDockerfile({}, {}), { contextPath: '', suggestedTag: 'image:latest' })
})

test('per-Dockerfile .dockerignore helper files are not recognized', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-long-data-dockerignore-'))
  try {
    writeFileSync(join(root, 'Dockerfile'), 'FROM alpine:3.20\n')
    writeFileSync(join(root, 'Dockerfile.dockerignore'), 'node_modules\n.git\n')
    const result = await scanDockerfiles({ roots: [root] })
    assert.deepEqual(result.files.map((file) => file.name), ['Dockerfile'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

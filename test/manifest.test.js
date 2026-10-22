/**
 * Manifest and packaging checks.
 *
 * These are static assertions about the files that make the bundle installable
 * and displayable: the package manifest, the Loader patch, the locale metadata,
 * the icon, and the "builtins only" dependency rule. They need no running
 * harness and no browser, so they stay valid as the implementation changes.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE_PATH = fileURLToPath(new URL('../package.json', import.meta.url))
const PATCH_PATH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const ICON_PATH = fileURLToPath(new URL('../icon.svg', import.meta.url))

/** @type {any} */
const manifest = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'))

/**
 * @param {string} relative - path below the package root.
 * @returns {string} absolute path.
 */
function at(relative) {
  return `${ROOT}${relative}`
}

test('package.json declares the bundle, client half and display metadata', () => {
  assert.equal(manifest.name, 'dsh-long-data')
  assert.equal(manifest.private, undefined)
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.main, 'src/index.js')
  assert.equal(manifest.icon, './icon.svg')
  assert.equal(typeof manifest.dsh.plugin.title, 'string')
  assert.ok(manifest.dsh.plugin.title.length > 0)
  assert.equal(typeof manifest.dsh.plugin.summary, 'string')
  assert.ok(manifest.dsh.plugin.summary.length > 10)
  for (const entry of ['.', './client', './locale/*.json', './icon', './cordis.patch.yml']) {
    assert.ok(manifest.exports[entry] !== undefined, `exports must contain ${entry}`)
  }
  for (const file of ['src', 'client', 'locale', 'icon.svg', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'LICENSE']) {
    assert.ok(manifest.files.includes(file), `files must include ${file}`)
  }
  assert.deepEqual(manifest.dependencies, undefined, 'the plugin must not have runtime dependencies')
  assert.deepEqual(manifest.peerDependencies, undefined, 'a page-only plugin needs no harness peer')
})

test('every file the manifest promises exists', () => {
  for (const relative of [
    'src/index.js',
    'src/targets.js',
    'src/relations.js',
    'src/roles.js',
    'src/dockerfiles.js',
    'client/index.js',
    'cordis.patch.yml',
    'icon.svg',
    'locale/en.json',
    'locale/zh.json',
    'README.md',
    'README.zh.md',
    'LICENSE',
  ]) {
    assert.equal(existsSync(at(relative)), true, `${relative} must exist`)
  }
})

test('the Loader patch inserts exactly one host-plane row', () => {
  const patch = readFileSync(PATCH_PATH, 'utf8')
  assert.match(patch, /- insert:/)
  assert.match(patch, /id: dsh-long-data/)
  assert.match(patch, /name: 'dsh-long-data'/)
  assert.match(patch, /settingsFile: settings\.json/)
  assert.match(patch, /redis:/)
  assert.match(patch, /postgres:/)
  assert.match(patch, /binary: docker/)
  assert.match(patch, /mode: docker/)
  assert.match(patch, /dockerfiles:/)
  assert.match(patch, /maxDepth: 6/)
  assert.match(patch, /container: ''/)
})

test('locale resources carry real titles and descriptions in both languages', () => {
  for (const locale of ['en', 'zh']) {
    const document = JSON.parse(readFileSync(at(`locale/${locale}.json`), 'utf8'))
    assert.equal(typeof document.meta.title, 'string', `${locale} title`)
    assert.ok(document.meta.title.trim().length > 0, `${locale} title must not be empty`)
    assert.equal(typeof document.meta.description, 'string', `${locale} description`)
    assert.ok(document.meta.description.trim().length > 20, `${locale} description must describe the capability`)
    assert.doesNotMatch(document.meta.title, /my-|template|decoration/i, `${locale} title must not keep template copy`)
  }
  const en = JSON.parse(readFileSync(at('locale/en.json'), 'utf8'))
  const zh = JSON.parse(readFileSync(at('locale/zh.json'), 'utf8'))
  assert.notEqual(en.meta.title, zh.meta.title, 'the localized title must actually be translated')
})

test('the icon is a small, valid SVG with a viewBox', () => {
  assert.equal(existsSync(ICON_PATH), true)
  const icon = readFileSync(ICON_PATH, 'utf8')
  assert.match(icon.trimStart(), /^<svg[\s>]/)
  assert.match(icon, /viewBox="0 0 \d+ \d+"/)
  assert.ok(statSync(ICON_PATH).size <= 256 * 1024, 'the icon must stay under 256 KiB')
})

test('the reported version matches package.json', () => {
  const source = readFileSync(at('src/ops.js'), 'utf8')
  const match = source.match(/export const VERSION = '([^']+)'/)
  assert.ok(match !== null, 'src/ops.js must export VERSION')
  assert.equal(match[1], manifest.version)
})

test('Host modules import only Node builtins and sibling files', () => {
  const directory = at('src/')
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.js'))) {
    const source = readFileSync(`${directory}${file}`, 'utf8')
    for (const match of source.matchAll(/(?:from|import)\s+'([^']+)'/g)) {
      const specifier = match[1]
      const allowed = specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../')
      assert.equal(allowed, true, `${file} must not import ${specifier}`)
    }
    assert.doesNotMatch(source, /\brequire\s*\(/, `${file} must stay ESM`)
  }
})

test('the plugin registers no model-facing tool or prompt contribution', () => {
  const index = readFileSync(at('src/index.js'), 'utf8')
  assert.doesNotMatch(index, /tools|systemPrompt|inject\(\['tools'\]/, 'a page-only plugin must not touch the tool surface')
  assert.doesNotMatch(index, /@deepseek-ai\//, 'the Host half must not import harness packages')
})

test('the browser half covers the v0.3 pages and endpoints', () => {
  const source = readFileSync(at('client/index.js'), 'utf8')
  for (const needle of [
    'docker.relations',
    'dockerfiles.list',
    'dockerfiles.read',
    'docker.imageInspect',
    'docker.volumeInspect',
    'docker.networkInspect',
    'docker.diskUsage',
    'redis.clients',
    'redis.dbsize',
    'redis.rename',
    'redis.expire',
    'redis.persist',
    'redis.hashSet',
    'redis.listPush',
    'redis.setAdd',
    'pg.activity',
    'pg.tableDetail',
    'pg.browse',
    'instances',
  ]) {
    assert.ok(source.includes(needle), `the client must use ${needle}`)
  }
  assert.ok(source.includes('relations'), 'the relations page must be registered')
  assert.ok(source.includes('dockerfiles'), 'the Dockerfile sub-tab must be registered')
  assert.ok(source.includes('pg.statements') || source.includes('pg.query'), 'the SQL editor must stay wired')
})

test('the browser half covers the beginner-first v0.4 surface', () => {
  const source = readFileSync(at('client/index.js'), 'utf8')
  for (const needle of [
    'overview',
    'insights',
    'dsh-long-data:view-mode',
    'localStorage',
    'beginner',
    'expert',
    'glossary',
    'docker run',
    'role',
  ]) {
    assert.ok(source.includes(needle), `the client must implement ${needle}`)
  }
  // Both languages are present in the bundle itself (the dictionaries are inline).
  assert.ok(source.includes('概览'), 'the zh dictionary must contain the overview page')
  assert.ok(source.includes('Overview') || source.includes('overview'), 'the en dictionary must contain the overview page')
})

test('the stylesheet keeps the token-only, prefixed rule', () => {
  const source = readFileSync(at('client/index.js'), 'utf8')
  const match = source.match(/const css = `([\s\S]*?)`\n/)
  assert.ok(match !== null, 'the client must define one inline stylesheet')
  const css = match[1]
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'chrome must not use literal hex colors')
  assert.doesNotMatch(css, /rgba?\(/, 'chrome must not use literal rgb colors')
  const allowed = ['--dsw-alias-', '--dsw-radius-', '--dsw-elevation-', '--dsw-mask-', '--dsw-focus-ring-', '--dsw-frame-']
  for (const token of new Set([...css.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((entry) => entry[1]))) {
    assert.ok(allowed.some((prefix) => token.startsWith(prefix)), `unexpected token ${token}`)
  }
  for (const className of new Set([...css.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((entry) => entry[1]))) {
    assert.ok(className.startsWith('dshData'), `unprefixed class ${className}`)
  }
})

test('the browser half follows the module-loader contract', () => {
  const path = at('client/index.js')
  assert.equal(existsSync(path), true)
  const source = readFileSync(path, 'utf8')
  assert.doesNotMatch(source, /^\s*(import|export)\s/m, 'the client bundle must be a plain script')
  assert.doesNotMatch(source, /\bJSX\b/, 'no JSX')
  assert.doesNotMatch(source, /document\.body/, 'the client must not touch document.body')
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(source, /id: 'dsh-long-data'/)
  assert.match(source, /name: 'main'/)
  assert.match(source, /PANEL_ID = 'data'/, 'the panel id must be the documented "data" key')
  assert.match(source, /key: PANEL_ID/, 'the main registration must use the panel id')
  assert.match(source, /inject: \(\) => \(\{ client \}\)/, 'the panel component must receive the client')
  assert.match(source, /name: 'sidebar\.panellist'/)
  assert.match(source, /id: PANEL_ID/, 'the sidebar entry id must be the panel id')
  assert.match(source, /\/api\/dsh-long-data/)
  const requires = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((match) => match[1])
  assert.deepEqual([...new Set(requires)], ['react'], 'the client may require only react')
  assert.doesNotMatch(source, /@deepseek-ai\//, 'the client must not import Harness client packages')
})

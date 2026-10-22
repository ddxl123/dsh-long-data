/**
 * Tests for the plain-language role classification used by the beginner UI.
 * Roles are hints for wording only, so the tests pin the documented mapping.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ROLES, classifyRole, composeProject, imageSlug, roleOfImage } from '../src/roles.js'

test('every classifier answer is a known role key', () => {
  for (const image of ['nginx:1.31', 'postgres:18', 'redis:8', 'rabbitmq:3', 'minio:latest', 'grafana/grafana:11', 'node:20', 'busybox:1', 'company/unknown:1']) {
    const guess = roleOfImage(image)
    if (guess !== null) assert.ok(ROLES.includes(guess), `${image}: ${guess}`)
    assert.ok(ROLES.includes(classifyRole({ image })), `${image}: ${classifyRole({ image })}`)
  }
})

test('imageSlug strips the registry and digest', () => {
  assert.equal(imageSlug('docker.m.daocloud.io/library/redis:8.10.2'), 'redis:8.10.2')
  assert.equal(imageSlug('postgres@sha256:abc'), 'postgres')
  assert.equal(imageSlug('nginx'), 'nginx')
  assert.equal(imageSlug(undefined), '')
})

test('roleOfImage recognizes the common stacks', () => {
  assert.equal(roleOfImage('nginx:1.31.6'), 'website')
  assert.equal(roleOfImage('caddy:2'), 'website')
  assert.equal(roleOfImage('traefik:v3'), 'website')
  assert.equal(roleOfImage('postgres:18.6'), 'database')
  assert.equal(roleOfImage('docker.m.daocloud.io/library/postgres:18.6'), 'database')
  assert.equal(roleOfImage('mongo:7'), 'database')
  assert.equal(roleOfImage('mysql:8'), 'database')
  assert.equal(roleOfImage('redis:8.10.2'), 'cache')
  assert.equal(roleOfImage('memcached:1'), 'cache')
  assert.equal(roleOfImage('rabbitmq:3-management'), 'queue')
  assert.equal(roleOfImage('minio/minio:latest'), 'storage')
  assert.equal(roleOfImage('grafana/grafana:11'), 'monitoring')
  assert.equal(roleOfImage('node:20'), 'application')
  assert.equal(roleOfImage('busybox:1'), null)
})

test('classifyRole falls back to compose labels and container names', () => {
  assert.equal(classifyRole({ image: 'company/unknown:1', name: 'shop-db-1', labels: { 'com.docker.compose.service': 'db' } }), 'database')
  assert.equal(classifyRole({ image: 'company/unknown:1', name: 'session-cache' }), 'cache')
  assert.equal(classifyRole({ image: 'company/unknown:1', name: 'frontend-web' }), 'website')
  assert.equal(classifyRole({ image: 'company/unknown:1', name: 'api-worker' }), 'application')
})

test('classifyRole uses exposed ports when the image and name say nothing', () => {
  assert.equal(classifyRole({ image: 'company/unknown:1', name: 'svc', ports: [{ container: '5432' }] }), 'database')
  assert.equal(classifyRole({ image: 'company/unknown:1', name: 'svc', ports: [{ container: '6379' }] }), 'cache')
  assert.equal(classifyRole({ image: 'company/unknown:1', name: 'svc', ports: [{ container: '80' }] }), 'website')
  assert.equal(classifyRole({ image: 'company/unknown:1', name: 'svc', ports: [{ container: '9090' }] }), 'application')
  assert.equal(classifyRole({ image: 'company/unknown:1', name: 'svc', ports: [] }), 'other')
  assert.equal(classifyRole({}), 'other')
})

test('composeProject reads compose labels, otherwise nulls', () => {
  assert.deepEqual(
    composeProject({ 'com.docker.compose.project': 'yida_local', 'com.docker.compose.service': 'nginx' }),
    { project: 'yida_local', service: 'nginx' },
  )
  assert.deepEqual(composeProject({}), { project: null, service: null })
  assert.deepEqual(composeProject({ 'com.docker.compose.project': '' }), { project: null, service: null })
  assert.deepEqual(composeProject(undefined), { project: null, service: null })
})

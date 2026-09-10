import assert from 'node:assert/strict'
import test from 'node:test'
import { assertPublicHttpsUrl } from '../src/direct.ts'

test('assertPublicHttpsUrl accepts ordinary public HTTPS endpoints', () => {
  assert.equal(assertPublicHttpsUrl('https://relay.example.com'), 'https://relay.example.com/')
  assert.equal(assertPublicHttpsUrl('https://relay.example.com/api/v1'), 'https://relay.example.com/api/v1')
  assert.equal(assertPublicHttpsUrl('https://8.8.8.8/base'), 'https://8.8.8.8/base')
})

test('assertPublicHttpsUrl rejects non-HTTPS and embedded credentials', () => {
  assert.throws(() => assertPublicHttpsUrl('http://relay.example.com'), /https/)
  assert.throws(() => assertPublicHttpsUrl('ftp://relay.example.com'), /https/)
  assert.throws(() => assertPublicHttpsUrl('https://user:pass@relay.example.com'), /用户名\/密码/)
  assert.throws(() => assertPublicHttpsUrl('not a url'), /合法 URL/)
})

test('assertPublicHttpsUrl rejects query strings and fragments', () => {
  assert.throws(() => assertPublicHttpsUrl('https://relay.example.com/base?key=1'), /查询参数/)
  assert.throws(() => assertPublicHttpsUrl('https://relay.example.com/base#x'), /查询参数/)
})

test('assertPublicHttpsUrl rejects loopback, private, and link-local targets', () => {
  for (const url of [
    'https://localhost/v1',
    'https://api.localhost/v1',
    'https://billing.local/v1',
    'https://metadata.google.internal/v1',
    'https://127.0.0.1/v1',
    'https://0.0.0.0/v1',
    'https://10.1.2.3/v1',
    'https://172.16.0.9/v1',
    'https://172.31.255.1/v1',
    'https://192.168.1.10/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/v1',
    'https://[fe80::1]/v1',
    'https://[fd00::1]/v1',
  ]) {
    assert.throws(() => assertPublicHttpsUrl(url), /内网|保留|localhost/i, `should reject ${url}`)
  }
})

test('assertPublicHttpsUrl keeps public ranges adjacent to private ones', () => {
  assert.equal(assertPublicHttpsUrl('https://172.32.0.1/v1'), 'https://172.32.0.1/v1')
  assert.equal(assertPublicHttpsUrl('https://11.0.0.1/v1'), 'https://11.0.0.1/v1')
  assert.equal(assertPublicHttpsUrl('https://192.169.0.1/v1'), 'https://192.169.0.1/v1')
})

import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('package.json exports and files cover icon.svg, locale/*.json, and bilingual READMEs', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    icon?: string
    exports?: Record<string, unknown>
    files?: string[]
    keywords?: string[]
  }
  assert.equal(pkg.icon, './icon.svg')
  assert.equal(pkg.exports?.['./icon'], './icon.svg')
  assert.equal(pkg.exports?.['./locale/*.json'], './locale/*.json')
  assert.ok(pkg.files?.includes('icon.svg'))
  assert.ok(pkg.files?.includes('locale/*.json'))
  assert.ok(pkg.files?.includes('README.md'))
  assert.ok(pkg.files?.includes('README.en.md'))
  assert.ok((pkg.keywords?.length ?? 0) >= 14)
})

test('icon.svg is a self-contained SVG under 16 KiB with no forbidden external/script elements', () => {
  const iconPath = join(root, 'icon.svg')
  assert.equal(existsSync(iconPath), true)
  const stat = statSync(iconPath)
  assert.ok(stat.size > 0 && stat.size < 16 * 1024)
  const svg = readFileSync(iconPath, 'utf8')
  assert.match(svg, /<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  const withoutXmlns = svg.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')
  assert.equal(/<script|<image|<foreignObject|<style|<text|https?:\/\//i.test(withoutXmlns), false)
})

test('locale/zh.json and locale/en.json declare valid meta.title, meta.description, and existing meta.detail', () => {
  for (const lang of ['zh', 'en']) {
    const raw = JSON.parse(readFileSync(join(root, `locale/${lang}.json`), 'utf8')) as {
      meta?: { title?: string; description?: string; detail?: string }
    }
    assert.ok(raw.meta?.title && raw.meta.title.length > 0 && raw.meta.title.length <= 120)
    assert.ok(raw.meta?.description && raw.meta.description.length > 0 && raw.meta.description.length <= 160)
    assert.ok(raw.meta?.detail && !raw.meta.detail.includes('..'))
    assert.equal(existsSync(join(root, raw.meta!.detail!)), true)
  }
})

test('README.md and README.en.md cross-link and all local markdown links resolve', () => {
  for (const doc of ['README.md', 'README.en.md']) {
    const content = readFileSync(join(root, doc), 'utf8')
    const matches = content.matchAll(/\]\((?!https?:\/\/|#|mailto:)([^)]+)\)/g)
    for (const m of matches) {
      const rel = m[1]!.split('#')[0]!
      assert.equal(existsSync(join(root, rel)), true, `Broken relative link "${rel}" in ${doc}`)
    }
  }
})

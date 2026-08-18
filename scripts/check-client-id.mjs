#!/usr/bin/env node
/**
 * Build gate: the client bundle's self-registration id must equal the package
 * name. client-modules composes the boot graph row from the entry name it
 * resolves the bundle through (the package), and the browser loader rejects a
 * bundle that registers any other id ("loaded without registering"). Catches
 * identity drift between tsdown.config.ts CLIENT_ID and package.json name.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const anchor = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const anchorName = anchor.name
if (typeof anchorName !== 'string' || anchorName === '') {
  console.error('check-client-id: client-anchor/package.json has no name')
  process.exit(1)
}

const clientExport = anchor.exports?.['./client']
const clientRel = typeof clientExport === 'string' ? clientExport : clientExport?.default
if (typeof clientRel !== 'string') {
  console.error(`check-client-id: ${anchorName} exports["./client"] must be a string path or an object with a default`)
  process.exit(1)
}
if (!existsSync(join(root, clientRel))) {
  console.error(`check-client-id: ${anchorName} ./client → ${clientRel} does not exist (run the client build)`)
  process.exit(1)
}

const bundle = readFileSync(join(root, clientRel), 'utf8')
const match = bundle.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/)
if (match === null) {
  console.error(`check-client-id: bundle has no __ModuleLoader__.load({ id, ... }) banner`)
  process.exit(1)
}
if (match[1] !== anchorName) {
  console.error(`check-client-id: bundle registers "${match[1]}" but is served as "${anchorName}" — update tsdown.config.ts CLIENT_ID or package.json name so they match`)
  process.exit(1)
}
console.log(`check-client-id: bundle registers "${match[1]}" == package name ✓`)

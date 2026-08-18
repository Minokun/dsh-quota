/**
 * Build for both halves of the plugin. The Host half is a plain ESM library;
 * the browser half replicates the deepseek-harness client-bundle contract:
 * a closure-factory CJS artifact that hands itself to
 * window.__ModuleLoader__.load({ id, factory }) and resolves the platform
 * modules through the injected require. Anything outside the platform list is
 * inlined — a require the frozen module table cannot answer is a runtime throw.
 */
import { defineConfig } from 'tsdown'

/** The shell-seeded module specifiers (packages/client/web/src/platform.ts). */
const CLIENT_EXTERNALS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

const PACKAGE_ID = 'dsh-quota'

/**
 * The client bundle must self-register under the SAME name the host package
 * is mounted as: the boot-graph row id equals the package name client-modules
 * resolves the bundle through, and the browser loader rejects a bundle that
 * registers any other id ("loaded without registering"). Enforced by
 * scripts/check-client-id.mjs.
 */
const CLIENT_ID = PACKAGE_ID

export default defineConfig([
  {
    name: PACKAGE_ID,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    sourcemap: true,
    clean: true,
    external: [/^@deepseek-ai\//],
  },
  {
    name: `${PACKAGE_ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])

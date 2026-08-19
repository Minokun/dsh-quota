/**
 * HTTP routes for the browser panel, served under /plugins/dsh-quota/api.
 * GET  /status            — current snapshot + key state + custom platforms + formats
 * POST /refresh           — trigger a refresh (CSRF header required)
 * POST /keys              — store one platform API key into the credentials domain
 * POST /keys/remove       — remove one platform API key
 * POST /platforms         — add one user-declared HTTP platform
 * POST /platforms/remove  — remove one user-declared HTTP platform
 * @module dsh-quota/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.webServer Context merge.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { QuotaControllerFace } from './controller.ts'
import { CUSTOM_FORMATS } from './direct.ts'

const API_PREFIX = '/plugins/dsh-quota/api'
const CSRF_HEADER = 'x-dsh-quota'

export function registerHttpRoutes(ctx: Context, quota: QuotaControllerFace): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req: IncomingMessage, res: ServerResponse) => route(req, res, quota),
  }))
}

async function route(req: IncomingMessage, res: ServerResponse, quota: QuotaControllerFace): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://x').pathname.slice(API_PREFIX.length)
  const method = req.method ?? 'GET'
  try {
    if (method === 'GET' && path === '/status') {
      return send(res, 200, { ...quota.state(), keys: await quota.keyStatus(), formats: CUSTOM_FORMATS, loginFlows: quota.loginUrls() })
    }
    if (method === 'POST') {
      if (req.headers[CSRF_HEADER] === undefined) return send(res, 403, { error: 'missing required custom header' })
      if (path === '/refresh') {
        return send(res, 200, await quota.refresh())
      }
      if (path === '/login') {
        const body = await readJson(req)
        const platform = stringField(body, 'platform')
        if (!platform) return send(res, 400, { error: 'platform 必填' })
        await quota.loginStart(platform)
        return send(res, 200, { ok: true })
      }
      if (path === '/login/done') {
        const body = await readJson(req)
        const platform = stringField(body, 'platform')
        if (!platform) return send(res, 400, { error: 'platform 必填' })
        return send(res, 200, await quota.loginDone(platform))
      }
      if (path === '/keys') {
        const body = await readJson(req)
        const platform = stringField(body, 'platform')
        const key = stringField(body, 'key')
        if (!platform || !key) return send(res, 400, { error: 'platform 和 key 必填' })
        await quota.saveKey(platform, key)
        return send(res, 200, { ok: true, keys: await quota.keyStatus() })
      }
      if (path === '/keys/remove') {
        const body = await readJson(req)
        const platform = stringField(body, 'platform')
        if (!platform) return send(res, 400, { error: 'platform 必填' })
        await quota.removeKey(platform)
        return send(res, 200, { ok: true, keys: await quota.keyStatus() })
      }
      if (path === '/platforms') {
        const body = await readJson(req)
        await quota.addHttpPlatform({
          id: stringField(body, 'id') ?? '',
          label: stringField(body, 'label') ?? '',
          endpoint: stringField(body, 'endpoint') ?? '',
          keyRef: stringField(body, 'keyRef') ?? '',
          format: stringField(body, 'format') ?? '',
        })
        return send(res, 200, { ok: true, httpPlatforms: quota.state().httpPlatforms })
      }
      if (path === '/platforms/remove') {
        const body = await readJson(req)
        const id = stringField(body, 'id')
        if (!id) return send(res, 400, { error: 'id 必填' })
        await quota.removeHttpPlatform(id)
        return send(res, 200, { ok: true, httpPlatforms: quota.state().httpPlatforms })
      }
    }
    send(res, 404, { error: 'unknown route' })
  } catch (error) {
    send(res, 200, {
      ...quota.state(),
      refreshing: false,
      statusMessage: error instanceof Error ? error.message : String(error),
    })
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key]
  return typeof v === 'string' ? v : undefined
}

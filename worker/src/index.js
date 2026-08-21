import { canRead, canWrite } from './auth.js'
import { error, json, preflight } from './http.js'
import {
  isValidPlaybackId,
  readBodyWithLimit,
  readSubs,
  validateSegments,
  writeSubs,
} from './subs.js'

const routeSubs = async (request, env, playbackId) => {
  if (!isValidPlaybackId(playbackId)) return error('playbackId 格式不正確', 400)

  if (request.method === 'GET') {
    if (!canRead(request, env)) return error('未授權', 401)

    const record = await readSubs(env, playbackId)
    if (!record) return error('這一集還沒有共享字幕', 404)
    return json(record)
  }

  if (request.method === 'PUT') {
    if (!canWrite(request, env)) return error('未授權', 401)

    let payload
    try {
      payload = await readBodyWithLimit(request)
    } catch (bodyError) {
      return error(bodyError.message, 400)
    }

    const segments = Array.isArray(payload) ? payload : payload?.segments
    const check = validateSegments(segments)
    if (!check.ok) return error(check.reason, 400)

    const record = await writeSubs(env, playbackId, segments)
    return json({ ok: true, count: record.count, updatedAt: record.updatedAt })
  }

  return error('不支援的方法', 405)
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return preflight()

    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)

    if (parts.length === 1 && parts[0] === 'health') {
      return json({ ok: true })
    }

    if (parts.length === 2 && parts[0] === 'subs') {
      try {
        return await routeSubs(request, env, parts[1])
      } catch (unexpected) {
        console.error('routeSubs failed', unexpected)
        return error('伺服器處理失敗', 500)
      }
    }

    return error('找不到這個路徑', 404)
  },
}

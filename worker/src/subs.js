// Mux playback id 是一串英數字。限制格式，順便擋掉奇怪的 key。
const PLAYBACK_ID_PATTERN = /^[A-Za-z0-9]{16,64}$/

const MAX_BODY_BYTES = 512 * 1024
const MAX_SEGMENTS = 5000

export const isValidPlaybackId = (value) => PLAYBACK_ID_PATTERN.test(value || '')

const isValidSegment = (segment) =>
  segment !== null &&
  typeof segment === 'object' &&
  typeof segment.start === 'number' &&
  typeof segment.end === 'number' &&
  Number.isFinite(segment.start) &&
  Number.isFinite(segment.end) &&
  segment.end >= segment.start &&
  typeof segment.en === 'string' &&
  typeof segment.zh === 'string'

export const validateSegments = (payload) => {
  if (!Array.isArray(payload)) return { ok: false, reason: '格式必須是陣列' }
  if (payload.length === 0) return { ok: false, reason: '不可以是空陣列' }
  if (payload.length > MAX_SEGMENTS) return { ok: false, reason: '段落數量過多' }
  if (!payload.every(isValidSegment)) return { ok: false, reason: '有段落缺少必要欄位' }
  return { ok: true }
}

const keyFor = (playbackId) => `subs:${playbackId}`

export const readSubs = async (env, playbackId) => {
  const stored = await env.SUBS.get(keyFor(playbackId), { type: 'json' })
  return stored || null
}

export const writeSubs = async (env, playbackId, segments) => {
  const record = {
    segments,
    count: segments.length,
    updatedAt: new Date().toISOString(),
  }
  await env.SUBS.put(keyFor(playbackId), JSON.stringify(record))
  return record
}

export const readBodyWithLimit = async (request) => {
  const declared = Number(request.headers.get('Content-Length') || 0)
  if (declared > MAX_BODY_BYTES) throw new Error('內容過大')

  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new Error('內容過大')

  try {
    return JSON.parse(text)
  } catch (parseError) {
    throw new Error('不是合法的 JSON')
  }
}

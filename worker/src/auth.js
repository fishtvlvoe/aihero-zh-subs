// 逐字元全比對，不提早 return，避免用回應時間試出 token
const constantTimeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false

  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

const bearerToken = (request) => {
  const header = request.headers.get('Authorization') || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

// 寫入用的 token 同時也能讀，方便只發一組給自己用的情境
export const canRead = (request, env) => {
  const token = bearerToken(request)
  if (!token) return false
  return constantTimeEqual(token, env.READ_TOKEN) || constantTimeEqual(token, env.WRITE_TOKEN)
}

export const canWrite = (request, env) => {
  const token = bearerToken(request)
  if (!token) return false
  return constantTimeEqual(token, env.WRITE_TOKEN)
}

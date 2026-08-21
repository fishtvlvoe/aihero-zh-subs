// ==UserScript==
// @name         AI Hero 繁體中文雙語字幕
// @namespace    fishtv.aihero.zhsub
// @version      3.5.1
// @description  抓 Mux 的英文字幕檔翻成台灣繁體中文，在影片上疊中英雙語字幕
// @author       fish
// @match        https://www.aihero.dev/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @connect      generativelanguage.googleapis.com
// @connect      api.anthropic.com
// @connect      mux.com
// @connect      stream.mux.com
// @connect      workers.dev
// @updateURL    https://raw.githubusercontent.com/fishtvlvoe/aihero-zh-subs/main/aihero-zh-subs.user.js
// @downloadURL  https://raw.githubusercontent.com/fishtvlvoe/aihero-zh-subs/main/aihero-zh-subs.user.js
// @supportURL   https://github.com/fishtvlvoe/aihero-zh-subs/issues
// @homepageURL  https://github.com/fishtvlvoe/aihero-zh-subs
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict'

  // ---------------------------------------------------------------------------
  // 設定：想調的東西都在這一區
  // ---------------------------------------------------------------------------

  const CONFIG = Object.freeze({
    // 'gemini' 或 'claude'
    engine: 'gemini',

    gemini: {
      model: 'gemini-2.5-flash',
      endpoint: (model) =>
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      // 2.5-flash 的 thinking token 跟輸出共用同一個額度。8192 不夠一批中文吐完，
      // JSON 會被截斷在半路，整批就廢了。額度開大、thinking 關掉。
      maxOutputTokens: 32768,
      thinkingBudget: 0,
    },

    claude: {
      model: 'claude-opus-5',
      endpoint: 'https://api.anthropic.com/v1/messages',
      version: '2023-06-01',
    },

    // 一次送幾句去翻。批次邊界可能剛好切斷一句話，所以不要切太細，
    // 但也不能太粗：一批越大，輸出被截斷的風險越高。
    batchSize: 30,

    // 一批失敗時最多再試幾次。每次重試都把批次對半切，
    // 因為失敗最常見的原因就是輸出太長被截斷。
    maxRetriesPerBatch: 2,

    // 一組最多幾格。設 2 的時候，模型實際回的分組有三分之二是 3～5 格，
    // 全部被擋掉 → 30 格只蓋到 7 格，其餘沒有中文，重試也只是一直撞同一面牆。
    // 合併越多格，字幕在畫面上停留越久，所以長一點其實讀得完。
    // 這裡留 4 當作防呆，擋的是模型把整批合成一大組那種極端狀況。
    maxMergeSpan: 4,

    // 一句字幕最多幾個中文字。超過就在標點處切開，時間按字數比例分。
    maxCharsPerLine: 32,

    // 字幕外觀
    style: Object.freeze({
      zhFontSize: 26,
      enFontSize: 17,
      bottomPercent: 8,
      showEnglish: true,
      // 字幕區塊佔畫面寬度的比例。留白窄一點，長句才會折成兩行而不是拉成一長條。
      maxWidthPercent: 78,
    }),

    // 看這一集的時候，背景把下一集也抓好翻好，換集就是秒開
    prefetchNextLesson: true,

    // 共享字幕：翻好的結果上傳到自己的 Worker，換電腦就不用重翻。
    // 沒設定就完全不影響原本的流程。
    sync: Object.freeze({
      enabled: true,
      timeoutMs: 8000,
    }),

    // 控制面板：'auto' 平常縮成小圓點、忙碌時自動展開；'always' 一直展開；'off' 完全不顯示
    panelMode: 'auto',

    // 狀態變成「就緒」後幾秒自動收合
    panelIdleCollapseSec: 4,

    // 需要看診斷訊息時改 true
    debug: false,
  })

  const STORAGE_KEYS = Object.freeze({
    geminiKey: 'zhsub_gemini_key',
    claudeKey: 'zhsub_claude_key',
    cachePrefix: 'zhsub_cache_',
    settings: 'zhsub_settings',
    syncUrl: 'zhsub_sync_url',
    syncToken: 'zhsub_sync_token',
  })

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------

  const log = (...args) => {
    if (CONFIG.debug) console.info('[zh-sub]', ...args)
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const readSettings = () => {
    try {
      const raw = GM_getValue(STORAGE_KEYS.settings, null)
      return raw ? { ...CONFIG.style, ...JSON.parse(raw) } : { ...CONFIG.style }
    } catch (error) {
      log('讀設定失敗，用預設值', error)
      return { ...CONFIG.style }
    }
  }

  const writeSettings = (settings) => {
    try {
      GM_setValue(STORAGE_KEYS.settings, JSON.stringify(settings))
    } catch (error) {
      log('存設定失敗', error)
    }
  }

  // ---------------------------------------------------------------------------
  // API key：存在 Tampermonkey 儲存區，不寫死在原始碼
  // ---------------------------------------------------------------------------

  const keyStorageName = (engine) =>
    engine === 'claude' ? STORAGE_KEYS.claudeKey : STORAGE_KEYS.geminiKey

  const getApiKey = (engine, { promptIfMissing = true } = {}) => {
    const stored = GM_getValue(keyStorageName(engine), '')
    if (stored) return stored
    if (!promptIfMissing) return ''

    const label =
      engine === 'claude'
        ? '請貼上 Anthropic API key（sk-ant- 開頭）'
        : '請貼上 Gemini API key（AIza 開頭）'
    const entered = window.prompt(label, '')
    const trimmed = (entered || '').trim()
    if (!trimmed) return ''

    GM_setValue(keyStorageName(engine), trimmed)
    return trimmed
  }

  const clearApiKey = (engine) => GM_deleteValue(keyStorageName(engine))

  // 同步設定存在 Tampermonkey 儲存區，不寫進原始碼，這樣腳本可以安全分享。
  // 使用者按取消就把 sync 關掉，之後不再打擾（面板可按「設定共享字幕」重設）。
  const getSyncConfig = ({ promptIfMissing = true, force = false } = {}) => {
    if (!CONFIG.sync.enabled) return null

    const settings = readSettings()
    if (settings.syncDeclined && !force) return null

    let url = GM_getValue(STORAGE_KEYS.syncUrl, '')
    let token = GM_getValue(STORAGE_KEYS.syncToken, '')

    const shouldPrompt = force ? promptIfMissing : ((!url || !token) && promptIfMissing)

    if (shouldPrompt) {
      const inputUrl = window.prompt(
        '共享字幕伺服器網址（留空＝不使用，只存本機）\n例如 https://你的-worker 網址',
        url || ''
      )
      if (inputUrl === null || inputUrl.trim() === '') {
        writeSettings({ ...settings, syncDeclined: true })
        return null
      }
      const inputToken = window.prompt('伺服器存取 token', token || '')
      if (inputToken === null || inputToken.trim() === '') {
        writeSettings({ ...settings, syncDeclined: true })
        return null
      }
      url = inputUrl.trim().replace(/\/+$/, '')
      token = inputToken.trim()
      GM_setValue(STORAGE_KEYS.syncUrl, url)
      GM_setValue(STORAGE_KEYS.syncToken, token)
    }

    if (!url || !token) return null
    return { url, token }
  }

  // 面板按鈕用。清掉拒絕記號再重新問一次，
  // 這樣手滑按到取消不會變成永久壞掉。
  const resetSyncConfig = () => {
    const settings = readSettings()
    writeSettings({ ...settings, syncDeclined: false })
    const config = getSyncConfig({ promptIfMissing: true, force: true })
    return config
  }

  // 從共享伺服器抓這一集的字幕。沒有就回 null，不算錯誤。
  const fetchRemoteSegments = async (playbackId, syncConfig) => {
    try {
      const text = await httpRequest({
        method: 'GET',
        url: `${syncConfig.url}/subs/${encodeURIComponent(playbackId)}`,
        headers: { Authorization: `Bearer ${syncConfig.token}` },
        timeout: CONFIG.sync.timeoutMs,
      })
      const parsed = JSON.parse(text)
      const segments = parsed?.segments
      if (!Array.isArray(segments) || segments.length === 0) return null
      return segments
    } catch (error) {
      // 404 代表還沒人上傳過，是正常的，不用吵
      log('共享字幕讀取失敗（不影響翻譯）', error)
      return null
    }
  }

  // 把翻好的字幕上傳，讓其他電腦不用重翻。失敗就算了，不要影響使用者。
  const uploadSegments = async (playbackId, segments, syncConfig) => {
    try {
      await httpRequest({
        method: 'PUT',
        url: `${syncConfig.url}/subs/${encodeURIComponent(playbackId)}`,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${syncConfig.token}`,
        },
        body: { segments },
        timeout: CONFIG.sync.timeoutMs,
      })
      log('已上傳共享字幕', playbackId, segments.length)
      return true
    } catch (error) {
      log('共享字幕上傳失敗（不影響本機使用）', error)
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP：userscript 用 GM_xmlhttpRequest 才不會被 CORS 擋
  // ---------------------------------------------------------------------------

  const httpRequest = ({ method, url, headers = {}, body = null, timeout = 120000 }) =>
    new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data: body === null ? undefined : JSON.stringify(body),
        timeout,
        onload: (response) => {
          if (response.status < 200 || response.status >= 300) {
            reject(
              new Error(
                `HTTP ${response.status}：${String(response.responseText).slice(0, 300)}`
              )
            )
            return
          }
          resolve(response.responseText)
        },
        onerror: () => reject(new Error('網路請求失敗')),
        ontimeout: () => reject(new Error('請求逾時')),
      })
    })

  const httpGetText = (url) => httpRequest({ method: 'GET', url })

  // 抓自己站上的頁面用原生 fetch 就好：同源、自動帶 cookie，
  // 也不必為了它在 @connect 開放整個網域。
  const fetchSameOrigin = async (url) => {
    const response = await fetch(url, { credentials: 'include' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.text()
  }

  const httpPostJson = async ({ url, headers, body }) => {
    const text = await httpRequest({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    })
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new Error(`回應不是合法 JSON：${error.message}`)
    }
  }

  // ---------------------------------------------------------------------------
  // 從 Mux 抓完整字幕檔
  //
  // 播放器的 textTrack 只會跟著播放進度慢慢載入，開頭只有幾句。
  // 直接抓 HLS 的字幕檔才拿得到整集，打開頁面就能全部翻完。
  // ---------------------------------------------------------------------------

  const MUX_MASTER = (playbackId) => `https://stream.mux.com/${playbackId}.m3u8`

  const parseSubtitleUri = (masterManifest) => {
    const match = masterManifest.match(/#EXT-X-MEDIA:[^\n]*TYPE=SUBTITLES[^\n]*URI="([^"]+)"/)
    return match ? match[1] : ''
  }

  const parseSegmentUrls = (playlist, baseUrl) =>
    playlist
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => (/^https?:\/\//i.test(line) ? line : new URL(line, baseUrl).href))

  const parseTimestamp = (value) => {
    const parts = value.trim().split(':')
    if (parts.length < 2) return NaN
    const seconds = parseFloat(parts.pop())
    const minutes = parseInt(parts.pop(), 10)
    const hours = parts.length ? parseInt(parts.pop(), 10) : 0
    return hours * 3600 + minutes * 60 + seconds
  }

  const cleanCueText = (raw) =>
    String(raw || '')
      .replace(/<[^>]+>/g, '')
      .replace(/^-\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()

  const parseVtt = (content) => {
    const cues = []
    const blocks = content.replace(/\r/g, '').split(/\n\n+/)

    blocks.forEach((block) => {
      const lines = block.split('\n').filter((line) => line.trim())
      const timingIndex = lines.findIndex((line) => line.includes('-->'))
      if (timingIndex === -1) return

      const [startRaw, restRaw] = lines[timingIndex].split('-->')
      if (!startRaw || !restRaw) return

      const start = parseTimestamp(startRaw)
      const end = parseTimestamp(restRaw.trim().split(/\s+/)[0])
      if (Number.isNaN(start) || Number.isNaN(end)) return

      const text = cleanCueText(lines.slice(timingIndex + 1).join(' '))
      if (text) cues.push({ start, end, text })
    })

    return cues
  }

  const dedupeCues = (cues) => {
    const seen = new Set()
    return cues
      .filter((cue) => {
        const key = `${cue.start.toFixed(3)}|${cue.text}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .sort((a, b) => a.start - b.start)
  }

  const fetchAllCues = async (playbackId, onProgress) => {
    const master = await httpGetText(MUX_MASTER(playbackId))
    const subtitleUri = parseSubtitleUri(master)
    if (!subtitleUri) throw new Error('這支影片沒有字幕軌')

    const playlist = await httpGetText(subtitleUri)
    const segments = parseSegmentUrls(playlist, subtitleUri)
    if (segments.length === 0) throw new Error('字幕播放清單是空的')

    const collected = []
    for (let index = 0; index < segments.length; index += 1) {
      onProgress?.(index + 1, segments.length)
      try {
        const vtt = await httpGetText(segments[index])
        collected.push(...parseVtt(vtt))
      } catch (error) {
        log(`字幕分段 ${index} 抓取失敗`, error)
      }
    }

    return dedupeCues(collected)
  }

  // ---------------------------------------------------------------------------
  // 翻譯提示詞
  // ---------------------------------------------------------------------------

  const SYSTEM_PROMPT = [
    '你是專業的技術影片字幕翻譯，把英文字幕翻成台灣人習慣的繁體中文。',
    '',
    '重要背景：這份英文字幕是按「時間」切的，不是按語意切的。',
    '講者一停頓就切一格，所以一句完整的話常常被拆成兩三格，斷點會落在語意中間。',
    '你的工作是先讀懂整段在講什麼，再把「屬於同一句話」的連續格子合併起來一起翻譯。',
    '',
    '規則：',
    '1. 先通讀全部內容理解語意，再決定怎麼分組。',
    '2. 只能合併「編號連續」的格子，一組最多 4 格。超過 4 格一律不合併。',
    '3. 每個編號都必須剛好被涵蓋一次，不可遺漏、不可重疊。',
    '4. 語意已經完整的單一格子，就自己成為一組，不必硬合併。',
    '',
    '關於長度（很重要）：',
    '這些字會即時疊在影片畫面上，觀眾只有幾秒可以看。',
    '合併越多格，這句字幕在畫面上停留越久，所以格數多的時候字可以多一點。',
    '抓這個比例：合併 1～2 格時控制在 30 字以內，3～4 格時控制在 50 字以內。',
    '遇到長句就在逗號、連接詞這種自然停頓處拆開，每一組都要能單獨讀懂。',
    '寧可拆細，也不要合出一大段。',
    '',
    '8. 只用台灣繁體中文與台灣慣用詞。影片不是視頻，軟體不是軟件，程式碼不是代碼，'
      + '專案不是項目，資料不是數據，網路不是網絡，伺服器不是服務器，品質不是質量，'
      + '介面不是接口，記憶體不是內存，預設不是默認，函式不是函數，字串不是字符串。',
    '9. 絕對不可出現簡體字。',
    '10. 技術名詞、產品名、指令、檔名、程式碼保留英文原文，例如 Claude Code、'
      + 'context window、commit、prompt、token、CLAUDE.md、git、API。',
    '11. 這是口語講課，翻得像人在講話，不要書面腔，不要加原文沒有的內容。',
    '12. 原文若有明顯的語音辨識錯誤（專有名詞被聽錯），依上下文判斷正確的詞再翻。',
    '',
    '輸出格式：只回傳一個 JSON 陣列，每個元素是 {"s": 起始編號, "e": 結束編號, "t": "中文翻譯"}。',
    '單一格子自成一組時，s 和 e 填同一個數字。',
    '不要加任何說明文字或 markdown 標記。',
  ].join('\n')

  const buildUserPrompt = (items) => {
    const lines = items.map((item) => `${item.i}\t${item.text}`).join('\n')
    return [
      `以下是 ${items.length} 格連續的英文字幕（格式為「編號 tab 原文」）：`,
      '',
      lines,
      '',
      `請先讀懂整段語意，再把屬於同一句話的連續格子合併，翻成繁體中文。`,
      `編號範圍是 0 到 ${items.length - 1}，每個編號都要被涵蓋一次。`,
    ].join('\n')
  }

  // ---------------------------------------------------------------------------
  // 翻譯引擎
  // ---------------------------------------------------------------------------

  // 從一段（可能被截斷的）文字裡，把每個完整的 {...} 撿出來。
  // 字串內的大括號跟跳脫字元要跳過，不然括號會數錯。
  const salvageObjects = (text) => {
    const objects = []
    let depth = 0
    let start = -1
    let inString = false
    let escaped = false

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]

      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }

      if (ch === '"') {
        inString = true
      } else if (ch === '{') {
        if (depth === 0) start = i
        depth += 1
      } else if (ch === '}') {
        depth -= 1
        if (depth === 0 && start !== -1) {
          try {
            objects.push(JSON.parse(text.slice(start, i + 1)))
          } catch (error) {
            log('跳過一個壞掉的分組物件', error)
          }
          start = -1
        }
      }
    }

    return objects
  }

  const parseTranslationJson = (raw, { truncated = false } = {}) => {
    const text = String(raw || '').trim()
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim()

    if (!truncated) {
      try {
        return JSON.parse(cleaned)
      } catch (error) {
        const start = cleaned.indexOf('[')
        const end = cleaned.lastIndexOf(']')
        if (start !== -1 && end > start) {
          try {
            return JSON.parse(cleaned.slice(start, end + 1))
          } catch (innerError) {
            log('整段 JSON 解析失敗，改用逐個物件搶救', innerError)
          }
        }
      }
    }

    // 被截斷或格式壞掉時走到這裡：撿回截斷點之前完整的分組，
    // 有多少算多少。撿不回來的部分由呼叫端重試補上。
    const salvaged = salvageObjects(cleaned)
    if (salvaged.length === 0) {
      throw new Error(`翻譯結果無法解析成 JSON：${cleaned.slice(0, 150)}`)
    }
    return salvaged
  }

  const translateViaGemini = async (items, apiKey) => {
    const url = `${CONFIG.gemini.endpoint(CONFIG.gemini.model)}?key=${encodeURIComponent(apiKey)}`
    const data = await httpPostJson({
      url,
      headers: {},
      body: {
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: buildUserPrompt(items) }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: CONFIG.gemini.maxOutputTokens,
          response_mime_type: 'application/json',
          thinkingConfig: { thinkingBudget: CONFIG.gemini.thinkingBudget },
        },
      },
    })

    const blockReason = data?.promptFeedback?.blockReason
    if (blockReason) throw new Error(`Gemini 拒絕回應：${blockReason}`)

    const candidate = data?.candidates?.[0]
    const parts = candidate?.content?.parts
    if (!Array.isArray(parts) || parts.length === 0) {
      // finishReason 講得出是額度用完還是被擋，不要讓它變成無頭公案
      throw new Error(`Gemini 沒有回傳內容（finishReason=${candidate?.finishReason || '未知'}）`)
    }

    const text = parts.map((part) => part.text || '').join('')
    // MAX_TOKENS 代表被截斷，JSON 一定不完整，交給 parseTranslationJson 去搶救
    return parseTranslationJson(text, { truncated: candidate?.finishReason === 'MAX_TOKENS' })
  }

  const translateViaClaude = async (items, apiKey) => {
    const data = await httpPostJson({
      url: CONFIG.claude.endpoint,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': CONFIG.claude.version,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: {
        model: CONFIG.claude.model,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(items) }],
      },
    })

    if (data?.stop_reason === 'refusal') throw new Error('Claude 拒絕回應這批字幕')

    const text = (data?.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')

    if (!text) throw new Error('Claude 沒有回傳文字內容')
    return parseTranslationJson(text)
  }

  const translateBatch = (items, apiKey) =>
    CONFIG.engine === 'claude'
      ? translateViaClaude(items, apiKey)
      : translateViaGemini(items, apiKey)

  // ---------------------------------------------------------------------------
  // 快取：同一集翻過就不再重翻
  //
  // 存的是「合併後的字幕段落」而不是逐句對照表，因為合併分組本身
  // 就是翻譯結果的一部分。格式變動時把版本號往上加，舊快取自然失效。
  // ---------------------------------------------------------------------------

  const CACHE_VERSION = 'v5'

  const cacheKeyFor = (playbackId) =>
    `${STORAGE_KEYS.cachePrefix}${CACHE_VERSION}_${CONFIG.engine}_${playbackId}`

  const readCachedSegments = (playbackId) => {
    try {
      const raw = GM_getValue(cacheKeyFor(playbackId), null)
      const parsed = raw ? JSON.parse(raw) : null
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : null
    } catch (error) {
      log('快取讀取失敗', error)
      return null
    }
  }

  const writeCachedSegments = (playbackId, segments) => {
    try {
      GM_setValue(cacheKeyFor(playbackId), JSON.stringify(segments))
    } catch (error) {
      log('快取寫入失敗', error)
    }
  }

  // ---------------------------------------------------------------------------
  // 把模型回傳的分組轉成實際要顯示的字幕段落
  // ---------------------------------------------------------------------------

  const toSegment = (cues, from, to, zh) => ({
    start: cues[from].start,
    end: cues[to].end,
    en: cues.slice(from, to + 1).map((cue) => cue.text).join(' '),
    zh,
  })

  // 一組合併多格的字幕，中文可能很長。中文切成幾塊、時間按字數比例分，
  // 這樣覆蓋率不會有洞（不能靠丟掉分組來控制長度，那會讓整段變回純英文）。
  const splitLongSegment = (segment, maxChars) => {
    const zh = String(segment.zh || '')
    if (!zh || zh.length <= maxChars) return [segment]

    const parts = Math.ceil(zh.length / maxChars)
    const target = zh.length / parts
    const STRONG = '。！？'
    const WEAK = '，、；：'

    const cuts = []
    let searchFrom = 0
    for (let n = 1; n < parts; n += 1) {
      const ideal = Math.round(target * n)
      let best = -1
      let bestScore = Infinity
      for (let i = searchFrom; i < zh.length - 1; i += 1) {
        const ch = zh[i]
        const isStrong = STRONG.includes(ch)
        const isWeak = WEAK.includes(ch)
        // 只在中文標點下刀。空白也當切點的話，會從英文片語中間切開 ——
        // 這支腳本刻意把技術名詞保留成英文，切在那裡等於專挑專有名詞砍
        // （實測 Windows Subsystem for Linux 被切成兩半，空白還被 trim 吃掉）。
        if (!isStrong && !isWeak) continue
        const score = Math.abs(i - ideal) * (isStrong ? 0.6 : 1)
        if (score < bestScore) { bestScore = score; best = i }
      }
      if (best === -1) break
      cuts.push(best + 1)
      searchFrom = best + 1
    }

    if (cuts.length === 0) return [segment]

    const bounds = [0, ...cuts, zh.length]
    const chunks = []
    for (let i = 0; i < bounds.length - 1; i += 1) {
      const text = zh.slice(bounds[i], bounds[i + 1]).trim()
      if (text) chunks.push(text)
    }
    if (chunks.length <= 1) return [segment]

    const totalChars = chunks.reduce((n, c) => n + c.length, 0)
    const span = segment.end - segment.start
    const out = []
    let cursor = segment.start
    chunks.forEach((text, i) => {
      const isLast = i === chunks.length - 1
      const end = isLast ? segment.end : cursor + (span * text.length) / totalChars
      out.push({ start: cursor, end, en: segment.en, zh: text })
      cursor = end
    })

    return out
  }

  const groupsToSegments = (groups, cues) => {
    const segments = []
    const covered = new Set()

    const list = Array.isArray(groups) ? groups : []
    list.forEach((group) => {
      let from = Number(group?.s)
      let to = Number(group?.e)
      if (!Number.isInteger(from) || !Number.isInteger(to)) return
      if (from > to) [from, to] = [to, from]
      if (from < 0 || from >= cues.length) return

      if (to >= cues.length) return
      if (to - from + 1 > CONFIG.maxMergeSpan) return

      // 模型偶爾會給出重疊的分組，重疊的部分直接跳過，留給補漏處理
      for (let i = from; i <= to; i += 1) {
        if (covered.has(i)) return
      }

      const zh = String(group?.t || '').trim()
      if (!zh) return

      for (let i = from; i <= to; i += 1) covered.add(i)
      segments.push(...splitLongSegment(toSegment(cues, from, to, zh), CONFIG.maxCharsPerLine))
    })

    // 模型漏掉的格子至少要保留英文，不能整段消失
    cues.forEach((cue, index) => {
      if (covered.has(index)) return
      segments.push({ start: cue.start, end: cue.end, en: cue.text, zh: '' })
    })

    return { segments: segments.sort((a, b) => a.start - b.start), covered }
  }

  // 把沒翻到的格號整理成連續區間，之後只重試這幾段就好
  const contiguousRuns = (total, covered) => {
    const runs = []
    let start = -1

    for (let i = 0; i < total; i += 1) {
      const missing = !covered.has(i)
      if (missing && start === -1) start = i
      if (!missing && start !== -1) {
        runs.push({ from: start, to: i - 1 })
        start = -1
      }
    }
    if (start !== -1) runs.push({ from: start, to: total - 1 })

    return runs
  }

  // 翻一段字幕。沒翻到的部分會自動切小重試 —
  // 失敗最常見的原因是輸出太長被截斷，切小就會過。
  const translateSlice = async (slice, apiKey, depth = 0) => {
    if (slice.length === 0) return []

    let result = null
    try {
      const items = slice.map((cue, index) => ({ i: index, text: cue.text }))
      const groups = await translateBatch(items, apiKey)
      result = groupsToSegments(groups, slice)
    } catch (error) {
      log(`翻譯失敗（depth=${depth}，${slice.length} 格）`, error)
      if (depth >= CONFIG.maxRetriesPerBatch || slice.length < 2) throw error

      const mid = Math.ceil(slice.length / 2)
      await sleep(800)
      const left = await translateSlice(slice.slice(0, mid), apiKey, depth + 1)
      const right = await translateSlice(slice.slice(mid), apiKey, depth + 1)
      return [...left, ...right]
    }

    const runs = contiguousRuns(slice.length, result.covered)
    if (runs.length === 0 || depth >= CONFIG.maxRetriesPerBatch) return result.segments

    const patched = []
    for (const run of runs) {
      const sub = slice.slice(run.from, run.to + 1)
      try {
        patched.push(...(await translateSlice(sub, apiKey, depth + 1)))
      } catch (error) {
        log('補翻失敗，保留英文', error)
        patched.push(...untranslatedSegments(sub))
      }
    }

    const kept = result.segments.filter((segment) => segment.zh)
    return [...kept, ...patched].sort((a, b) => a.start - b.start)
  }

  const untranslatedSegments = (cues) =>
    cues.map((cue) => ({ start: cue.start, end: cue.end, en: cue.text, zh: '' }))

  // ---------------------------------------------------------------------------
  // 播放器
  // ---------------------------------------------------------------------------

  const findVideoElement = () => {
    const player = document.querySelector('mux-player')
    if (!player || !player.shadowRoot) return null

    const search = (root, depth) => {
      if (depth > 6) return null
      for (const element of root.querySelectorAll('*')) {
        if (element.tagName === 'VIDEO') return element
        if (element.shadowRoot) {
          const found = search(element.shadowRoot, depth + 1)
          if (found) return found
        }
      }
      return null
    }

    return search(player.shadowRoot, 0)
  }

  const getPlaybackId = () => {
    const player = document.querySelector('mux-player')
    return player?.getAttribute('playback-id') || player?.playbackId || ''
  }

  // ---------------------------------------------------------------------------
  // 預抓下一集
  // ---------------------------------------------------------------------------

  const findNextLessonUrl = () => {
    const link = [...document.querySelectorAll('a')].find((a) =>
      /next lesson/i.test(a.textContent || '')
    )
    return link ? link.href : ''
  }

  // SSR 出來的 <mux-player> 標籤上沒有 playback-id（那是前端才補上去的），
  // 但 RSC payload 裡有 muxPlaybackId，直接從原始碼撈。
  const extractPlaybackId = (html) => {
    const match = html.match(/muxPlaybackId\\?["']?\s*:\s*\\?["']([A-Za-z0-9]{20,})/)
    return match ? match[1] : ''
  }

  const prefetchNext = async () => {
    if (!CONFIG.prefetchNextLesson) return

    // 站台是 Next.js，主流程跑起來時「Next lesson」連結常常還沒渲染出來，
    // 所以這裡要等它出現，不能只看一次就放棄。
    const nextUrl = await waitFor(findNextLessonUrl, { tries: 20, intervalMs: 1000 })
    if (!nextUrl) {
      log('預抓：找不到下一集連結')
      return
    }

    try {
      const html = await fetchSameOrigin(nextUrl)
      const playbackId = extractPlaybackId(html)
      if (!playbackId) {
        log('預抓：下一集找不到 playbackId')
        return
      }

      if (readCachedSegments(playbackId)) {
        log('預抓：下一集已在快取')
        return
      }

      const cues = await fetchAllCues(playbackId)
      if (cues.length === 0) return

      setStatus(`順便翻下一集…（${cues.length} 句）`, '#8ab4ff')
      await buildSegments(cues, playbackId, { quiet: true })
      setStatus('下一集也備好了', '#9de89d')
    } catch (error) {
      log('預抓下一集失敗', error)
    }
  }

  // ---------------------------------------------------------------------------
  // 畫面：字幕層 + 控制列
  // ---------------------------------------------------------------------------

  const OVERLAY_ID = 'zhsub-overlay'
  const PANEL_ID = 'zhsub-panel'

  // 這些字幕本身就是翻譯結果，不能再讓其他翻譯外掛動它。
  // translate="no" 是 HTML 標準，notranslate 給 Google 系，
  // immersive-translate-ignore 給沉浸式翻譯。字幕每 0.1 秒就在變，
  // 沒擋住的話外掛會不斷重掃，畫面會閃。
  const markAsDoNotTranslate = (element) => {
    element.setAttribute('translate', 'no')
    element.classList.add('notranslate', 'immersive-translate-ignore')
    element.setAttribute('data-immersive-translate-ignore', 'true')
    element.setAttribute('data-no-translate', 'true')
  }

  const createOverlay = (player, settings) => {
    document.getElementById(OVERLAY_ID)?.remove()

    // 掛在 mux-player 本身，而不是它的父層：
    // 全螢幕時瀏覽器只渲染 mux-player 那棵子樹，掛在外面的字幕會整個不見。
    // 順便也讓定位以影片本體為基準，父層通常比影片高，位置會偏。
    const host = player
    if (!host) return null
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative'

    const overlay = document.createElement('div')
    overlay.id = OVERLAY_ID
    markAsDoNotTranslate(overlay)
    overlay.style.cssText = [
      'position:absolute',
      'left:0',
      'right:0',
      `bottom:${settings.bottomPercent}%`,
      'z-index:2147483000',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'gap:4px',
      'pointer-events:none',
      'text-align:center',
      'padding:0 3%',
      'font-family:system-ui,-apple-system,"Noto Sans TC","PingFang TC",sans-serif',
    ].join(';')

    const makeLine = (role, fontSize, extra) => {
      const line = document.createElement('div')
      line.dataset.role = role
      markAsDoNotTranslate(line)
      line.style.cssText = [
        `font-size:${fontSize}px`,
        `max-width:${settings.maxWidthPercent}%`,
        'display:none',
        'border-radius:6px',
        // 長句折行時讓兩行長度平均，不要一行滿一行只有幾個字
        'text-wrap:balance',
        'overflow-wrap:break-word',
        ...extra,
      ].join(';')
      return line
    }

    const zhLine = makeLine('zh', settings.zhFontSize, [
      'line-height:1.45',
      'color:#fff',
      'font-weight:700',
      'text-shadow:0 2px 6px #000,0 0 3px #000',
      'background:rgba(0,0,0,.58)',
      'padding:4px 14px',
    ])

    const enLine = makeLine('en', settings.enFontSize, [
      'line-height:1.35',
      'color:#dcdcdc',
      'text-shadow:0 2px 6px #000',
      'background:rgba(0,0,0,.45)',
      'padding:2px 12px',
    ])

    overlay.append(zhLine, enLine)
    host.appendChild(overlay)
    return overlay
  }

  const panelState = { collapseTimer: null }

  const setPanelExpanded = (expanded) => {
    const panel = document.getElementById(PANEL_ID)
    if (!panel) return
    const dot = panel.querySelector('[data-role="dot"]')
    const body = panel.querySelector('[data-role="body"]')
    if (!dot || !body) return
    body.style.display = expanded ? '' : 'none'
    dot.style.display = expanded ? 'none' : ''
  }

  const scheduleCollapse = () => {
    clearTimeout(panelState.collapseTimer)
    if (CONFIG.panelMode !== 'auto') return
    panelState.collapseTimer = setTimeout(
      () => setPanelExpanded(false),
      CONFIG.panelIdleCollapseSec * 1000
    )
  }

  const createPanel = ({ onRetranslate, onToggleEnglish, onResetKey, onResetSync }) => {
    document.getElementById(PANEL_ID)?.remove()
    if (CONFIG.panelMode === 'off') return null

    const panel = document.createElement('div')
    panel.id = PANEL_ID
    markAsDoNotTranslate(panel)
    panel.style.cssText = [
      'position:fixed',
      'right:14px',
      'bottom:14px',
      'z-index:2147483600',
      'font:13px/1.5 system-ui,-apple-system,"Noto Sans TC","PingFang TC",sans-serif',
    ].join(';')

    // 收合狀態：只留一顆小圓點，平常幾乎看不到
    const dot = document.createElement('div')
    dot.dataset.role = 'dot'
    dot.title = '字幕翻譯（點一下展開）'
    dot.style.cssText = [
      'width:10px',
      'height:10px',
      'border-radius:50%',
      'background:#9de89d',
      'opacity:.35',
      'cursor:pointer',
      'margin-left:auto',
      'transition:opacity .2s,transform .2s',
    ].join(';')
    dot.addEventListener('mouseenter', () => {
      dot.style.opacity = '.9'
      dot.style.transform = 'scale(1.3)'
    })
    dot.addEventListener('mouseleave', () => {
      dot.style.opacity = '.35'
      dot.style.transform = 'scale(1)'
    })
    dot.addEventListener('click', () => {
      clearTimeout(panelState.collapseTimer)
      setPanelExpanded(true)
    })

    const body = document.createElement('div')
    body.dataset.role = 'body'
    body.style.cssText = [
      'background:rgba(20,20,20,.92)',
      'color:#eee',
      'border:1px solid #444',
      'border-radius:10px',
      'padding:10px 12px',
      'box-shadow:0 6px 24px rgba(0,0,0,.45)',
      'min-width:200px',
    ].join(';')

    const status = document.createElement('div')
    status.dataset.role = 'status'
    status.textContent = '等待播放器…'
    status.style.cssText = 'margin-bottom:8px;color:#ffd08a'

    const makeButton = (label, handler) => {
      const button = document.createElement('button')
      button.textContent = label
      button.style.cssText = [
        'display:block',
        'width:100%',
        'margin-top:5px',
        'padding:5px 8px',
        'background:#2c2c2c',
        'color:#eee',
        'border:1px solid #555',
        'border-radius:6px',
        'cursor:pointer',
        'font-size:12px',
      ].join(';')
      button.addEventListener('click', handler)
      return button
    }

    body.append(
      status,
      makeButton('重新翻譯這一集', onRetranslate),
      makeButton('中英 / 只看中文', onToggleEnglish),
      makeButton('重設 API key', onResetKey),
      makeButton('設定共享字幕', onResetSync),
      makeButton('收起面板', () => {
        clearTimeout(panelState.collapseTimer)
        setPanelExpanded(false)
      })
    )

    panel.append(dot, body)
    document.body.appendChild(panel)
    setPanelExpanded(CONFIG.panelMode === 'always')
    return panel
  }

  // 忙的時候自動展開報進度，閒下來就自己收回小圓點
  const BUSY_PATTERN = /翻譯中|抓字幕|等待|重新處理|換集/

  const setStatus = (text, color = '#ffd08a') => {
    const panel = document.getElementById(PANEL_ID)
    if (!panel) return

    const status = panel.querySelector('[data-role="status"]')
    if (status) {
      status.textContent = text
      status.style.color = color
    }

    const dot = panel.querySelector('[data-role="dot"]')
    if (dot) dot.style.background = color

    if (CONFIG.panelMode !== 'auto') return
    if (BUSY_PATTERN.test(text)) {
      clearTimeout(panelState.collapseTimer)
      setPanelExpanded(true)
    } else {
      scheduleCollapse()
    }
  }

  // ---------------------------------------------------------------------------
  // 主流程
  // ---------------------------------------------------------------------------

  const state = {
    playbackId: '',
    running: false,
    stopRendering: null,
    settings: readSettings(),
  }

  const buildSegments = async (cues, playbackId, { force = false, quiet = false } = {}) => {
    // 背景預抓時不搶狀態列，也不彈視窗問 key
    const report = (text, color) => {
      if (!quiet) setStatus(text, color)
    }

    if (!force) {
      const cached = readCachedSegments(playbackId)
      const cachedZh = cached ? cached.filter((segment) => segment.zh).length : 0

      // 一句都沒翻到的快取沒有意義，當作沒快取，重新翻一次
      if (cached && cachedZh > 0) {
        if (cachedZh === cached.length) {
          report(`字幕就緒（${cached.length} 句，全部來自快取）`, '#9de89d')
        } else {
          report(`字幕就緒（快取 ${cachedZh}/${cached.length} 句，可按重新翻譯補齊）`, '#ffd08a')
        }
        return cached
      }
    }

    const syncConfig = getSyncConfig({ promptIfMissing: !quiet })

    // 本機沒有就問共享伺服器，抓到就順便寫進本機快取，下次直接用本機的
    if (!force && syncConfig) {
      report('查詢共享字幕…', '#ffd08a')
      const remote = await fetchRemoteSegments(playbackId, syncConfig)
      if (remote) {
        writeCachedSegments(playbackId, remote)
        const zh = remote.filter((segment) => segment.zh).length
        report(`字幕就緒（${zh}/${remote.length} 句，來自共享）`, '#9de89d')
        return remote
      }
    }

    const apiKey = getApiKey(CONFIG.engine, { promptIfMissing: !quiet })
    if (!apiKey) {
      report('沒有 API key，只顯示英文', '#ff9a9a')
      return untranslatedSegments(cues)
    }

    const segments = []
    const totalBatches = Math.ceil(cues.length / CONFIG.batchSize)

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
      const slice = cues.slice(
        batchIndex * CONFIG.batchSize,
        (batchIndex + 1) * CONFIG.batchSize
      )

      report(`翻譯中… ${batchIndex + 1}/${totalBatches}`, '#ffd08a')

      try {
        segments.push(...(await translateSlice(slice, apiKey)))
      } catch (error) {
        log('批次翻譯失敗', error)
        report(`第 ${batchIndex + 1} 批失敗：${error.message}`.slice(0, 70), '#ff9a9a')
        segments.push(...untranslatedSegments(slice))
        await sleep(1500)
      }
    }

    segments.sort((a, b) => a.start - b.start)

    const translated = segments.filter((segment) => segment.zh).length

    // 以前是「一批失敗就整集不存」，結果每次重開都整集重翻、重燒 API 額度。
    // 現在只要有翻到東西就存起來，沒翻到的部分下次可以按「重新翻譯」補。
    if (translated > 0) writeCachedSegments(playbackId, segments)

    // 只有整集都翻好才上傳。半成品傳上去會害到其他電腦。
    if (syncConfig && translated === segments.length) {
      await uploadSegments(playbackId, segments, syncConfig)
    }

    const color = translated === segments.length ? '#9de89d' : '#ffd08a'
    report(`字幕就緒（${translated}/${segments.length} 句）`, color)
    return segments
  }

  // segments 已依時間排序，用二分搜尋找當下該顯示哪一句
  const findSegmentAt = (segments, time) => {
    let low = 0
    let high = segments.length - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const segment = segments[mid]
      if (time < segment.start) high = mid - 1
      else if (time > segment.end) low = mid + 1
      else return segment
    }
    return null
  }

  // 字幕全部由這支腳本自己畫，播放器內建那層要關掉才不會兩份字幕疊在一起
  const muteNativeCaptions = (video) => {
    for (const track of video.textTracks || []) {
      const isSubtitle = track.kind === 'subtitles' || track.kind === 'captions'
      if (isSubtitle && track.mode !== 'disabled') track.mode = 'disabled'
    }
  }

  const startRendering = (video, segments, overlay) => {
    const zhLine = overlay.querySelector('[data-role="zh"]')
    const enLine = overlay.querySelector('[data-role="en"]')
    let lastKey = null

    const render = () => {
      muteNativeCaptions(video)

      const segment = findSegmentAt(segments, video.currentTime)
      const key = segment ? `${segment.start}|${segment.zh}` : ''
      if (key === lastKey) return
      lastKey = key

      const chinese = segment ? segment.zh : ''
      const english = segment ? segment.en : ''

      zhLine.textContent = chinese
      zhLine.style.display = chinese ? '' : 'none'

      enLine.textContent = english
      enLine.style.display = state.settings.showEnglish && english ? '' : 'none'
    }

    const timer = setInterval(render, 100)
    video.addEventListener('seeked', render)
    render()

    return () => {
      clearInterval(timer)
      video.removeEventListener('seeked', render)
    }
  }

  const waitFor = async (predicate, { tries = 60, intervalMs = 500 } = {}) => {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      const value = predicate()
      if (value) return value
      await sleep(intervalMs)
    }
    return null
  }

  const run = async ({ force = false } = {}) => {
    if (state.running) return
    state.running = true

    try {
      state.stopRendering?.()
      state.stopRendering = null

      const player = await waitFor(() => document.querySelector('mux-player'))
      if (!player) {
        setStatus('這頁沒有影片', '#999')
        return
      }

      const video = await waitFor(findVideoElement)
      if (!video) {
        setStatus('找不到播放器內的 video', '#ff9a9a')
        return
      }

      const playbackId = await waitFor(getPlaybackId)
      if (!playbackId) {
        setStatus('讀不到影片 ID', '#ff9a9a')
        return
      }
      state.playbackId = playbackId

      setStatus('抓字幕檔…')
      const cues = await fetchAllCues(playbackId, (current, total) => {
        setStatus(`抓字幕檔… ${current}/${total}`)
      })

      if (cues.length === 0) {
        setStatus('這集沒有字幕內容', '#ff9a9a')
        return
      }
      log('cue 總數', cues.length)

      const overlay = createOverlay(player, state.settings)
      if (!overlay) {
        setStatus('無法建立字幕層', '#ff9a9a')
        return
      }

      const segments = await buildSegments(cues, playbackId, { force })
      state.stopRendering = startRendering(video, segments, overlay)

      // 這集已經能看了，背景順手把下一集也備好，不擋主流程
      prefetchNext().catch(() => {})
    } catch (error) {
      log('執行失敗', error)
      setStatus(`出錯：${error.message}`.slice(0, 70), '#ff9a9a')
    } finally {
      state.running = false
    }
  }

  // ---------------------------------------------------------------------------
  // 啟動 + SPA 換頁偵測（Next.js 換集數不會重新載入頁面）
  // ---------------------------------------------------------------------------

  const boot = () => {
    createPanel({
      onRetranslate: () => run({ force: true }),
      onToggleEnglish: () => {
        state.settings = { ...state.settings, showEnglish: !state.settings.showEnglish }
        writeSettings(state.settings)
        setStatus(state.settings.showEnglish ? '中英雙語' : '只看中文', '#9de89d')
      },
      onResetKey: () => {
        clearApiKey(CONFIG.engine)
        setStatus('API key 已清除，重新整理後會再問一次', '#ffd08a')
      },
      onResetSync: () => {
        const config = resetSyncConfig()
        if (config) {
          setStatus('共享字幕已設定', '#9de89d')
        } else {
          setStatus('未使用共享字幕', '#ffd08a')
        }
      },
    })

    run()

    let lastUrl = location.href
    setInterval(() => {
      if (location.href === lastUrl) return
      lastUrl = location.href
      state.stopRendering?.()
      state.stopRendering = null
      document.getElementById(OVERLAY_ID)?.remove()
      setStatus('換集了，重新處理…')
      run()
    }, 1000)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()

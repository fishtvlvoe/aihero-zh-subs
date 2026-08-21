# 任務：把腳本接上共享字幕伺服器

只改一個檔案：`aihero-zh-subs.user.js`。不要改其他檔案，不要 git commit。

---

## 背景

這支腳本會把英文字幕翻成繁體中文，翻完存在**本機**的 Tampermonkey 儲存區。
問題是換一台電腦就得整門課重翻一次。

已經有一個部署好的 Cloudflare Worker 可以存放翻譯結果，現在要讓腳本用它。

目標行為：

```
開影片
 → 先看本機快取，有就直接用（最快）
 → 沒有就問伺服器，有就抓下來用，順便寫進本機快取
 → 還是沒有才自己翻
 → 翻完（而且是完整翻好的）自動上傳，讓其他電腦directly 撿現成
```

---

## 伺服器介面（已經部署好，不要改 worker/ 底下任何東西）

驗證方式：HTTP header `Authorization: Bearer <token>`

### 讀取

```
GET {syncUrl}/subs/{playbackId}
```

- `200` → body 是 `{ "segments": [...], "count": 116, "updatedAt": "2026-08-21T..." }`
- `404` → 這一集還沒有人上傳過（**這是正常情況，不是錯誤**）
- `401` → token 不對

### 上傳

```
PUT {syncUrl}/subs/{playbackId}
Content-Type: application/json
body: { "segments": [...] }
```

- `200` → `{ "ok": true, "count": 116, "updatedAt": "..." }`
- `400` → 資料格式不合（段落缺欄位、空陣列、超過 5000 段、body 超過 512KB）

伺服器會驗證每個 segment 必須有：
`start`（number）、`end`（number）、`en`（string）、`zh`（string），且 `end >= start`。
這跟腳本內部的 segment 格式一致，直接傳就好。

---

## 要做的事

### 1. metadata 加上 `@connect`

在現有的 `@connect` 那幾行後面加：

```javascript
// @connect      workers.dev
```

### 2. CONFIG 加一區

在 `prefetchNextLesson` 那一行後面加：

```javascript
    // 共享字幕：翻好的結果上傳到自己的 Worker，換電腦就不用重翻。
    // 沒設定就完全不影響原本的流程。
    sync: Object.freeze({
      enabled: true,
      timeoutMs: 8000,
    }),
```

### 3. STORAGE_KEYS 加兩個

```javascript
    syncUrl: 'zhsub_sync_url',
    syncToken: 'zhsub_sync_token',
```

### 4. 新增取得同步設定的函式

放在 `getApiKey` 附近，做法比照它 —— **不要把網址或 token 寫死在原始碼裡**，
這樣腳本才能安全地公開分享。

```javascript
  // 同步設定存在 Tampermonkey 儲存區，不寫進原始碼，這樣腳本可以安全分享。
  // 使用者按取消就把 sync 關掉，之後不再打擾。
  const getSyncConfig = ({ promptIfMissing = true } = {}) => {
    if (!CONFIG.sync.enabled) return null

    const settings = readSettings()
    if (settings.syncDeclined) return null

    let url = GM_getValue(STORAGE_KEYS.syncUrl, '')
    let token = GM_getValue(STORAGE_KEYS.syncToken, '')

    if ((!url || !token) && promptIfMissing) {
      const inputUrl = window.prompt(
        '共享字幕伺服器網址（留空＝不使用，只存本機）\n例如 https://xxx.workers.dev',
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
```

### 5. 新增讀取與上傳

放在 `getSyncConfig` 後面。**兩個都不可以讓例外往外丟** ——
同步壞掉絕對不能害到翻譯本身。

```javascript
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
```

**注意 `httpRequest` 目前的簽名是 `{ method, url, headers, body }`，timeout 寫死 120000。**
要多加一個可選的 `timeout` 參數，預設維持 120000，不要改動原本呼叫端的行為。

### 6. 接進 `buildSegments`

現在的開頭長這樣：

```javascript
    if (!force) {
      const cached = readCachedSegments(playbackId)
      const cachedZh = cached ? cached.filter((segment) => segment.zh).length : 0
      if (cached && cachedZh > 0) {
        ...
        return cached
      }
    }
```

在**本機快取沒中**之後、**要 API key 之前**，插入問伺服器的邏輯：

```javascript
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
```

然後在最後寫本機快取的地方，加上上傳。現在長這樣：

```javascript
    if (translated > 0) writeCachedSegments(playbackId, segments)
```

改成：

```javascript
    if (translated > 0) writeCachedSegments(playbackId, segments)

    // 只有整集都翻好才上傳。半成品傳上去會害到其他電腦。
    if (syncConfig && translated === segments.length) {
      await uploadSegments(playbackId, segments, syncConfig)
    }
```

### 7. 版本號

`@version` 從 `3.4.2` 改成 `3.5.0`。

---

## 完成前一定要做的檢查

1. `node --check aihero-zh-subs.user.js` 要過
2. `grep -n "console.log"` 要沒有結果（診斷訊息一律用既有的 `log()`）
3. `grep -n "workers.dev"` 只能出現在 `@connect` 那一行 ——
   **原始碼裡絕對不可以出現任何實際網址或 token**
4. 確認 `httpRequest` 加了可選 `timeout` 之後，原本沒傳 timeout 的呼叫端行為不變
5. 確認 `getSyncConfig` 在 `buildSegments` 之前定義
6. 確認同步相關的例外都被 try/catch 包住，不會讓 `buildSegments` 整個爆掉

## 不要做的事

- 不要改 `worker/` 底下任何檔案
- 不要把網址或 token 寫死進原始碼
- 不要動翻譯、切分、重試、overlay、控制面板的邏輯
- 不要在同步失敗時中斷翻譯流程

做完簡短回報改了什麼，以及六項檢查的結果。

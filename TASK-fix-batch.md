# 任務：字幕翻譯的重試與快取修正

只改一個檔案：`/Users/fishtv/Documents/Dev/aihero-zh-subs/aihero-zh-subs.user.js`

不要改其他檔案。不要改 README、不要改 HANDOFF.md、不要開新檔案。

---

## 背景（看懂再動手）

這是一支 Tampermonkey 使用者腳本，把英文字幕丟給 Gemini 翻成繁體中文。

流程是：整集字幕切成一批一批（`CONFIG.batchSize` 格一批）送去翻，
模型回一個 JSON 陣列，每個元素是 `{"s": 起始格號, "e": 結束格號, "t": "中文"}`。
`groupsToSegments()` 把這些分組轉成實際要顯示的字幕段落。

已知並且已經修好的 bug（**不要重複修**）：
輸出被截斷導致 JSON 解析失敗。已經透過調高 `maxOutputTokens`、關掉 thinking、
縮小 `batchSize`、加上 `salvageObjects()` 搶救截斷的 JSON 解決了。

**這次要修的是剩下兩件事。**

---

## 修正 A：沒翻到的部分要自動重試

### 現況問題

一批送 30 格，模型可能只回了前 20 格的分組，後 10 格沒被涵蓋。
`groupsToSegments()` 會把沒涵蓋到的格子補成「只有英文」的段落，然後就結束了。
使用者看到的就是影片某一段完全沒有中文。

### 要做的事

**A-1. 讓 `groupsToSegments` 回報哪些格子有翻到**

目前簽名是 `groupsToSegments(groups, cues)`，回傳排序好的 segments 陣列。

改成回傳一個物件：

```javascript
{ segments, covered }
```

- `segments`：跟現在一樣，排序好的段落陣列
- `covered`：函式內部已經有的那個 `Set`，直接一起回傳

函式內部邏輯完全不用動，只改回傳值。

**A-2. 新增 `contiguousRuns(total, covered)`**

放在 `groupsToSegments` 後面。用途是把「沒被涵蓋的格號」整理成連續區間。

```javascript
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
```

**A-3. 新增 `translateSlice(slice, apiKey, depth)`**

放在 `contiguousRuns` 後面，或放在 `buildSegments` 前面都可以，
但一定要在 `buildSegments` 用到它之前就定義好。

行為：

1. `slice` 是空陣列就回傳 `[]`
2. 把 slice 轉成 `items`（`{ i: index, text: cue.text }`），呼叫 `await translateBatch(items, apiKey)`
3. 整批丟出例外時：
   - 已經 `depth >= CONFIG.maxRetriesPerBatch` 或 `slice.length < 2` → 把例外往上丟
   - 否則把 slice 對半切，`await sleep(800)` 之後兩半各自遞迴（`depth + 1`），結果接起來回傳
4. 沒丟例外時，用 `contiguousRuns(slice.length, covered)` 找出沒翻到的區間：
   - 沒有缺口，或 `depth >= CONFIG.maxRetriesPerBatch` → 直接回傳 `segments`
   - 有缺口 → 只把缺口那幾段重送（`slice.slice(run.from, run.to + 1)`，`depth + 1`）。
     重送失敗就用 `untranslatedSegments(sub)` 保底，不要讓整段消失。
   - 最後把「原本就翻到的段落」（`segments.filter((segment) => segment.zh)`）
     跟補翻回來的段落合併，依 `start` 排序後回傳

重點：**只重送沒翻到的部分，已經翻好的不要重送** — 這是為了省 API 額度。

參考骨架（可以照抄，也可以自己寫得更好）：

```javascript
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
```

**A-4. 讓 `buildSegments` 改用 `translateSlice`**

把批次迴圈裡這兩行：

```javascript
const groups = await translateBatch(items, apiKey)
segments.push(...groupsToSegments(groups, slice))
```

換成：

```javascript
segments.push(...(await translateSlice(slice, apiKey)))
```

迴圈裡原本那行 `const items = slice.map(...)` 就沒用了，刪掉（`translateSlice` 自己會做）。
`catch` 區塊維持原樣不動。

---

## 修正 B：部分成功也要寫快取

### 現況問題

```javascript
if (failed === 0) writeCachedSegments(playbackId, segments)
```

只要有任何一批失敗，**整集的翻譯成果都不會被存下來**。
後果是使用者每次重開頁面，整集全部重翻一次，Gemini 免費額度重複燒，
而且同一個位置大機率再失敗一次。

### 要做的事

**B-1. 改寫入條件**

改成「只要有翻到東西就存」：

```javascript
segments.sort((a, b) => a.start - b.start)

const translated = segments.filter((segment) => segment.zh).length

// 以前是「一批失敗就整集不存」，結果每次重開都整集重翻、重燒 API 額度。
// 現在只要有翻到東西就存起來，沒翻到的部分下次可以按「重新翻譯」補。
if (translated > 0) writeCachedSegments(playbackId, segments)

const color = translated === segments.length ? '#9de89d' : '#ffd08a'
report(`字幕就緒（${translated}/${segments.length} 句）`, color)
return segments
```

注意 `failed` 這個變數在 `catch` 裡還是要繼續累加（`catch` 區塊不要動），
只是不再拿它當寫入快取的條件。如果改完之後 `failed` 完全沒有被讀取了，
就把 `let failed = 0` 跟 `failed += 1` 一起刪掉，不要留沒用到的變數。

**B-2. 讀快取時要誠實回報缺口**

找到 `readCachedSegments` 的呼叫處（在 `buildSegments` 開頭，`if (!force)` 裡面）。

現況：

```javascript
if (!force) {
  const cached = readCachedSegments(playbackId)
  if (cached) {
    report(`字幕就緒（${cached.length} 句，全部來自快取）`, '#9de89d')
    return cached
  }
}
```

改成：全部都是英文的快取沒有意義，當作沒有快取；
有缺口的快取還是照用（開起來就有得看），但狀態列要講實話。

```javascript
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
```

---

## 完成前一定要做的檢查

1. `node --check aihero-zh-subs.user.js` 要過
2. 確認 `groupsToSegments` 的**所有**呼叫端都已經配合改成用 `{ segments, covered }`。
   用 `grep -n "groupsToSegments" aihero-zh-subs.user.js` 檢查，不要漏掉任何一個。
3. 確認 `translateSlice` 的定義位置在 `buildSegments` 之前
4. 確認沒有留下沒用到的變數（例如上面提到的 `failed`、`items`）
5. `grep -n "console.log" aihero-zh-subs.user.js` 要沒有結果
   （這個檔案裡診斷訊息一律走既有的 `log()`）

## 不要做的事

- 不要動 `CONFIG` 裡的任何數值
- 不要動 `SYSTEM_PROMPT` 或 `buildUserPrompt`
- 不要動 `salvageObjects` 或 `parseTranslationJson`
- 不要動 `translateViaGemini` / `translateViaClaude`
- 不要動任何跟畫面、overlay、控制面板有關的程式碼
- 不要改 `@version`
- 不要 git commit、不要 git add

做完請簡短回報你改了哪幾個函式，以及 `node --check` 的結果。

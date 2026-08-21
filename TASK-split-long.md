# 任務：把過長的字幕段落切成小塊

只改一個檔案：`/Users/fishtv/Documents/Dev/aihero-zh-subs/aihero-zh-subs.user.js`

不要改其他檔案。不要開新檔案。不要 git commit。

---

## 背景

這支腳本把英文字幕丟給 Gemini 翻成繁體中文，疊在影片上顯示。

模型會把「屬於同一句話」的連續字幕格合併成一組再翻譯。
合併後的結果是一個 segment：`{ start, end, en, zh }`。

**現況問題**：模型常常一次合併 3～4 格，翻出來的中文就很長。
實測中位數 35 字、最長 95 字、35% 超過 40 字。
95 個中文字疊在影片上，觀眾根本讀不完。

**不能用的解法**：以前是把「合併太多格」的分組整組丟掉，
結果 30 格只蓋到 7 格，其餘變成純英文。已經證實這條路是錯的，不要走回去。

**正確解法**：分組照單全收，但在轉成 segment 之後，
把太長的中文**切成幾小塊**，按長度比例分配時間。
合併 4 格的字幕本來就會在畫面上停留 10 秒以上，切成 3 塊每塊停 3 秒多，剛好。

---

## 要做的事

### 1. 新增 `splitLongSegment(segment, maxChars)`

放在 `groupsToSegments` 前面（`toSegment` 後面）。

輸入一個 segment，回傳一個 segment **陣列**（切不動就回傳只有它自己的陣列）。

規則：

1. `segment.zh` 長度 <= `maxChars`，或 `zh` 是空字串 → 直接回傳 `[segment]`
2. 否則決定要切幾塊：`const parts = Math.ceil(zh.length / maxChars)`
3. 在**標點處**切，優先順序：`。！？` > `，、；：` > 空白。
   目標是切成 `parts` 塊，每塊盡量接近 `zh.length / parts` 字。
   找不到合適標點就不要硬切（寧可留一塊長的，也不要切在詞中間）。
4. 時間按**每塊的字數比例**分配。例如 segment 從 10s 到 22s（共 12 秒），
   切成 30 字 + 20 字兩塊，第一塊就是 10s→17.2s，第二塊 17.2s→22s。
5. 每一塊的 `en` 都填**原本整段的 `en`**（英文不切，因為英文跟中文的斷點對不起來）。
   下游只是拿來顯示對照，重複沒關係。
6. 切出來的塊要保持**時間連續且不重疊**：前一塊的 `end` 就是下一塊的 `start`。

建議實作方式（可以照抄，也可以自己寫得更好）：

```javascript
// 一組合併多格的字幕，中文可能很長。中文切成幾塊、時間按字數比例分，
// 這樣覆蓋率不會有洞（不能靠丟掉分組來控制長度，那會讓整段變回純英文）。
const splitLongSegment = (segment, maxChars) => {
  const zh = String(segment.zh || '')
  if (!zh || zh.length <= maxChars) return [segment]

  const parts = Math.ceil(zh.length / maxChars)
  const target = zh.length / parts
  const STRONG = '。！？'
  const WEAK = '，、；：'

  // 依標點找切點，盡量靠近 target 的倍數
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
      if (!isStrong && !isWeak && ch !== ' ') continue
      // 強標點優先：距離上打折，讓它比弱標點更容易被選中
      const score = Math.abs(i - ideal) * (isStrong ? 0.6 : isWeak ? 1 : 1.4)
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

  // 時間按字數比例分，並且首尾要對齊原本的 start / end
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
```

### 2. 在 CONFIG 加一個設定

在 `maxMergeSpan: 4,` 後面加：

```javascript
    // 一句字幕最多幾個中文字。超過就在標點處切開，時間按字數比例分。
    maxCharsPerLine: 32,
```

### 3. 讓 `groupsToSegments` 套用它

`groupsToSegments` 目前這一行：

```javascript
      segments.push(toSegment(cues, from, to, zh))
```

改成：

```javascript
      segments.push(...splitLongSegment(toSegment(cues, from, to, zh), CONFIG.maxCharsPerLine))
```

**注意**：`groupsToSegments` 回傳的是 `{ segments, covered }`，
`covered` 的語意是「哪些**字幕格編號**已經被涵蓋」，跟切不切無關，**不要動 covered 的邏輯**。
切開只是讓同一個時間範圍變成多筆 segment，涵蓋的格子還是同一批。

---

## 完成前一定要做的檢查

1. `node --check aihero-zh-subs.user.js` 要過
2. `grep -n "console.log" aihero-zh-subs.user.js` 要沒有結果（診斷訊息一律走既有的 `log()`）
3. `splitLongSegment` 的定義位置要在 `groupsToSegments` 之前
4. 寫一個**臨時**的驗證腳本放在 `/tmp`（不要放在專案裡），確認：
   - 短的 segment 原封不動回傳
   - 長的 segment 會被切開，且每塊都 <= 大約 maxChars（允許超一點點，因為要遷就標點）
   - 切出來每塊的時間**連續不重疊**，而且第一塊的 start 等於原本的 start、
     最後一塊的 end 等於原本的 end
   - `zh` 是空字串時不會爆
   - 找不到任何標點的超長字串，會原封不動回傳（不硬切）
   跑給我看結果，然後把那個臨時腳本刪掉

## 不要做的事

- 不要動 `maxMergeSpan`（現在是 4，是對的）
- 不要動 `SYSTEM_PROMPT`
- 不要動 `translateSlice`、`contiguousRuns`、`parseTranslationJson`、`salvageObjects`
- 不要動任何跟 overlay、控制面板、快取有關的程式碼
- 不要改 `@version`
- 不要退回「把分組丟掉」那種做法

做完請簡短回報你改了什麼，以及驗證腳本的輸出。

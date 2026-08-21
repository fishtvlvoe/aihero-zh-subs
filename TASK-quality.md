# 任務：三個翻譯品質改善

只改 `aihero-zh-subs.user.js`。不要改其他檔案，不要 git commit，不要改 `@version`。

---

## 背景

實測發現兩類問題：

1. **字面直譯**：`the stuff that's very, very sacred` 翻成「非常神聖不可侵犯的」。
   英文本身沒錯，`sacred` 是慣用講法（碰不得、動不得），照字典翻就變得很怪。
2. **聽打錯誤**：英文字幕是自動生成的，專有名詞常被聽錯。

這次做三件事。**不要做音訊比對**（成本太高，老闆決定先不做）。

---

## 一、同一集的用詞統一（純本機，不打 API）

專有名詞在一集裡會重複出現，聽打不會每次都錯。少數拼錯的可以用多數決修回來。

新增 `normalizeTerms(cues)`，放在 `dedupeCues` 後面。回傳**新的** cues 陣列（不要改原陣列）。

規則要**保守**，寧可漏修也不要改錯：

1. 從所有 cue 文字取出詞元（用 `/\b[A-Za-z][A-Za-z0-9]{3,}\b/g`）
2. 只考慮**首字母大寫**或**全大寫**的詞（專有名詞／術語），長度 >= 4
3. 統計出現次數
4. 兩個詞要視為同一個詞的變體，必須**同時**滿足：
   - 編輯距離**剛好等於 1**（只差一個字元）
   - 忽略大小寫後不相同（大小寫差異不算錯字，不要動）
   - 多數形出現次數 >= 少數形的 **3 倍**
   - 多數形出現次數 >= **3 次**
5. 把少數形換成多數形（用 `\b` 邊界的全域取代）
6. 每改一個詞就 `log('用詞統一', 少數形, '→', 多數形, 次數)`

編輯距離請自己寫一個小的 Levenshtein，長度差 > 1 直接回傳 2 提早結束。

在 `fetchAllCues` 回傳之前套用它（或在呼叫端接上），確保 `buildSegments` 拿到的是統一過的。

## 二、把課程簡介帶進提示詞

目前 `readLessonTitle()` 只抓 `h1`。改成 `readLessonContext()`，回傳：

```javascript
{ title: '...', description: '...' }
```

- `title`：`h1` 的文字，取不到就用 `document.title` 去掉 ` | ...` 後綴。上限 120 字
- `description`：`document.querySelector('meta[name="description"]')?.content`，
  取不到就試 `meta[property="og:description"]`。上限 300 字

`state` 的 `lessonTitle` 換成 `lessonContext`（物件），`run()` 裡設定它。

`buildUserPrompt` 開頭改成：

```javascript
    const ctx = state.lessonContext || {}
    const context = []
    if (ctx.title) context.push(`這是線上課程的影片字幕，這一集的主題是：${ctx.title}`)
    if (ctx.description) context.push(`這一集的簡介：${ctx.description}`)
    if (context.length) context.push('（以上是背景資訊，用來判斷專有名詞和語氣，不要翻譯這幾行）', '')
```

然後把 `...context` 放在字幕前面。

## 三、複查回合

翻完一批之後，把「英文 + 剛翻好的中文」送回去請模型複查。

### CONFIG 加一區

在 `sync` 那一區後面：

```javascript
    // 翻完再複查一次，抓字面直譯和讀起來不像人話的句子。
    // 只在第一次翻譯時發生，翻完會快取，所以成本只付一次。
    review: Object.freeze({ enabled: true }),
```

### 新增 `REVIEW_SYSTEM_PROMPT`

放在 `SYSTEM_PROMPT` 後面：

```javascript
  const REVIEW_SYSTEM_PROMPT = [
    '你是台灣繁體中文的字幕審稿人。下面是英文字幕與它的中文翻譯。',
    '',
    '你的工作是抓出「意思差很多」或「中文很不自然」的句子，只改這些，其餘一律不動。',
    '',
    '要改的情況：',
    '1. 慣用語、比喻被照字面硬翻。例如講資料或程式時的 sacred，'
      + '意思是「動不得、碰不得、非常寶貴」，翻成「神聖」就錯了。',
    '2. 中文讀起來不像台灣人講話，或語序像英文。',
    '3. 意思跟英文差很多，或漏掉關鍵資訊。',
    '4. 出現非台灣用詞（視頻、代碼、項目、數據、接口、內存、默認、函數、字符串）。',
    '5. 出現簡體字。',
    '',
    '不要改的情況：',
    '- 只是用詞可以更好，但意思沒錯 → 不要動',
    '- 技術名詞、產品名、指令、檔名保留英文是正確的 → 不要動',
    '- 你只是想換個說法 → 不要動',
    '',
    '寧可少改，不要為了改而改。大部分句子應該都不用動。',
    '',
    '輸出格式：只回傳一個 JSON 陣列，只放**需要修改**的項目，'
      + '每個元素是 {"i": 編號, "zh": "改好的中文"}。',
    '完全不用改就回傳空陣列 []。不要加任何說明文字或 markdown 標記。',
  ].join('\n')
```

### 新增 `reviewSegments(segments, apiKey)`

放在 `translateSlice` 後面。

- `CONFIG.review.enabled` 是 false → 直接回傳原本的 `segments`
- 沒有任何 `zh` 的段落（全是英文）→ 直接回傳原本的
- 送出的內容：每行 `${i}\t英文\t中文`，只送有 `zh` 的段落
- 呼叫方式比照 `translateViaGemini`（同樣的 endpoint、`response_mime_type`、
  `thinkingConfig`、`maxOutputTokens`），但 system instruction 用 `REVIEW_SYSTEM_PROMPT`
- 解析用既有的 `parseTranslationJson`
- 套用修改時**只能改 `zh`**，`start` / `end` / `en` 絕對不能動：

```javascript
      const patched = segments.map((seg) => ({ ...seg }))
      list.forEach((item) => {
        const i = Number(item?.i)
        const zh = String(item?.zh || '').trim()
        if (!Number.isInteger(i) || i < 0 || i >= patched.length) return
        if (!zh) return
        if (!patched[i].zh) return          // 原本就沒中文的不要補
        patched[i].zh = zh
      })
```

- **整個函式包在 try/catch 裡，任何失敗都回傳原本的 `segments`**。
  複查是加分項，絕對不能因為它失敗就毀掉翻譯結果。
- 成功時 `log('複查完成', 改了幾句, '/', 總句數)`

### 接進 `buildSegments`

批次迴圈裡，`translateSlice` 回來之後、`segments.push` 之前插入複查：

```javascript
      try {
        const translated = await translateSlice(slice, apiKey)
        report(`複查中… ${batchIndex + 1}/${totalBatches}`, '#ffd08a')
        segments.push(...(await reviewSegments(translated, apiKey)))
      } catch (error) {
        ...維持原本的 catch 不變...
      }
```

---

## 完成前一定要做的檢查

1. `node --check aihero-zh-subs.user.js` 要過
2. `grep -n "console.log"` 要沒有結果
3. 確認 `normalizeTerms` **不會改動傳進去的原陣列**（要回傳新陣列）
4. 確認 `reviewSegments` 失敗時回傳原本的 segments，不會讓 `buildSegments` 拋例外
5. 確認 `reviewSegments` 只改 `zh`，沒有動到 `start` / `end` / `en`
6. 確認 `state.lessonContext` 的宣告位置在 `buildUserPrompt` 之前（避免 TDZ）
7. 寫一個**臨時**驗證腳本放 `/tmp`（不要放專案裡），確認 `normalizeTerms`：
   - 編輯距離 1 且次數差 3 倍以上 → 會統一
   - 只有大小寫不同 → **不動**
   - 編輯距離 2 → **不動**
   - 次數相近（例如 3 比 2）→ **不動**
   - 原陣列沒有被修改
   跑給我看結果，然後刪掉那個臨時腳本

## 不要做的事

- 不要做音訊比對
- 不要動批次切分、重試、切長句、快取、同步、overlay 的邏輯
- 不要改 `@version`
- 不要把網址或 token 寫進原始碼

做完簡短回報改了什麼跟七項檢查結果。

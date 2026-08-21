# 任務：把課程脈絡帶進提示詞，並加上慣用語規則

只改 `aihero-zh-subs.user.js`。不要改其他檔案，不要 git commit，不要改 `@version`。

---

## 背景：實際遇到的錯誤

某一集的英文字幕是：

> In other words, it has all of your data, all the user data, the stuff that's very, very sacred.

目前翻成：

> 所有使用者資料，這些都是非常神聖的。

**「神聖」是照字典硬翻。** 這裡的 `sacred` 是英文慣用講法，形容「碰不得、不能亂動」，
在講資料庫遷移的脈絡下指的是「正式資料動不得」。
中文應該翻成「動不得的」「碰不得的」「非常寶貴」這類講法。

兩個原因造成這個問題：

1. 提示詞裡**完全沒有處理慣用語／比喻**的規則
2. 模型只看到一批孤立的字幕，**不知道這一集在講什麼主題**

---

## 要做的事

### 1. 抓課程標題，存成模組層級變數

不要改 `buildSegments` / `translateSlice` / `translateBatch` /
`translateViaGemini` / `translateViaClaude` 的簽名 —— 那要改五層太囉嗦。
改用一個模組層級變數，開場設定一次就好（一個頁面本來就只有一集）。

在 `state` 物件（`const state = { playbackId: '', ... }`）裡加一個欄位：

```javascript
    lessonTitle: '',
```

新增一個函式，放在 `buildUserPrompt` 之前：

```javascript
  // 讓模型知道這一集在講什麼。只看孤立的字幕很容易把慣用語照字面翻，
  // 也比較難判斷聽打錯誤。
  const readLessonTitle = () => {
    const heading = document.querySelector('h1')
    const fromHeading = heading ? heading.textContent.trim() : ''
    if (fromHeading) return fromHeading.slice(0, 120)
    return String(document.title || '').replace(/\s*\|\s*$/, '').trim().slice(0, 120)
  }
```

在 `run()` 裡面，取得 `playbackId` 之後、開始翻譯之前，設定它：

```javascript
    state.lessonTitle = readLessonTitle()
```

（`prefetchNext()` 預抓下一集時**不要**覆蓋這個值 —— 那是背景抓別集，
標題不同會誤導當前這集的翻譯。保持現況即可，不用特別處理。）

### 2. `buildUserPrompt` 帶上脈絡

```javascript
  const buildUserPrompt = (items) => {
    const lines = items.map((item) => `${item.i}\t${item.text}`).join('\n')
    const context = state.lessonTitle
      ? [`這是線上課程的影片字幕，這一集的主題是：${state.lessonTitle}`, '']
      : []
    return [
      ...context,
      `以下是 ${items.length} 格連續的英文字幕（格式為「編號 tab 原文」）：`,
      '',
      lines,
      '',
      `請先讀懂整段語意，再把屬於同一句話的連續格子合併，翻成繁體中文。`,
      `編號範圍是 0 到 ${items.length - 1}，每個編號都要被涵蓋一次。`,
    ].join('\n')
  }
```

**注意**：`buildUserPrompt` 目前定義在 `state` 之前，直接引用 `state` 會有
TDZ 問題（`const state` 尚未初始化）。**請把 `state` 的宣告移到
`buildUserPrompt` 之前**，或改用其他不會有初始化順序問題的做法。
改完務必確認執行時不會拋 `Cannot access 'state' before initialization`。

### 3. `SYSTEM_PROMPT` 加一條慣用語規則

現在第 12 條是處理聽打錯誤的：

```javascript
    '12. 原文若有明顯的語音辨識錯誤（專有名詞被聽錯），依上下文判斷正確的詞再翻。',
```

在它後面加第 13 條：

```javascript
    '13. 遇到慣用語、比喻、誇飾，翻「意思」不要翻「字面」。'
      + '例如講程式或資料時說 sacred，意思是「動不得、碰不得」，不是「神聖」；'
      + 'hairy 是「棘手」不是「多毛」；under the hood 是「底層運作」不是「引擎蓋下」。'
      + '照字面硬翻會讓中文看起來很怪，寧可換個說法也要讓人看得懂。',
```

---

## 完成前一定要做的檢查

1. `node --check aihero-zh-subs.user.js` 要過
2. `grep -n "console.log"` 要沒有結果
3. **確認沒有 TDZ 問題**：`state` 的宣告位置必須在 `buildUserPrompt` 之前。
   用 `grep -n "const state = {" ` 和 `grep -n "const buildUserPrompt"` 比對行號。
4. 確認 `readLessonTitle` 定義在 `run()` 之前
5. `grep -nE "workers\.dev|z[rw]_[A-Za-z0-9]{10,}"` 只能出現在 `@connect` 那一行
6. 確認沒有動到 `buildSegments` / `translateSlice` / `translateBatch` 的簽名

## 不要做的事

- 不要動翻譯批次、重試、切分、快取、同步、overlay 的邏輯
- 不要改 `@version`
- 不要把網址或 token 寫進原始碼

做完簡短回報改了什麼跟六項檢查結果。

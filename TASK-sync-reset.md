# 任務：讓共享字幕設定可以重新設定

只改 `aihero-zh-subs.user.js`。不要改其他檔案，不要 git commit。

---

## 問題

`getSyncConfig` 現在長這樣（簡化）：

```javascript
const settings = readSettings()
if (settings.syncDeclined) return null
...
if (inputUrl === null || inputUrl.trim() === '') {
  writeSettings({ ...settings, syncDeclined: true })
  return null
}
```

只要提示視窗被關掉一次（使用者手滑按取消，或瀏覽器自動關掉），
`syncDeclined` 就被寫成 `true`，之後**永遠**不會再問，
而且面板上沒有任何按鈕可以救回來 —— 同步等於永久壞掉。

面板上已經有「重設 API key」，缺一個對應的同步重設。

---

## 要做的事

### 1. `getSyncConfig` 加一個 `force` 參數

```javascript
const getSyncConfig = ({ promptIfMissing = true, force = false } = {}) => {
  if (!CONFIG.sync.enabled) return null

  const settings = readSettings()
  if (settings.syncDeclined && !force) return null
  ...
}
```

`force: true` 時要無視 `syncDeclined`，而且**一定要重新問**
（就算儲存區已經有值也要問，這樣才能改成別的伺服器）。

實作提示：`force` 為真時，把讀出來的 `url` / `token` 當成提示視窗的預設值，
但不要因為「已經有值」就直接回傳。

### 2. 新增 `resetSyncConfig()`

放在 `getSyncConfig` 後面：

```javascript
// 面板按鈕用。清掉拒絕記號再重新問一次，
// 這樣手滑按到取消不會變成永久壞掉。
const resetSyncConfig = () => {
  const settings = readSettings()
  writeSettings({ ...settings, syncDeclined: false })
  const config = getSyncConfig({ promptIfMissing: true, force: true })
  return config
}
```

### 3. 面板加一顆按鈕

找到 `createPanel` 裡建立「重設 API key」按鈕的地方，照同樣的寫法，
在它後面加一顆 **「設定共享字幕」**。

按下去要：

1. 呼叫 `resetSyncConfig()`
2. 依結果更新狀態列：
   - 有拿到設定 → `setStatus('共享字幕已設定', '#9de89d')`
   - 沒有（使用者取消）→ `setStatus('未使用共享字幕', '#ffd08a')`

按鈕的樣式、建立方式、加進面板的方式，全部比照現有那幾顆，不要自己另外設計。

---

## 完成前一定要做的檢查

1. `node --check aihero-zh-subs.user.js` 要過
2. `grep -n "console.log"` 要沒有結果
3. 確認 `resetSyncConfig` 定義在 `createPanel` 之前
4. 確認**沒有 `force` 參數時行為完全不變**
   （`syncDeclined` 為真就安靜地回 null，不要跳視窗騷擾使用者）
5. 確認原始碼裡沒有任何實際網址或 token
   （`grep -nE "workers\.dev|z[rw]_[A-Za-z0-9]{10,}"` 只能出現在 `@connect` 那一行）

## 不要做的事

- 不要動翻譯、切分、重試、快取、overlay 的邏輯
- 不要動 `fetchRemoteSegments` / `uploadSegments`
- 不要把網址或 token 寫死進原始碼
- 不要改 `@version`（我自己會改）

做完簡短回報改了什麼跟五項檢查結果。

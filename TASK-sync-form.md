# 任務：共享字幕設定改用面板表單，拿掉 window.prompt

只改 `aihero-zh-subs.user.js`。不要改其他檔案，不要 git commit。

---

## 為什麼要改

現在的同步設定用 `window.prompt` 問網址和 token，有三個問題：

1. `window.prompt` 會**凍結整個頁面**的 JavaScript
2. 看不到目前設定的是什麼，想改成別的伺服器只能重打
3. 按錯一次取消就寫下 `syncDeclined`，同步永久停用

改成面板裡的小表單，三個問題一次解決。

---

## 要做的事

### 1. 簡化 `getSyncConfig`

**整個拿掉 `promptIfMissing`、`force`、`syncDeclined` 這些東西。**
沒設定就是沒設定，安靜地回 `null`，不要問任何問題。

```javascript
  // 同步設定存在 Tampermonkey 儲存區，不寫進原始碼，這樣腳本可以安全分享。
  // 沒設定就安靜關閉，不打擾使用者 —— 要設定請用面板上的「共享字幕」表單。
  const getSyncConfig = () => {
    if (!CONFIG.sync.enabled) return null
    const url = GM_getValue(STORAGE_KEYS.syncUrl, '')
    const token = GM_getValue(STORAGE_KEYS.syncToken, '')
    if (!url || !token) return null
    return { url, token }
  }

  const writeSyncConfig = (url, token) => {
    GM_setValue(STORAGE_KEYS.syncUrl, String(url || '').trim().replace(/\/+$/, ''))
    GM_setValue(STORAGE_KEYS.syncToken, String(token || '').trim())
  }
```

把 `resetSyncConfig` 刪掉，不需要了。

`buildSegments` 裡呼叫的地方從 `getSyncConfig({ promptIfMissing: !quiet })` 改成 `getSyncConfig()`。

### 2. 面板加一個可展開的表單

把現在那顆「設定共享字幕」按鈕改成切換表單顯示／隱藏。

表單放在按鈕下方，**預設隱藏**，內容：

- 一個 `<input type="text">` 放伺服器網址，`placeholder` 寫 `https://xxx.workers.dev`
- 一個 `<input type="password">` 放 token
- 一顆「儲存」按鈕、一顆「清除」按鈕

行為：

- **展開時**要把目前已存的值填進兩個輸入框（token 也填，讓使用者看得到有設定過）
- **儲存**：兩欄都有值才存。存完 `setStatus('共享字幕已設定', '#9de89d')`，收合表單。
  有任一欄是空的就 `setStatus('網址和 token 都要填', '#ff9a9a')`，不要收合。
- **清除**：把兩個 GM 值設成空字串，清空輸入框，`setStatus('已停用共享字幕', '#ffd08a')`，收合表單。

樣式比照面板現有的元件（背景 `#2c2c2c`、邊框 `#555`、圓角 6px、字級 12px、
輸入框寬度填滿、`box-sizing: border-box`）。不要另外設計新風格。

**重要**：表單和輸入框都要套用既有的 `markAsDoNotTranslate()`，
不然會被其他翻譯外掛翻掉。

### 3. 版本號

`@version` 改成 `3.6.0`。

---

## 完成前一定要做的檢查

1. `node --check aihero-zh-subs.user.js` 要過
2. `grep -n "console.log"` 要沒有結果
3. `grep -n "window.prompt"` **只能剩下 API key 那一處**，同步相關的要完全消失
4. `grep -n "syncDeclined"` 要完全沒有結果
5. `grep -nE "workers\.dev|z[rw]_[A-Za-z0-9]{10,}"` 只能出現在 `@connect` 那一行
6. 確認 `getSyncConfig` 沒設定時安靜回 `null`，不會跳任何視窗

## 不要做的事

- 不要動翻譯、切分、重試、快取、overlay 的邏輯
- 不要動 `fetchRemoteSegments` / `uploadSegments` 的內容
- 不要動 API key 那邊的 `window.prompt`（那個維持原樣）
- 不要把網址或 token 寫死進原始碼

做完簡短回報改了什麼跟六項檢查結果。

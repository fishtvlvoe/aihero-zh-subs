# AI Hero 繁體中文字幕 — 交接紀錄

最後更新：2026-08-21（字幕翻譯與跨機同步皆已完成並驗證）

這份是給「換一個模型／換一個 session 接手」用的完整背景。看完這份應該就能直接動工，不用回頭翻對話。

---

## 一、這是在解什麼問題

老闆買了 AI Hero 的 *AI Coding Crash Course*（`https://www.aihero.dev/workshops/ai-coding-crash-course/`）。
影片只有英文字幕，裝的兩個翻譯外掛（沉浸式翻譯、陪讀蛙 Read Frog）**都抓不到字幕**。

### 為什麼抓不到（根本原因，已確認）

播放器是 **Mux Player**（`<mux-player>`，底層是 media-chrome）。字幕走 HLS：

```
https://stream.mux.com/{playbackId}.m3u8   ← master
  └─ subtitles.m3u8                        ← 字幕 playlist
       └─ *.vtt 分段
```

播放器用**原生 TextTrack + `::cue`** 算繪字幕。`::cue` 的文字**永遠不會進 DOM**。
翻譯外掛是靠掃 DOM 找文字節點，所以它們不是壞掉，是本來就看不到 — 這條路不管換哪個外掛都走不通。

結論：只能自己抓 VTT、自己翻、自己疊一層 overlay。

---

## 二、目前做出來的東西

### 2-1. 使用者腳本（主要成果）

檔案：`aihero-zh-subs.user.js`（v3.6.0）
已安裝在 ego browser 的 Tampermonkey，script uuid：`ee0559d6-ef3d-42cb-bafe-c766f60a4c75`

metadata：

```javascript
// @name         AI Hero 繁體中文雙語字幕
// @version      3.6.0
// @match        https://www.aihero.dev/*
// @grant        GM_xmlhttpRequest / GM_setValue / GM_getValue / GM_deleteValue
// @connect      generativelanguage.googleapis.com
// @connect      api.anthropic.com
// @connect      mux.com
// @connect      stream.mux.com
// @run-at       document-idle
```

CONFIG（`Object.freeze`）重點：

```javascript
engine: 'gemini',                 // 或 'claude'
gemini: { model: 'gemini-2.5-flash',
          maxOutputTokens: 32768,   // 8192 會被截斷
          thinkingBudget: 0 },      // thinking 會吃掉輸出額度
claude: { model: 'claude-opus-5' },
batchSize: 30,                    // 一批太大，輸出會被截斷
maxRetriesPerBatch: 2,            // 重試深度上限，防無限遞迴
maxMergeSpan: 4,                  // 一組最多合併 4 格（設 2 會把模型分組全擋掉）
maxCharsPerLine: 32,              // 超過就在中文標點處切開
prefetchNextLesson: true,
sync: { enabled: true, timeoutMs: 8000 },   // 共享字幕伺服器
style: { zhFontSize: 26, enFontSize: 17, bottomPercent: 8,
         showEnglish: true, maxWidthPercent: 78 },
panelMode: 'auto',                // 'auto' | 'always' | 'off'
panelIdleCollapseSec: 4,
debug: false,
```

主要流程：

1. 從 Next.js 的 RSC payload 撈 `muxPlaybackId`
   （**注意：SSR 出來的 `<mux-player>` 標籤上沒有 `playback-id` 屬性**，要從 RSC payload 拿）
2. `fetchAllCues(playbackId)` → master m3u8 → 字幕 playlist → 抓全部 VTT 分段 → `parseVtt` → `dedupeCues`
3. `buildSegments(cues, playbackId)`：
   本機快取 → 問共享伺服器 → 都沒有才切批丟給 Gemini → 整集翻完自動上傳
4. `startRendering(video, segments, overlay)` → 100ms interval + `muteNativeCaptions()`
5. `prefetchNext()` 背景把下一集也翻好

關鍵函式：

| 函式 | 做什麼 |
|---|---|
| `fetchAllCues` | 抓完整 VTT，不靠播放器的 textTrack |
| `groupsToSegments` | 把模型回的 `{s,e,t}` 轉成 `{start,end,en,zh}`，擋掉重疊／超長分組，漏掉的補英文 |
| `findSegmentAt` | 二分搜尋當下該顯示哪一句 |
| `muteNativeCaptions` | 每次 render tick 把播放器內建字幕軌設成 `disabled` |
| `createOverlay(player, settings)` | **掛在 `player` 本身，不是 `player.parentElement`** |
| `translateSlice` | 翻一段字幕；沒翻到的區段自動切小重試，**只重送缺口**以省 API 額度 |
| `splitLongSegment` | 中文太長時在標點處切塊，時間按字數比例分（**切點不可含空白**，見踩坑區）|
| `getSyncConfig` / `writeSyncConfig` | 讀寫共享伺服器設定；沒設定就安靜回 `null`，不彈任何視窗 |
| `fetchRemoteSegments` / `uploadSegments` | 跟共享伺服器讀寫；**任何失敗都吞掉**，絕不拖垮翻譯 |
| `markAsDoNotTranslate` | 加 `translate="no"`、`notranslate`、`immersive-translate-ignore`，避免跟現有翻譯外掛打架 |

快取：`CACHE_VERSION = 'v5'`，key 是 `zhsub_cache_v5_{engine}_{playbackId}`，存合併後的 segment 陣列。

### 2-2. Cloudflare Worker 共享快取（已部署，腳本已接上並驗證）

目的：換電腦不用重翻，未來也能分享給別人。

- 位置：`worker/`
- 網址：`https://zhsub-cache.<你的子網域>.workers.dev`（實際網址不寫進版控，用 `wrangler deployments list` 查）
- 儲存：**KV**（namespace binding `SUBS`）

為什麼選 KV 不選 R2：一集才 20–30KB、讀多寫少、KV 有 edge 快取、不用搞 S3 API。
免費額度每天 1000 次寫入，這門課總共才 59 集，綽綽有餘。

模組（共 168 行）：

| 檔案 | 行數 | 內容 |
|---|---|---|
| `worker/src/http.js` | 16 | `json()` / `error()` / `preflight()`，含 CORS |
| `worker/src/auth.js` | 30 | `constantTimeEqual`、`bearerToken`、`canRead`、`canWrite` |
| `worker/src/subs.js` | 57 | 驗證 + 讀寫；`MAX_BODY_BYTES = 512KB`、`MAX_SEGMENTS = 5000` |
| `worker/src/index.js` | 65 | 路由 |

路由：

```
GET  /health
GET  /subs/{playbackId}
PUT  /subs/{playbackId}
OPTIONS （preflight）
```

Token：`READ_TOKEN`（`zr_` 開頭）、`WRITE_TOKEN`（`zw_` 開頭），
`openssl rand -hex 24` 產生，已上傳成 Worker secret。
**明文只在 `worker/tokens.local.txt`（chmod 600，已 gitignore）。從頭到尾沒有印在對話裡，也不要印。**

端點測試（連跑兩輪都正確）：

```
健康檢查 200 | 無 token 401 | 唯讀想寫入 401 | 壞資料 400 | 正常讀取 200
```

---

## 三、已修好的三個 bug（診斷紀錄，留著避免重蹈）

### 症狀

在 `https://www.aihero.dev/workshops/ai-coding-crash-course/setting-up-the-project-ce72490e`：

- 0 秒 ~ 約 150 秒：**畫面上只有英文，一句中文都沒有**
- 154 秒之後：正常，中英雙語都在

### 已確認的根本原因

**這是踩線 bug，不是隨機失敗，也不是這一集內容有問題。**

錯誤訊息長這樣：

```
第 1 批失敗：翻譯結果無法解析成 JSON：[ { "s": 0, "e": 0, "t": "現在我們要來設…
第 2 批失敗：翻譯結果無法解析成 JSON：[ { "s": 0, "e": 1, "t": "因為我的網路很…
```

JSON 開頭是合法的，是**被截斷**了 → `maxOutputTokens: 8192` 不夠用。

兩個原因疊在一起：

1. 舊設定一批 60 格，每格都要吐中文，中文很吃 token
2. `gemini-2.5-flash` 的 **thinking token 也算在同一個 `maxOutputTokens` 額度裡**

**為什麼只有這一集會爆？** 因為它是整門課最長的一集。實測各集的字幕規模：

| 集數 | 格數 | 秒數 | 總字元 | 每格字元 |
|---|---|---|---|---|
| setting-up-the-project（壞的這集） | **170** | 466 | 8048 | 47 |
| 其他 D | 139 | 337 | 5696 | 41 |
| 其他 B | 89 | 206 | 3727 | 42 |
| 其他 A | 86 | 218 | 3910 | 45 |
| 其他 C | 64 | 141 | 2550 | 40 |

每格密度大家都差不多（40–47 字元），內容沒有哪一集特別怪。差別純粹在**總量**：
這一集 170 格，比第二長的多兩成，比其他集多一倍以上。

其他集剛好壓在 8192 的線內過關，這一集一批的量多那兩成，正好翻過去被剪斷。
**所以使用者回報「其他影片都可以，只有這一集會出現 bug」是完全合理的，不是錯覺。**

修法給的餘裕：一批 30 格（量砍一半）＋ 上限 32768（放大四倍）＋ 關掉 thinking，
等於約 8 倍餘裕，這一集不會再踩到。

### 第三個 bug：合併上限把分組全擋掉（截斷修好後才浮現）

**這是前一次「修斷句太長」時修出來的副作用。**

當初為了壓字幕長度，把 `maxMergeSpan` 硬設成 2，而且**超過就整組丟掉**。
但模型實際回的分組根本不聽這個限制。實測第 1 批（30 格）的分組跨距分布：

```
1格×1   2格×3   3格×4   4格×3   5格×1     ← 12 組裡有 8 組是 3 格以上
```

結果 8 組被丟掉，只剩 4 組通過，**30 格只蓋到 7 格**，其餘 23 格沒有中文。
然後重試把同樣內容再送一次，模型再合 3～5 格，再被丟掉 —— 一直撞同一面牆。
端到端實測：6 個批次打了 **42 次 API**，只換到 69% 的覆蓋率。

當初丟掉的理由是怕字幕太長，但那是過度矯正：
**合併越多格，字幕在畫面上停留越久**，合併 4 格約停 11 秒，讀 40～50 字綽綽有餘。
丟掉整組換來的是三成影片沒有翻譯，這筆帳算不過來。

修法：

1. `maxMergeSpan` 2 → **4**（留 4 當防呆，擋的是模型把整批合成一大組那種極端狀況）
2. `SYSTEM_PROMPT` 同步改掉，原本寫「一組最多 2 格」「每組 30 字以內」，
   跟程式的 4 不一致會讓模型繼續往 2 靠又繼續超標。
   改成「最多 4 格」＋「1～2 格控制 30 字內，3～4 格控制 50 字內」。

**教訓：`groupsToSegments` 裡任何「整組丟掉」的規則都要很小心** ——
被丟掉的格子只會靜靜地變成純英文，畫面上看起來就像「沒翻到」，
不會有任何錯誤訊息，很難從症狀反推原因。

### 連帶的第二個 bug（同樣要修）

```javascript
if (failed === 0) writeCachedSegments(playbackId, segments)
```

只要有任何一批失敗，**整集的成果都不寫快取**。後果：

- 每次重開頁面，三批全部重跑
- Gemini 免費額度重複燒
- 同一個位置大機率再掛一次

### 建議修法

| # | 修什麼 | 說明 |
|---|---|---|
| 1 | `maxOutputTokens` 調高 | gemini-2.5-flash 上限是 65536，8192 太小 |
| 2 | 加 `thinkingConfig: { thinkingBudget: 0 }` | 不讓 thinking 吃掉輸出額度 |
| 3 | `batchSize` 60 → 30 | 保險，順便降低單批失敗的殺傷力 |
| 4 | `parseTranslationJson` 要能救截斷的 JSON | 逐個撈出截斷前**完整**的物件，不要整批丟掉 |
| 5 | 失敗的批次要 retry | retry 時把 slice 再切一半 |
| 6 | 部分成功也要寫快取 | 下次只重翻沒翻到的區段，不要整集重來 |

第 4、6 點對省 Gemini 額度特別有感。

---

## 四、發佈方式與現況

### 兩種版本，用途不同

| 版本 | 放在哪 | 給誰 | 特點 |
|---|---|---|---|
| **公開版** | GitHub repo `aihero-zh-subs` | 朋友、任何人 | 乾淨無憑證，裝完自己填設定；有 `@updateURL` 會自動更新 |
| **私人版** | secret gist（**網址不寫進版控**） | 老闆自己的電腦 | 同步網址與 token 已預填，裝完即用；**刻意拿掉 `@updateURL`** |

私人版一定要拿掉 `@updateURL`，否則會被公開版覆蓋，預填的設定就沒了。
**因此公開版每次更新後，私人版要重新產一次。**

產生私人版的做法：把 `getSyncConfig` 改成讀不到 GM 值時 fallback 到
`DEFAULT_SYNC_URL` / `DEFAULT_SYNC_TOKEN` 兩個常數，`@name` 加註「（私人版）」以免
Tampermonkey 跟公開版混淆，然後 `gh gist create`（預設就是 secret）。
產生的檔案放 `/tmp` 並在建立 gist 後立刻刪除，**絕對不要留在專案目錄**，避免誤 commit。

### 同步已驗證通過（兩個方向都獨立驗過）

**上傳**：翻完一集後，繞過腳本直接 `curl` 問 Worker，
確認該集 113 筆字幕確實存在、全部有中文、段落數與面板顯示一致。

**下載**：把 `CACHE_VERSION` 暫時改成 `v6test` 讓本機快取全部落空
（測完換回 `v5`，原有快取完好無損），重開頁面後狀態依序出現
`查詢共享字幕… → 字幕就緒（113/113 句，來自共享）`，**完全沒有重新翻譯**。

這個「暫時改快取版本號」的手法很好用：可以在不破壞既有快取的前提下，
模擬「一台全新電腦」的狀態。

**實機驗證（2026-08-21）**：老闆在第二台電腦上依 gist 網址安裝私人版，
開啟已上傳過的那一集，狀態顯示「來自共享」，未重新翻譯、未消耗 API 額度。
跨機同步至此為端到端可用。

安裝時最容易漏掉的一步是 Tampermonkey 的「允許使用者指令碼」開關
（新版瀏覽器預設關閉，未開啟時腳本完全不執行且**不報任何錯**），
開啟後必須完全重啟瀏覽器。

## 五、還沒做的事

1. **通用多播放器外掛** — 老闆選過這個方向，但後來說「現在不要先做太麻煩」，先擱著

2. **自動更新尚未實測成功** — `@updateURL` / `@downloadURL` 已加入公開版，
   但 Tampermonkey 的更新檢查是照自己的排程跑，在控制台、工具頁、腳本設定頁
   都找不到手動觸發的入口，所以**沒能當場證明它會生效**。
   留了一個天然探針：GitHub 上曾短暫是 3.4.2 而本機是 3.4.1。
   若確認被「本機修改」標記擋住，改用從 gist/URL 重裝一次即可
   （代價是 GM 儲存區歸零，API key 要重輸、本機快取重建 —— 但字幕本身在 Worker 上，
   所以其實不痛）。

3. 待老闆回報：斷句長度現在感覺如何、有沒有非台灣用詞、有沒有句子被切在奇怪的地方

---

## 六、踩過的坑（不要再踩一次）

### 字幕抓取

- **`primeTrack` 設 `track.mode = 'hidden'` 抓不到東西** — hls.js 要 `'showing'` 才會下載字幕分段，而且就算設了，暫停狀態下 86 格也只會載到 10 格。最後整個放棄播放器的 track，直接跟 Mux 要 VTT。
- **`X-TIMESTAMP-MAP` 不用補償** — 已驗證：原生 cue 是 0→3.553，VTT 是 0.000→3.560，對得上。

### 顯示

- **同時出現三行字幕** — mux-player 內建字幕還在畫。解法：每個 render tick 都跑 `muteNativeCaptions(video)`。
- **全螢幕字幕消失** — `document.fullscreenElement` 是 `mux-player`，但 overlay 掛在外層 `<section>`，不在被算繪的子樹裡。解法：overlay 改掛在 `player` 本身。順便修好了垂直位置飄移（section 比影片高）。

### 翻譯品質

- **斷句太長** — 量過分布：中位數 34 字、最長 61、27% 超過 40 字。提示詞寫「30 字以內」模型根本不理。解法：`maxMergeSpan` 硬壓到 2，超長的分組**整組退掉**（不能截斷，截斷會讓中文跟時間軸對不上）。改完：中位數 25、最長 59、只剩 5% 超過 40。字幕區塊也收窄到 78% 寬 + `text-wrap: balance`，長句折兩行而不是拉成一條。

### Prefetch

- **prefetch 靜靜地不動作**（查了兩輪）。第一個假設是 `@connect` 少了 `aihero.dev`，加了 `fetchSameOrigin`（原生 fetch + `credentials: 'include'`）還是不動。**真正原因：`run()` 執行的當下，「下一課」那個 `<a>` 還沒被算繪出來。** 解法：`await waitFor(findNextLessonUrl, { tries: 20, intervalMs: 1000 })`。

### 不要用 window.prompt 做設定介面

同步設定原本用 `window.prompt` 問網址和 token，三個問題：

1. **它會凍結整個頁面的 JavaScript。** 對自動化是致命的 ——
   `js()` 呼叫會直接 `Runtime.evaluate timed out`，因為頁面根本不動了。
   ego-browser 偵測到代理動不了，還會自動把控制權轉交給使用者
   （`ownership: agentDelegatedToUser`），錯誤訊息長得像「使用者接手了」，
   **很容易誤判成人類介入，其實是自己造成的**。
2. 看不到目前設定值，想改成別的伺服器只能重打。
3. 按錯一次取消就寫下 `syncDeclined`，同步永久停用（見下一節）。

實測用 CDP 的 `Page.handleJavaScriptDialog` 去回應這個 prompt，
試了四五種寫法（先 pageInfo 再回應、setTimeout 排程點擊、盲填）**全部失敗** ——
值從來沒被填進去，每次都變成「使用者取消」。

改法：面板裡放一個可展開的小表單（兩個 input + 儲存/清除），
`getSyncConfig` 簡化成「沒設定就安靜回 null」，`syncDeclined` 整個拿掉。

**通則：任何需要自動化驗證的設定流程，都不要用 `window.prompt` / `alert` / `confirm`。**

### 共享字幕設定：拒絕記號會變成永久壞掉

`getSyncConfig` 用 `settings.syncDeclined` 記住「使用者不想用同步」，
避免每次開影片都彈視窗騷擾。立意沒錯，但原始寫法有個致命問題：

**`window.prompt` 被關掉一次就寫死 `syncDeclined: true`，而且沒有任何回頭路。**

觸發方式比想像中容易：手滑按取消、瀏覽器自動關閉對話框（自動化環境很常見）。
一旦觸發，同步永久停用，面板上又沒有對應的重設按鈕（只有「重設 API key」）。

實測就踩到了：測試時視窗被自動關掉，儲存區直接寫入 `syncDeclined: true`，
之後怎麼按重新翻譯都不會再問，也不會上傳。

修法：`getSyncConfig` 加 `force` 參數無視 `syncDeclined`，
新增 `resetSyncConfig()`，面板加一顆「設定共享字幕」按鈕。

**通則：任何「記住使用者說不要」的旗標，都必須配一個看得見的重設入口。**
不然一次誤觸就是永久故障，而且使用者完全不知道發生什麼事。

### 安裝與更新（很容易踩雷）

- **從網址安裝會裝成第二份，不會覆蓋。** Tampermonkey 是靠來源辨識腳本：
  手動貼進編輯器建立的那支，跟從網址安裝的那支，即使 `@name` + `@namespace`
  完全一樣，也會被當成兩支不同的腳本，兩支同時執行 →
  抓兩次字幕、打兩次 API、疊兩層字幕，畫面會變慢。
- **要更新既有那支，只能貼進它自己的編輯器。** 路徑：
  控制台 → 點腳本名稱開編輯器 → `CodeMirror.setValue(新原始碼)` → 點該腳本專屬的儲存鈕。
- **每支腳本的 GM 儲存是各自獨立的。** API key 跟字幕快取都掛在腳本的 uuid 底下，
  刪掉哪一支就一起沒了。所以碰到重複時，要留的是**有資料的那支**（通常是舊的），
  把新程式碼貼進去，然後刪掉新裝的那支。
- 貼進去之後 Tampermonkey 會把它標記成「本機修改」，
  控制台上會出現警告圖示：「此腳本已於 … 在被本機修改。更新將會覆蓋您的修改！」

### ego browser 開不了擴充頁的繞法

`openOrReuseTab('chrome-extension://…')` 會卡死（`wait: false` 也一樣），
但**分頁其實開起來了** —— 卡的是等待握手，不是導航。

繞法：先讓它開（卡住就砍掉那個程序），之後用 `listTabs()` 找出那個分頁，
`switchTab(targetId)` 切過去，`js()` 就能正常操作了。

另外：`options.html#nav=<b64uuid>+editor` 這種網址片段**開不了編輯器**，
重新載入只會回到清單或設定頁。要開編輯器得從控制台**點腳本名稱**
（`document.getElementById('span_<b64uuid>_sname_name').click()`）。

`el.click()` 在這個頁面是有效的（控制台的名稱、刪除鈕都吃），
但畫面重繪有延遲，按完要等一下再去確認結果，不然會誤判成沒生效。

### 翻譯品質：字面直譯與缺乏脈絡

實際遇到的案例：`the stuff that's very, very sacred` 被翻成「這些都是非常神聖的」。

**這不是聽打錯誤，英文本身是對的** —— `sacred` 在英文裡是慣用講法，
形容「碰不得、不能亂動」，在資料庫遷移的脈絡下指「正式資料動不得」。
問題出在照字典硬翻，中文讀起來很怪。

診斷時要分清楚三種不同的錯誤，修法完全不同：

| 類型 | 例子 | 修法 |
|---|---|---|
| 聽打錯誤 | 專有名詞被聽成別的字 | 提示詞第 12 條（已有） |
| **字面直譯** | sacred → 神聖 | 提示詞加慣用語規則（第 13 條） |
| 缺乏脈絡 | 不知道這集在講什麼，用詞判斷失準 | 把課程標題帶進 user prompt |

後兩者的修法：

- `SYSTEM_PROMPT` 第 13 條要求「翻意思不要翻字面」，並舉具體例子
  （sacred、hairy、under the hood）讓模型抓到感覺
- `state.lessonTitle` 由 `readLessonTitle()` 在 `run()` 時設定一次，
  `buildUserPrompt` 會把「這一集的主題是：…」放在字幕前面

**注意**：`buildUserPrompt` 原本定義在 `const state` 之前，
直接引用 `state` 會踩 TDZ（`Cannot access 'state' before initialization`），
所以 `state` 的宣告必須移到前面。

不改五層函式簽名而用模組層級變數，是因為標題要從 `buildSegments` 一路傳到
`buildUserPrompt` 中間隔了四層，而一個頁面本來就只有一集，沒必要為此改簽名。

### 字幕切分

- **切點候選不可以包含空白字元。** 這支腳本刻意把技術名詞保留成英文，
  在空白處下刀等於專挑專有名詞砍。實測 `Windows Subsystem for Linux`
  被切成「…並透過 Windows」＋「Subsystem for Linux 取得…」，
  而且中間的空白還被 `.trim()` 吃掉，接回來就少一個字。
  只在中文標點 `。！？，、；：` 下刀就好。
- 代價是：某些片段沒有中文標點可切，只能留成一塊比較長的。
  這是刻意的取捨 —— 寧可一塊長一點，也不要把專有名詞砍成兩半。

### Tampermonkey / ego browser

- **腳本完全沒跑、`GM_info` 是 undefined，但 Read Frog 注入正常** — Tampermonkey 在 MV3 需要開該擴充套件的「允許使用者指令碼」開關。要走 shadow DOM 找 `#allow-user-scripts`；`el.click()` 沒用，要用算出來的座標下真實滑鼠點擊。**改完要重開瀏覽器才生效。**
- **腳本被裝了兩次** — 先前用本機 HTTP server 裝的那次其實默默成功了。刪掉 localhost 來源那個。
- **改到看不見的那個 CodeMirror** — 頁面上有兩個 `.CodeMirror`，殘留的 `new-user-script` 那個排在前面。解法：用 `getBoundingClientRect().width > 0` 過濾。
- **Cmd+S 存不了** — 把 setValue 跟 keypress 拆在不同 heredoc 會失焦，後來連同一個 heredoc 也不行。解法：**直接點存檔按鈕** — `[...document.querySelectorAll('button')].filter(b => b.getAttribute('title') === '儲存')`，再挑 id 含腳本 uuid base64 片段 `ZWUwNTU5ZDYt` 的那顆。
- **ego-browser 的 `help()` 是壞的** — 連 `click` 這種明明可用的都回 "Unknown helper"，不要信它。
- **ego-browser 跑的是 ESM** — `require()` 會炸，要用 `await import('node:fs')`。
- **ego-browser 沙箱讀不到 `/Users/fishtv/Documents/`**（macOS TCC EPERM）。解法：複製到 `/tmp`，或起 `python3 -m http.server 8777 --bind 127.0.0.1` 讓頁面自己 fetch。
- **`js()` 塞太長的 async script 會 `Runtime.evaluate timed out`** — 要拆成多次短呼叫，用 `window.__xxx` 當累加器接續。
- **heredoc 裡的 `\n` 會被吃掉** — `replace(/\n/g, ...)` 會變成 `Invalid regular expression`。用 `String.fromCharCode(10)` 繞過。

### Worker

- **第一輪測試出現 500 跟 jq 解析失敗** — 是暫時性的：cold start + KV 最終一致性。第二輪全對。
- **KV 是最終一致性**（全球傳播最多約 60 秒）。`wrangler kv key delete` 回報成功後馬上讀還是可能拿到 200。

---

## 七、除錯用的招式（很好用，留著）

要看整集字幕長什麼樣，不用真的播放 — 直接 seek 然後讀 overlay：

```javascript
// 分段跑，避免 Runtime.evaluate timeout
window.__v.currentTime = t
await new Promise(r => setTimeout(r, 110))
const txt = window.__ov.innerText.trim()
```

要抓面板閃過去的錯誤訊息，掛 MutationObserver 錄起來：

```javascript
const st = document.querySelector('#zhsub-panel [data-role="status"]')
window.__log = []
const push = () => { const t = st.innerText.trim()
  if (t && t !== window.__log[window.__log.length-1]) window.__log.push(t) }
push()
new MutationObserver(push).observe(st, {childList:true, subtree:true, characterData:true})
```

---

## 八、環境

- wrangler 4.124.0，OAuth 登入（帳號見本機 `wrangler whoami`），scope 含 `workers_kv (write)`
- R2 也可用（bucket `fishtv`），但這個專案沒用到
- 瀏覽器是 **ego browser**，不是 Chrome
- 相關 skill：`cloudflare-auth`、`ego-browser`

# AI Hero 繁體中文雙語字幕

一支 Tampermonkey 使用者腳本，把 [aihero.dev](https://www.aihero.dev/) 課程影片的英文字幕
即時翻成台灣繁體中文，在影片上疊成中英雙語字幕。

## 為什麼需要這個

那些影片用的是 Mux Player，字幕走 HLS，由播放器用原生 `TextTrack` + `::cue` 算繪。
**`::cue` 的文字永遠不會進 DOM**，所以沉浸式翻譯、陪讀蛙這類靠掃 DOM 的翻譯外掛
根本看不到字幕 —— 不是外掛壞掉，是這條路本來就走不通。

這支腳本改成直接跟 Mux 要完整的 VTT 字幕檔，自己翻譯、自己疊一層字幕。

## 需要什麼

- [Tampermonkey](https://www.tampermonkey.net/)
- 一把 Gemini API key（[免費額度](https://aistudio.google.com/apikey)就夠用）

## 安裝

點下面的網址，Tampermonkey 會跳出安裝頁：

```
https://raw.githubusercontent.com/OWNER/REPO/main/aihero-zh-subs.user.js
```

第一次在課程頁面上會跳視窗問你的 API key，貼進去就好。
key 存在 Tampermonkey 的儲存區，**不會寫進程式碼**，所以這支腳本可以安全分享。

## 它怎麼運作

1. 從 Next.js 的 RSC payload 撈出影片的 `muxPlaybackId`
2. 跟 Mux 要 HLS 的字幕清單，把整集的 VTT 分段全抓下來
3. 切批送給 Gemini，請它先讀懂語意、把「屬於同一句話」的字幕格合併再翻譯
4. 太長的中文在標點處切開，時間按字數比例分配
5. 疊一層自己的字幕，並關掉播放器內建的字幕軌

翻好的結果會存在本機快取，同一集不會重翻。看某一集的時候會在背景把下一集也先翻好。

## 設定

打開腳本，最上面的 `CONFIG` 區塊：

| 設定 | 預設 | 說明 |
|---|---|---|
| `engine` | `gemini` | 也可以改成 `claude` |
| `batchSize` | `30` | 一批送幾格去翻。太大容易讓輸出被截斷 |
| `maxMergeSpan` | `4` | 一組最多合併幾格字幕 |
| `maxCharsPerLine` | `32` | 一句字幕最多幾個中文字，超過就切開 |
| `prefetchNextLesson` | `true` | 背景預先翻譯下一集 |
| `panelMode` | `auto` | 控制面板：`auto` / `always` / `off` |
| `style.showEnglish` | `true` | 要不要同時顯示英文 |

## 跟其他翻譯外掛的相容性

腳本自己畫的字幕跟控制面板都標了 `translate="no"`、`notranslate`、
`immersive-translate-ignore`，所以不會跟現有的翻譯外掛打架。

## `worker/`

一個 Cloudflare Worker，用 KV 存翻譯結果，讓多台電腦共用同一份字幕快取。
目前腳本還沒接上去，屬於未完成的部分。

部署需要自己設定兩個 secret（`READ_TOKEN`、`WRITE_TOKEN`），
token 明文放在 `worker/tokens.local.txt`，該檔案已被 `.gitignore` 排除。

## 授權

MIT

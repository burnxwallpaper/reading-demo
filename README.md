# 《陰影帝國》閱讀存檔

- **作者**: 三腳架
- **來源**: https://czbooks.net/n/s6d619
- **說明**: 作者存檔（章節 900–1477，含終章）＋手機優先靜態閱讀器

本目錄收錄《陰影帝國》第 900 章至第 1477 章（終章），共 **572** 個章節 Markdown 檔案，置於 `chapters/`。

| 區間 | 章節數 |
|------|--------|
| 900–1000 | 101 |
| 1000–1100 | 101 |
| 1100–1477 | 372 |
| 合計（去重） | 572 |

檔名格式：`chapters/chapter-NNNN.md`。

## 靜態閱讀器（手機優先）

根目錄的 `index.html` 提供書庫／目錄／內文閱讀，樣式參考 czbooks 章節頁（深色背景、約 18px 正文、行高約 1.8）。

### 本機預覽

必須透過 HTTP 伺服器開啟（瀏覽器限制 `file://` 無法 `fetch` 章節）：

```bash
cd /path/to/reading-demo   # 或本 repo 根目錄
python3 -m http.server 8080
```

然後用手機或桌面瀏覽器開啟 `http://localhost:8080/`（區網可用 `http://<你的IP>:8080/`）。

### GitHub Pages

把此 repo 設為 Pages（來源選根目錄 `/`）即可線上閱讀。`books.json`、`manifest.json`、`chapters/` 需與 `index.html` 同 repo。

### 本地緩存

開啟任一章時，會用 **整包替換** 的方式把「當前章 ±10 章」（依目錄中實際存在的章節索引計算，缺章已略過）寫入 `localStorage`：

| 鍵 | 用途 |
|----|------|
| `reading-demo:chapterCache` | 當前緩存窗口（title + body），每次導航整鍵覆寫 |
| `reading-demo:lastRead:<bookId>` | 各書上次讀到的章號（與內容緩存分開） |

之後短時間離線或弱網時，窗口內章節可直接從緩存渲染。

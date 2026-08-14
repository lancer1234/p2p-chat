# P2P Chat

一個以 **Direct WebRTC P2P 優先**為核心的瀏覽器即時通訊實驗專案。

🌐 **線上版本：** https://lancer1234.github.io/p2p-chat/

> 本專案為 **非開源（Proprietary / All Rights Reserved）** 軟體。原始碼公開可見僅供專案部署、展示與檢視，不代表授予任何開源授權。詳見 [`LICENSE`](./LICENSE)。

## 功能特色

- WebRTC DataChannel 點對點即時文字通訊
- Direct P2P 優先，不會預設經過 TURN Relay
- Nostr Relay 僅用於加密 signaling / reconnect 協調
- QR Code 配對
- 本機 PIN 解鎖與身分資料加密保存
- 本機聊天紀錄保存
- 自動偵測 WebRTC / ICE 連線狀態
- 網路切換、斷線後自動嘗試重連
- Direct P2P 失敗時才顯示「使用加密 Relay」選項
- TURN Relay 必須由使用者主動允許，不會偷偷自動切換
- TURN credentials 由 Cloudflare Worker 向 Metered 動態取得
- TURN credentials 為 **4 小時短效憑證（14400 秒）**
- 每次重新開啟或恢復對話，都會重新從 **Direct P2P** 開始，不會永久記住曾使用 Relay

## 連線模式

### 1. Direct P2P（預設）

正常情況下，聊天資料直接在兩台裝置之間透過 WebRTC DataChannel 傳輸：

```text
Device A  <========== WebRTC Direct P2P ==========>  Device B

                     Chat Data
                     No TURN Relay
```

Nostr Relay 僅負責交換建立 / 恢復 WebRTC 連線所需的 signaling 資訊，不承載正常聊天內容。

連線成功時介面會顯示類似：

```text
DIRECT P2P · NO RELAY
```

### 2. Encrypted TURN Relay（手動備援）

部分公用 Wi‑Fi、飯店、公司、校園網路或嚴格 NAT / Firewall 環境可能無法建立 Direct P2P。

Direct P2P 失敗時，系統只會提示：

```text
DIRECT P2P BLOCKED · RELAY AVAILABLE
```

使用者必須主動選擇「使用加密 Relay 連線」後，才會使用 TURN：

```text
Device A
   |
   | WebRTC encrypted traffic
   v
Metered TURN Relay
   |
   | WebRTC encrypted traffic
   v
Device B
```

TURN Relay 會轉送 WebRTC 的加密封包，因此這種模式不是純 Direct P2P。介面會清楚標示 Relay 狀態。

## TURN 短效 Credentials

TURN credentials 不會寫死在前端，也不會儲存在 GitHub Pages。

流程：

```text
Browser
   |
   | Only when user enables Relay
   v
Cloudflare Worker
   |
   | METERED_SECRET_KEY (Server-side Secret)
   v
Metered TURN API
   |
   | Temporary credential: 14400 seconds
   v
Browser WebRTC
```

- Metered Secret Key 僅存放於 Cloudflare Worker Secret
- 前端無法讀取 Metered Secret Key
- 短效 TURN credential 有效時間為 4 小時
- 4 小時到期不會刪除聊天、身分或配對資料
- 下次恢復對話會先重新嘗試 Direct P2P
- Direct P2P 仍失敗時，使用者可再次主動取得新的短效 TURN credential

## 使用方式

### 第一次使用

1. 開啟 https://lancer1234.github.io/p2p-chat/
2. 設定至少 8 位的 PIN 密碼。
3. 等待 Nostr Relay Matrix 至少有一個 Relay 顯示連線成功。
4. 其中一台裝置選擇「產生邀請 QR Code」。
5. 另一台裝置選擇「掃描對方 QR Code」。
6. 掃描完成後，系統會建立 WebRTC 連線。
7. 若 Direct P2P 成功，即可直接聊天。

### Direct P2P 無法連線時

1. 等待系統完成 Direct P2P 嘗試。
2. 若顯示 Relay 可用，選擇「使用加密 Relay 連線」。
3. 閱讀提示並確認。
4. 系統才會向後端申請 4 小時短效 TURN credential。
5. 雙方重新建立 WebRTC Relay 連線。

### 恢復上一次對話

只要本機身分與聊天資料沒有被清除：

1. 重新開啟網站並輸入原本 PIN。
2. 選擇「恢復上一次的加密對話」。
3. 系統會讀取原本的對方公鑰與聊天紀錄。
4. 每次都會先重新嘗試 Direct P2P。
5. 過去曾使用 TURN 不會讓該對話永久變成 Relay 模式。
6. 如果 Direct P2P 仍然失敗，再由使用者決定是否啟用新的 Relay session。

## 隱私與資料模型

- 身分私鑰經 PIN 衍生金鑰加密後保存在瀏覽器本機。
- 聊天紀錄保存在瀏覽器本機儲存空間。
- 正常 Direct P2P 模式下，聊天內容不透過 TURN Relay。
- Nostr Relay 用於 signaling，不作為正常聊天資料伺服器。
- 使用 TURN 時，加密後的 WebRTC 網路封包會經過 TURN Relay。
- 清除瀏覽器網站資料、重設身分或使用「離開對話」可能造成本機聊天資料無法恢復。

## 網路相容性

Direct P2P 是否能成功，會受到下列因素影響：

- NAT 類型
- CGNAT
- Symmetric NAT
- UDP 是否被封鎖
- 公用 Wi‑Fi Client Isolation
- 公司 / 校園 Firewall
- VPN / Proxy
- ISP 網路政策

因此本專案採用：

```text
Direct P2P First
        |
        | Failed
        v
User chooses whether to enable encrypted TURN Relay
```

## 專案架構

```text
p2p-chat/
├── index.html
├── README.md
├── LICENSE
├── js/
│   ├── app.js
│   ├── config.js
│   ├── crypto.js
│   ├── nostr.js
│   ├── storage.js
│   └── webrtc.js
└── cloudflare-worker/
    ├── package.json
    ├── wrangler.jsonc
    └── src/
        └── index.js
```

## 使用技術

- WebRTC / RTCDataChannel
- SimplePeer
- Nostr
- nostr-tools
- Web Crypto API
- QR Code
- GitHub Pages
- Cloudflare Workers
- Metered TURN

## 注意事項

此專案仍屬實驗性質。WebRTC、瀏覽器背景執行限制、NAT、網路政策與第三方 Relay 服務狀態，都可能影響連線能力。

請勿將 Metered Secret Key、Cloudflare Secret 或其他後端憑證提交到 GitHub repository 或前端 JavaScript。

## License

**Proprietary — All Rights Reserved. 非開源軟體。**

Copyright © 2026 lancer1234. All rights reserved.

未經著作權人事前書面許可，不得複製、修改、散布、再授權、出售、重新部署、提供衍生作品或將本軟體全部或部分用於其他專案。

公開存放於 GitHub 不構成任何形式的開源授權、免費授權或默示授權。

完整條款請參閱 [`LICENSE`](./LICENSE)。

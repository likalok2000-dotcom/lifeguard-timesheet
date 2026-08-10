/**
 * 雲端 API 位址
 * - 本機 / 同源部署：用空字串（走 /api）
 * - GitHub Pages 會自動試同源，否則用下面 production 位址
 */
(function () {
  "use strict";
  // 全棧雲端 API（帳號資料庫）。GitHub Pages 前端會打呢度。
  // 若你用 Render / Railway 部署 server，改成嗰個網址。
  var PRODUCTION_API = "https://fresh-reflected-apollo-updates.trycloudflare.com";

  var host = location.hostname;
  var isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "" ||
    host.endsWith(".local");

  // 自訂覆寫（開發用）
  var override = "";
  try {
    override = localStorage.getItem("lifeguard-api-base") || "";
  } catch (e) {}

  if (override) {
    window.LIFEGUARD_API = override.replace(/\/$/, "");
  } else if (isLocal) {
    window.LIFEGUARD_API = "";
  } else if (PRODUCTION_API) {
    window.LIFEGUARD_API = PRODUCTION_API.replace(/\/$/, "");
  } else {
    // 同頁面伺服器有 /api（例如 cloudflared / render 全棧）
    window.LIFEGUARD_API = "";
  }
})();

/**
 * 雲端 API 位址
 * - Cloudflare Pages 同源：空字串
 * - GitHub Pages：連長駐 Cloudflare
 */
(function () {
  "use strict";
  // 24 小時長駐（Cloudflare Pages 正式帳號）
  var PRODUCTION_API = "https://lifeguard-timesheet.pages.dev";

  var host = location.hostname;
  var isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "" ||
    host.endsWith(".local");
  var isCloudflareHost =
    host.indexOf("workers.dev") !== -1 ||
    host.indexOf("pages.dev") !== -1 ||
    host.indexOf("trycloudflare.com") !== -1;

  var override = "";
  try {
    override = localStorage.getItem("lifeguard-api-base") || "";
  } catch (e) {}

  if (override) {
    window.LIFEGUARD_API = override.replace(/\/$/, "");
  } else if (isLocal || isCloudflareHost) {
    window.LIFEGUARD_API = "";
  } else if (PRODUCTION_API) {
    window.LIFEGUARD_API = PRODUCTION_API.replace(/\/$/, "");
  } else {
    window.LIFEGUARD_API = "";
  }
})();

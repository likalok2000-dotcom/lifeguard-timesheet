/**
 * 雲端 API 位址
 * - Cloudflare Workers 同源：空字串
 * - GitHub Pages：連長駐 Workers
 */
(function () {
  "use strict";
  // 24 小時長駐雲端（Cloudflare Workers）
  var PRODUCTION_API = "https://lifeguard-timesheet.breezy-dolomite.workers.dev";

  var host = location.hostname;
  var isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "" ||
    host.endsWith(".local");
  var isWorkers =
    host.indexOf("workers.dev") !== -1 ||
    host.indexOf("trycloudflare.com") !== -1;

  var override = "";
  try {
    override = localStorage.getItem("lifeguard-api-base") || "";
  } catch (e) {}

  if (override) {
    window.LIFEGUARD_API = override.replace(/\/$/, "");
  } else if (isLocal || isWorkers) {
    // 本機 server 或 Workers 同源
    window.LIFEGUARD_API = "";
  } else if (PRODUCTION_API) {
    window.LIFEGUARD_API = PRODUCTION_API.replace(/\/$/, "");
  } else {
    window.LIFEGUARD_API = "";
  }
})();

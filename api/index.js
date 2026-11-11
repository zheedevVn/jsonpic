const fs = require("fs");
const path = require("path");
const { getClientIP, checkWAF } = require("../lib/security.js");

module.exports = async function handler(req, res) {
  // 1. Kiểm tra WAF (Anti-SQLi, Anti-Dump, Anti-Map/Scanner)
  const waf = checkWAF(req);
  if (waf.blocked) {
    res.statusCode = waf.code || 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(
      JSON.stringify(
        {
          status: "blocked",
          code: waf.code || 403,
          alert: "WAF_DEFENSE_TRIGGERED",
          message: waf.reason,
          ip: waf.ip
        },
        null,
        2
      )
    );
  }

  const clientIp = getClientIP(req);
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const route = url.searchParams.get("route");

  // ROUTE 1: /client/admin -> Hiển thị Giao diện Admin Panel
  if (pathname === "/client/admin" || route === "admin") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

    const htmlPath = path.join(__dirname, "../public/admin.html");
    if (fs.existsSync(htmlPath)) {
      return res.end(fs.readFileSync(htmlPath, "utf8"));
    } else {
      return res.end("<h1>Admin Panel is loading...</h1>");
    }
  }

  // ROUTE 2: Root (/) -> Luôn luôn hiển thị JSON thuần theo yêu cầu
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

  return res.end(
    JSON.stringify(
      {
        status: "online",
        service: "JSONPic Manga CDN Storage Engine",
        version: "2.0.0-PRO",
        author: "Security Server",
        timestamp: Date.now(),
        client: {
          ip: clientIp,
          status: "connected"
        },
        protection: {
          hotlink_defense: "403 Forbidden Enforced for Unauthorized Referrers",
          waf: "Active (Anti-Dump, Anti-SQLi, Anti-Map/Scanner, Rate-Limit)",
          access_control: "Designated Hosting & Whitelisted IPs only"
        },
        system: {
          cluster: "Vercel Edge / Serverless",
          storage_backend: "Netlify Global CDN"
        },
        notice: "JSONPic CDN Storage is operational. Direct hotlinking without credentials will result in HTTP 403 Forbidden."
      },
      null,
      2
    )
  );
};

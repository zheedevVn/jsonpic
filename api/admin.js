const {
  getClientIP,
  checkWAF,
  checkLoginRateLimit,
  recordFailedLogin,
  clearFailedLogin,
  generateAdminToken,
  verifyAdminToken
} = require("../lib/security.js");
const {
  listNetlifySites,
  createNetlifySite,
  deployMangaToNetlify
} = require("../lib/netlify.js");
const { getSettings, saveSettings } = require("../lib/db.js");

function parseBody(req) {
  return new Promise(resolve => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.end(JSON.stringify(data, null, 2));
}

module.exports = async function handler(req, res) {
  // 1. Chạy tầng phòng thủ WAF (Anti-SQLi, Anti-Dump, Anti-Map/Scanner)
  const waf = checkWAF(req);
  if (waf.blocked) {
    return sendJson(res, waf.code || 403, {
      status: "error",
      code: waf.code || 403,
      alert: "WAF_PROTECTION_BLOCKED",
      message: waf.reason,
      ip: waf.ip
    });
  }

  const clientIp = getClientIP(req);
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const action = url.pathname.replace(/^\/api\/admin\/?/, "");

  // ROUTE 1: Đăng nhập Admin (/api/admin/login)
  if (action === "login") {
    if (req.method !== "POST") {
      return sendJson(res, 405, { status: "error", message: "Method Not Allowed" });
    }

    const rateCheck = checkLoginRateLimit(clientIp);
    if (rateCheck.locked) {
      return sendJson(res, 429, { status: "error", message: rateCheck.message });
    }

    const body = await parseBody(req);
    const { username, password } = body;

    // Kiểm tra thông tin đăng nhập: hoducminh | minhhocgioi
    if (username === "hoducminh" && password === "minhhocgioi") {
      clearFailedLogin(clientIp);
      const token = generateAdminToken(username);

      return sendJson(res, 200, {
        status: "success",
        message: "Xác thực Admin thành công!",
        token,
        user: { username: "hoducminh", role: "Super Admin" },
        clientIp
      });
    } else {
      recordFailedLogin(clientIp);
      return sendJson(res, 401, {
        status: "error",
        message: "Tên đăng nhập hoặc mật khẩu không chính xác!"
      });
    }
  }

  // CÁC ROUTE TIẾP THEO YÊU CẦU TOKEN ADMIN
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const auth = verifyAdminToken(token);

  if (!auth) {
    return sendJson(res, 401, {
      status: "error",
      message: "Yêu cầu đăng nhập. Token không hợp lệ hoặc đã hết hạn!"
    });
  }

  // ROUTE 2: Lấy thông tin phiên & IP hiện tại (/api/admin/info)
  if (action === "info") {
    const settings = getSettings();
    return sendJson(res, 200, {
      status: "success",
      user: auth.user,
      clientIp,
      settings
    });
  }

  // ROUTE 3: Danh sách các Site Netlify (/api/admin/sites)
  if (action === "sites") {
    try {
      const sites = await listNetlifySites();
      return sendJson(res, 200, { status: "success", count: sites.length, sites });
    } catch (err) {
      return sendJson(res, 500, { status: "error", message: err.message });
    }
  }

  // ROUTE 4: Tạo site Netlify mới (/api/admin/create-site)
  if (action === "create-site") {
    if (req.method !== "POST") return sendJson(res, 405, { status: "error", message: "Method Not Allowed" });
    const body = await parseBody(req);
    try {
      const site = await createNetlifySite(body.name);
      return sendJson(res, 200, { status: "success", site });
    } catch (err) {
      return sendJson(res, 500, { status: "error", message: err.message });
    }
  }

  // ROUTE 5: Quản lý Whitelist IP (/api/admin/ip-whitelist)
  if (action === "ip-whitelist") {
    const settings = getSettings();

    if (req.method === "POST") {
      const body = await parseBody(req);
      const { ip, op } = body; // op: "add" | "remove"

      if (ip && typeof ip === "string") {
        const cleanIp = ip.trim();
        if (op === "remove") {
          settings.allowedIps = (settings.allowedIps || []).filter(item => item !== cleanIp);
        } else {
          if (!settings.allowedIps) settings.allowedIps = [];
          if (!settings.allowedIps.includes(cleanIp)) {
            settings.allowedIps.push(cleanIp);
          }
        }
        saveSettings(settings);
      }

      return sendJson(res, 200, {
        status: "success",
        clientIp,
        allowedIps: settings.allowedIps
      });
    }

    return sendJson(res, 200, {
      status: "success",
      clientIp,
      allowedIps: settings.allowedIps || []
    });
  }

  // ROUTE 6: Upload và Deploy Manga lên Netlify (/api/admin/upload)
  if (action === "upload") {
    if (req.method !== "POST") return sendJson(res, 405, { status: "error", message: "Method Not Allowed" });

    const body = await parseBody(req);
    const { siteId, siteUrl, mangaName, chapter, files, allowedDomains, customIps } = body;

    if (!siteId || !files || !Array.isArray(files) || files.length === 0) {
      return sendJson(res, 400, { status: "error", message: "Thiếu siteId hoặc danh sách file ảnh!" });
    }

    const settings = getSettings();
    // Tổng hợp Whitelist IP: bao gồm IP hiện tại của Admin, các IP đã lưu và custom IP
    const allAllowedIps = Array.from(
      new Set([
        clientIp,
        ...(settings.allowedIps || []),
        ...(Array.isArray(customIps) ? customIps : (customIps || "").split(","))
      ])
    ).filter(Boolean);

    // Tổng hợp Whitelist Domain
    const allAllowedDomains = Array.from(
      new Set([
        ...(settings.allowedDomains || []),
        ...(Array.isArray(allowedDomains) ? allowedDomains : (allowedDomains || "").split(","))
      ])
    ).filter(Boolean);

    try {
      // Chuẩn bị đường dẫn file theo chuẩn: http://cdnjsonhentai.netlify.app/upload/{tên truyện}/từng ảnh 1
      const defaultHost = "http://cdnjsonhentai.netlify.app";
      let hostUrl = (siteUrl || defaultHost).replace(/\/$/, "");
      if (hostUrl.includes("cdnjsonhentai.netlify.app")) {
        hostUrl = "http://cdnjsonhentai.netlify.app";
      }

      const formattedFiles = files.map(file => {
        let rawPath = (file.relativePath || file.name).replace(/^\/+/, "");
        rawPath = rawPath.replace(/^upload\//, "");

        let targetPath = "";
        if (mangaName) {
          const cleanManga = mangaName.trim();
          const cleanChap = chapter ? chapter.trim() : "";
          const folderPrefix = cleanChap ? `${cleanManga}/${cleanChap}` : cleanManga;
          const fileNameOnly = rawPath.split("/").pop();
          targetPath = `upload/${folderPrefix}/${fileNameOnly}`;
        } else if (rawPath.includes("/")) {
          targetPath = `upload/${rawPath}`;
        } else {
          throw new Error("Lỗi bảo vệ dữ liệu: Bắt buộc phải có Tên Bộ Truyện để lưu ảnh đúng cấu trúc: http://cdnjsonhentai.netlify.app/upload/{tên truyện}/từng ảnh 1. Tuyệt đối không dồn ảnh vào gốc!");
        }

        return {
          name: targetPath,
          data: Buffer.from(file.base64, "base64")
        };
      });

      const deployResult = await deployMangaToNetlify({
        siteId: siteId || "9cfd6ecc-b354-4abd-9c00-9c0659b25ed4",
        files: formattedFiles,
        allowedDomains: allAllowedDomains,
        allowedIps: allAllowedIps
      });

      const imageUrls = formattedFiles.map(f => `${hostUrl}/${f.name}`);

      // Lưu lại lịch sử gần đây
      if (!settings.recentUploads) settings.recentUploads = [];
      settings.recentUploads.unshift({
        siteId,
        mangaName: mangaName || "Untitled",
        chapter: chapter || "1",
        count: formattedFiles.length,
        time: new Date().toISOString(),
        urls: imageUrls
      });
      if (settings.recentUploads.length > 20) settings.recentUploads.pop();
      saveSettings(settings);

      return sendJson(res, 200, {
        status: "success",
        deployId: deployResult.id,
        state: deployResult.state,
        totalImages: imageUrls.length,
        allowedIps: allAllowedIps,
        allowedDomains: allAllowedDomains,
        imageUrls
      });
    } catch (err) {
      return sendJson(res, 500, { status: "error", message: err.message });
    }
  }

  return sendJson(res, 404, { status: "error", message: "API route not found" });
};

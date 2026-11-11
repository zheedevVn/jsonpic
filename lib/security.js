const crypto = require("crypto");

const SECRET_KEY = process.env.SECURITY_SECRET || "zheedev-jsonpic-secure-key-2026-minhhocgioi";

// Danh sách chữ ký Scanner & Hacking Tools phổ biến (Anti-Map, Anti-Scanner)
const SUSPICIOUS_USER_AGENTS = [
  /sqlmap/i,
  /nmap/i,
  /nikto/i,
  /acunetix/i,
  /dirbuster/i,
  /gobuster/i,
  /wfuzz/i,
  /wpscan/i,
  /burpcollaborator/i,
  /masscan/i,
  /zgrab/i,
  /havij/i,
  /netsparker/i,
  /appscan/i
];

// Danh sách mẫu SQL Injection (Anti-SQLi)
const SQLI_PATTERNS = [
  /(\b(select|union|insert|update|delete|drop|alter|create|truncate)\b\s+.*\b(from|into|table|database)\b)/i,
  /(\bunion\b\s+.*\bselect\b)/i,
  /(\b(or|and)\b\s+['"]?\d+['"]?\s*=\s*['"]?\d+)/i,
  /(\b(or|and)\b\s+['"][^'"]+['"]\s*=\s*['"][^'"]+)/i,
  /(sleep\(\s*\d+\s*\))/i,
  /(benchmark\(\s*\d+\s*,.*\))/i,
  /(\bwaitfor\b\s+\bdelay\b)/i,
  /(information_schema|sys\.tables|sqlite_master|pg_catalog)/i,
  /('|"|`)\s*(--|\/\*)/i,
  /(;\s*--)/
];

// Danh sách mẫu Dump / Path Traversal (Anti-Dump)
const DUMP_PATTERNS = [
  /(\.\.\/|\.\.\\)/,
  /(\/etc\/passwd|\/etc\/shadow|\/proc\/self)/i,
  /(\b(mysqldump|pg_dump|sqlite3_dump)\b)/i,
  /(\.git\/|\.env|\.htaccess|\.aws\/)/i,
  /(load_file\(|into\s+outfile|into\s+dumpfile)/i
];

// Bộ nhớ đệm Rate Limit & Brute-force trong RAM
const failedLoginAttempts = new Map(); // ip -> { count, lockedUntil }
const requestRateLimit = new Map(); // ip -> { count, resetAt }

function getClientIP(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.headers["x-real-ip"] || req.socket?.remoteAddress || "127.0.0.1";
}

function checkWAF(req) {
  const ip = getClientIP(req);
  const userAgent = req.headers["user-agent"] || "";
  const url = req.url || "";

  // 1. Kiểm tra Anti-Map / Scanner User-Agent
  for (const regex of SUSPICIOUS_USER_AGENTS) {
    if (regex.test(userAgent)) {
      return {
        blocked: true,
        reason: `Anti-Map WAF Alert: Blocked scanner / automated tool (${userAgent})`,
        code: 403
      };
    }
  }

  // Thu thập nội dung cần quét: URL, Query, Form/JSON Body và Forwarded URI (nơi payload tấn công xuất hiện)
  // Không quét Accept header (*/*) để tránh chặn nhầm trình duyệt bình thường
  const scanTargets = [url];
  if (req.headers["x-forwarded-uri"]) scanTargets.push(req.headers["x-forwarded-uri"]);
  if (req.headers["referer"]) scanTargets.push(req.headers["referer"]);
  if (req.query) scanTargets.push(JSON.stringify(req.query));
  if (req.body) scanTargets.push(typeof req.body === "string" ? req.body : JSON.stringify(req.body));

  let combinedPayload = "";
  try {
    combinedPayload = decodeURIComponent(scanTargets.join(" "));
  } catch (e) {
    combinedPayload = scanTargets.join(" ");
  }

  // 2. Kiểm tra Anti-SQL Injection
  for (const pattern of SQLI_PATTERNS) {
    if (pattern.test(combinedPayload)) {
      return {
        blocked: true,
        reason: "Anti-SQL Injection Alert: Malicious SQL syntax detected",
        code: 400
      };
    }
  }

  // 3. Kiểm tra Anti-Dump / Traversal
  for (const pattern of DUMP_PATTERNS) {
    if (pattern.test(combinedPayload)) {
      return {
        blocked: true,
        reason: "Anti-Dump Alert: Unauthorized database or system inspection attempt",
        code: 403
      };
    }
  }

  // 4. Rate Limiting cơ bản (120 reqs / phút / IP)
  const now = Date.now();
  const rateData = requestRateLimit.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > rateData.resetAt) {
    rateData.count = 1;
    rateData.resetAt = now + 60000;
  } else {
    rateData.count++;
  }
  requestRateLimit.set(ip, rateData);

  if (rateData.count > 120) {
    return {
      blocked: true,
      reason: "Rate Limit Exceeded: Too many requests, please slow down.",
      code: 429
    };
  }

  return { blocked: false, ip };
}

// Kiểm tra khóa Brute-force đăng nhập
function checkLoginRateLimit(ip) {
  const now = Date.now();
  const attempt = failedLoginAttempts.get(ip);
  if (attempt && attempt.lockedUntil && now < attempt.lockedUntil) {
    const remainingSeconds = Math.ceil((attempt.lockedUntil - now) / 1000);
    return {
      locked: true,
      message: `Tài khoản tạm khóa do nhập sai nhiều lần. Vui lòng thử lại sau ${remainingSeconds} giây.`
    };
  }
  return { locked: false };
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const attempt = failedLoginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  attempt.count++;
  if (attempt.count >= 5) {
    attempt.lockedUntil = now + 15 * 60 * 1000; // Khóa 15 phút
    attempt.count = 0;
  }
  failedLoginAttempts.set(ip, attempt);
}

function clearFailedLogin(ip) {
  failedLoginAttempts.delete(ip);
}

// Tạo Token xác thực Admin (HMAC-SHA256)
function generateAdminToken(username) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      user: username,
      role: "SUPER_ADMIN",
      exp: Date.now() + 24 * 60 * 60 * 1000 // 24 giờ
    })
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", SECRET_KEY)
    .update(`${header}.${payload}`)
    .digest("base64url");

  return `${header}.${payload}.${signature}`;
}

// Xác thực Token Admin
function verifyAdminToken(token) {
  if (!token) return false;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const [header, payload, signature] = parts;

    const expectedSig = crypto
      .createHmac("sha256", SECRET_KEY)
      .update(`${header}.${payload}`)
      .digest("base64url");

    if (signature !== expectedSig) return false;

    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data.exp && Date.now() > data.exp) return false;

    return data;
  } catch (err) {
    return false;
  }
}

module.exports = {
  getClientIP,
  checkWAF,
  checkLoginRateLimit,
  recordFailedLogin,
  clearFailedLogin,
  generateAdminToken,
  verifyAdminToken
};

const { createZipBuffer } = require("./zip.js");

const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN || "nfp_BkhSuHWnWc3JynUgXCV139remW2ssJY67fd4";
const NETLIFY_API_BASE = "https://api.netlify.com/api/v1";

const defaultHeaders = {
  Authorization: `Bearer ${NETLIFY_TOKEN}`,
  "User-Agent": "JSONPic-Core/2.0"
};

// 1. Lấy danh sách sites
async function listNetlifySites() {
  const res = await fetch(`${NETLIFY_API_BASE}/sites?per_page=100`, { headers: defaultHeaders });
  if (!res.ok) throw new Error(`Netlify API Error: ${res.status} ${await res.text()}`);
  const sites = await res.json();
  return sites.map(s => ({
    id: s.id,
    name: s.name,
    url: s.ssl_url || s.url,
    updated_at: s.updated_at
  }));
}

// 2. Tạo site mới
async function createNetlifySite(name) {
  const body = name ? JSON.stringify({ name }) : JSON.stringify({});
  const res = await fetch(`${NETLIFY_API_BASE}/sites`, {
    method: "POST",
    headers: { ...defaultHeaders, "Content-Type": "application/json" },
    body
  });
  if (!res.ok) throw new Error(`Lỗi tạo site Netlify: ${res.status} ${await res.text()}`);
  return await res.json();
}

// 3. Tạo Edge Function chặn 403 Hotlinking, cho phép Domain & IP Whitelist
function generateEdgeFunctionCode(allowedDomains = [], allowedIps = []) {
  const domainsJson = JSON.stringify(
    allowedDomains.map(d => d.trim().toLowerCase()).filter(Boolean)
  );
  const ipsJson = JSON.stringify(
    allowedIps.map(ip => ip.trim()).filter(Boolean)
  );

  return `export default async (request, context) => {
  const url = new URL(request.url);

  // Trang chủ CDN
  if (url.pathname === "/" || url.pathname === "/favicon.ico") {
    return new Response(JSON.stringify({
      service: "JSONPic Manga CDN Storage",
      security: "403 Hotlink Protection Active",
      status: "ready"
    }), {
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  // 1. Lấy thông tin Client IP và Referer
  const clientIP = context.ip || request.headers.get("x-nf-client-connection-ip") || request.headers.get("x-forwarded-for") || "";
  const referer = request.headers.get("referer") || "";

  const allowedIps = ${ipsJson};
  const allowedDomains = ${domainsJson};

  // Ưu tiên 1: Nếu IP nằm trong Whitelist của Admin -> Cho phép check ảnh trực tiếp (KHÔNG bị 403)!
  const isIpAllowed = allowedIps.some(ip => ip && clientIP.includes(ip));
  if (isIpAllowed) {
    return context.next();
  }

  // Ưu tiên 2: Nếu Request xuất phát từ Website/Hosting truyện chỉ định -> Cho phép hiển thị!
  const isRefererAllowed = allowedDomains.some(domain => domain && referer.toLowerCase().includes(domain));
  if (isRefererAllowed) {
    return context.next();
  }

  // Toàn bộ truy cập khác (bấm link trực tiếp, web lạ nhúng trộm) -> Trả về 403 Forbidden
  return new Response(
    JSON.stringify({
      status: 403,
      error: "Forbidden",
      message: "Truy cap bi chan (403 Forbidden). Chi co website truyen chi dinh hoac IP admin duoc cap quyen moi duoc xem anh nay!",
      client_ip: clientIP
    }),
    {
      status: 403,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*"
      }
    }
  );
};
`;
}

// 4. Deploy mảng các file ảnh lên site Netlify
async function deployMangaToNetlify({ siteId, files, allowedDomains = [], allowedIps = [] }) {
  const netlifyToml = `[[edge_functions]]
  path = "/*"
  function = "protect"
`;
  const edgeFunctionCode = generateEdgeFunctionCode(allowedDomains, allowedIps);

  const zipFiles = [];

  // Thêm các file ảnh
  for (const f of files) {
    // f.name: "chap1/01.jpg", f.data: Buffer
    zipFiles.push({
      name: f.name,
      data: Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "base64")
    });
  }

  // Thêm file cấu hình bảo mật
  zipFiles.push({
    name: "netlify.toml",
    data: Buffer.from(netlifyToml, "utf8")
  });
  zipFiles.push({
    name: "netlify/edge-functions/protect.js",
    data: Buffer.from(edgeFunctionCode, "utf8")
  });

  const zipBuffer = createZipBuffer(zipFiles);

  const res = await fetch(`${NETLIFY_API_BASE}/sites/${siteId}/deploys`, {
    method: "POST",
    headers: {
      ...defaultHeaders,
      "Content-Type": "application/zip"
    },
    body: zipBuffer
  });

  if (!res.ok) {
    throw new Error(`Netlify Deploy Failed (${res.status}): ${await res.text()}`);
  }

  return await res.json();
}

module.exports = {
  listNetlifySites,
  createNetlifySite,
  deployMangaToNetlify,
  generateEdgeFunctionCode
};

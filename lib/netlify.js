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

// 2. Tạo site mới (có tự động retry tên duy nhất nếu bị trùng)
async function createNetlifySite(name) {
  let cleanName = name ? name.toLowerCase().replace(/[^a-z0-9\-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 32) : "";
  const body = cleanName ? JSON.stringify({ name: cleanName }) : JSON.stringify({});
  const res = await fetch(`${NETLIFY_API_BASE}/sites`, {
    method: "POST",
    headers: { ...defaultHeaders, "Content-Type": "application/json" },
    body
  });
  if (res.ok) return await res.json();

  // Nếu tên đã tồn tại (422), thử tạo với hậu tố ngẫu nhiên
  const randomSuffix = Math.random().toString(36).substring(2, 6);
  const fallbackName = cleanName ? `${cleanName.slice(0, 26)}-${randomSuffix}` : "";
  const fallbackRes = await fetch(`${NETLIFY_API_BASE}/sites`, {
    method: "POST",
    headers: { ...defaultHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ name: fallbackName })
  });

  if (fallbackRes.ok) return await fallbackRes.json();
  throw new Error(`Lỗi tạo site Netlify: ${res.status}`);
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

function sha1(buf) {
  const crypto = require("crypto");
  return crypto.createHash("sha1").update(buf).digest("hex");
}

function sha256(buf) {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// Tạo mã Serverless Function chặn 403 Hotlinking (Chặn VPN, IP ngoài, chỉ mở cho IP Admin và Web truyện)
function generateProtectFunctionCode(allowedDomains = [], allowedIps = []) {
  const domainsJson = JSON.stringify(
    Array.from(new Set([
      "jsonpic.vercel.app",
      "cdnjsonhentai.netlify.app",
      "localhost",
      ...allowedDomains.map(d => d.trim().toLowerCase()).filter(Boolean)
    ]))
  );
  const ipsJson = JSON.stringify(
    Array.from(new Set([
      "14.167.46.120",
      ...allowedIps.map(ip => ip.trim()).filter(Boolean)
    ]))
  );

  return `exports.handler = async (event, context) => {
  const rawPath = event.path || "";
  const host = "https://" + (event.headers["host"] || "cdnjsonhentai.netlify.app");

  // 1. Luôn cho phép các file JSON danh mục (catalog.json, index.json, story.json) truy cập công khai
  if (rawPath.endsWith(".json") || rawPath.endsWith("/index.json") || rawPath === "/upload" || rawPath === "/upload/") {
    const secretPath = rawPath.startsWith("/upload/") ? rawPath.replace(/^\\/upload\\//, "/_vault_9f8a7b/") : rawPath;
    const res = await fetch(host + secretPath);
    if (!res.ok) return { statusCode: res.status, body: "Not Found" };
    const text = await res.text();
    return {
      statusCode: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*"
      },
      body: text
    };
  }

  // 2. Lấy Client IP và Referer
  const clientIP = event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"] || event.headers["x-forwarded-for"] || "";
  const referer = event.headers["referer"] || "";

  const allowedIps = ${ipsJson};
  const allowedDomains = ${domainsJson};

  // Ưu tiên 1: IP Admin được Whitelist -> Cho phép check ảnh trực tiếp (không bị 403)
  const isIpAllowed = allowedIps.some(ip => ip && clientIP.includes(ip));
  if (isIpAllowed) {
    return serveVaultFile(rawPath, host);
  }

  // Ưu tiên 2: Truy cập từ Web truyện chỉ định (Referer) -> Cho phép load ảnh
  const isRefererAllowed = allowedDomains.some(domain => domain && referer.toLowerCase().includes(domain));
  if (isRefererAllowed) {
    return serveVaultFile(rawPath, host);
  }

  // Mọi truy cập khác (bật VPN IP lạ, bấm link trực tiếp, web lạ nhúng trộm) -> 403 Forbidden!
  return {
    statusCode: 403,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*"
    },
    body: JSON.stringify({
      status: 403,
      error: "Forbidden",
      message: "Truy cap bi chan (403 Forbidden). Chi co website truyen chi dinh hoac IP admin duoc cap quyen moi duoc xem anh!",
      client_ip: clientIP
    })
  };
};

async function serveVaultFile(rawPath, host) {
  const secretPath = rawPath.replace(/^\\/upload\\//, "/_vault_9f8a7b/");
  const res = await fetch(host + secretPath);
  if (!res.ok) return { statusCode: 404, body: "Not Found" };
  const arrayBuf = await res.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  return {
    statusCode: 200,
    headers: {
      "content-type": res.headers.get("content-type") || "image/webp",
      "cache-control": "public, max-age=86400",
      "access-control-allow-origin": "*"
    },
    body: buf.toString("base64"),
    isBase64Encoded: true
  };
}
`;
}

async function getDeployFiles(deployId) {
  const filesDigest = {};
  let page = 1;
  while (true) {
    try {
      const res = await fetch(`${NETLIFY_API_BASE}/deploys/${deployId}/files?per_page=100&page=${page}`, { headers: defaultHeaders });
      if (!res.ok) break;
      const files = await res.json();
      if (!Array.isArray(files) || files.length === 0) break;
      for (const f of files) {
        if (f.path && f.sha) {
          filesDigest[f.path] = f.sha;
        }
      }
      if (files.length < 100) break;
      page++;
    } catch (e) {
      break;
    }
  }
  return filesDigest;
}

// Phân tích tên folder thành { storySlug, chapterSlug, chapterName }
// Hỗ trợ cả dạng "aov-chuong-1-2" lẫn dạng có hậu tố nguồn ở cuối như
// "ntr-office-lady-bronya-zaychik-chuong-1-dam-ca-nu" => story "ntr-office-lady-bronya-zaychik", chương 1
function parseFolderSlug(folderName) {
  const buildName = (num) => {
    if (num.includes("-")) {
      const cParts = num.split("-");
      return `Chương ${cParts[0]} (${cParts.slice(1).join("-")})`;
    }
    return `Chương ${num}`;
  };

  // 1. Dạng có số chương (lấy marker chương cuối cùng), có thể kèm hậu tố chữ (tên nguồn bị nối vào)
  let m = folderName.match(/^(.+)-(chuong|chap|tap|ch)-(\d+(?:-\d+)*)(?:-([a-z][a-z0-9-]*))?$/i);
  if (m) {
    const prefix = m[2].toLowerCase();
    return { storySlug: m[1], chapterSlug: `${prefix}-${m[3]}`, chapterName: buildName(m[3]), suffix: m[4] || "" };
  }
  // 2. Dạng bị cắt cụt "...-chuong" không có số
  m = folderName.match(/^(.+?)-(chuong|chap|tap|ch)$/i);
  if (m) {
    const prefix = m[2].toLowerCase();
    return { storySlug: m[1], chapterSlug: `${prefix}-1`, chapterName: "Chương 1", suffix: "" };
  }
  return { storySlug: folderName, chapterSlug: "chap-1", chapterName: "Chương 1", suffix: "" };
}

// 4. Deploy mảng các file ảnh lên site Netlify (Hỗ trợ giữ nguyên toàn bộ truyện cũ mà không bị ghi đè)
async function deployMangaToNetlify({ siteId, files, allowedDomains = [], allowedIps = [] }) {
  const edgeFunctionCode = generateEdgeFunctionCode(allowedDomains, allowedIps);
  const netlifyToml = `[[edge_functions]]
  path = "/*"
  function = "protect"
`;

  // Chuẩn bị danh sách file mới cần upload
  const newFilesMap = new Map();

  for (const f of files) {
    let rawName = f.name.replace(/^\/+/, "");
    // Luôn đảm bảo đường dẫn chuẩn: /upload/{tên truyện}/từng ảnh 1
    const pathWithUpload = rawName.startsWith("upload/") ? `/${rawName}` : `/upload/${rawName}`;
    const buf = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "base64");
    newFilesMap.set(pathWithUpload, {
      hash: sha1(buf),
      buffer: buf
    });
  }

  // File cấu hình bảo mật
  const tomlBuf = Buffer.from(netlifyToml, "utf8");
  const edgeBuf = Buffer.from(edgeFunctionCode, "utf8");
  newFilesMap.set("/netlify.toml", { hash: sha1(tomlBuf), buffer: tomlBuf });
  newFilesMap.set("/netlify/edge-functions/protect.js", { hash: sha1(edgeBuf), buffer: edgeBuf });

  // 1. Lấy danh sách toàn bộ file từ bản deploy 'ready' gần nhất để giữ lại không bị mất truyện cũ
  const filesDigest = {};

  try {
    const deploysRes = await fetch(`${NETLIFY_API_BASE}/sites/${siteId}/deploys?state=ready&per_page=1`, { headers: defaultHeaders });
    if (deploysRes.ok) {
      const deploys = await deploysRes.json();
      if (deploys && deploys.length > 0) {
        const prevDigest = await getDeployFiles(deploys[0].id);
        for (const [p, sha] of Object.entries(prevDigest)) {
          // Bỏ qua hoàn toàn các file/thư mục bị lỗi ký tự đặc biệt (dấu cách, +, ¦, ß...) hoặc thư mục bị cắt cụt -chuong
          if (p.startsWith("/upload/")) {
            const rel = p.replace(/^\/upload\//, "");
            const firstSegment = rel.split("/")[0].replace(/\.json$/, "");
            if (firstSegment !== "index.html" && firstSegment !== "index" && firstSegment !== "catalog") {
              if (!/^[a-z0-9-]+$/.test(firstSegment)) continue;
              if (firstSegment === "quyen-tap-art-niui-sieu-mlem-chuong") {
                // Tự động chuyển các file từ thư mục bị cắt cụt sang quyen-tap-art-niui-sieu-mlem-chuong-1
                const fixedPath = p.replace("/upload/quyen-tap-art-niui-sieu-mlem-chuong", "/upload/quyen-tap-art-niui-sieu-mlem-chuong-1");
                filesDigest[fixedPath] = sha;
                continue;
              }
            }
          }
          filesDigest[p] = sha;
        }
      }
    }
  } catch (err) {
    console.error("Lỗi khi đọc file cũ:", err.message);
  }

  // 2. Gộp các file mới vào
  for (const [filePath, fileObj] of newFilesMap.entries()) {
    filesDigest[filePath] = fileObj.hash;
  }

  // 2.1 Tự động tạo danh mục JSON (index.json, .json) và _redirects cho tất cả các bộ truyện
  const host = "http://cdnjsonhentai.netlify.app";
  const mangaMap = {};
  for (const filePath of Object.keys(filesDigest)) {
    if (filePath.startsWith("/upload/")) {
      const rel = filePath.replace(/^\/upload\//, "");
      const parts = rel.split("/");
      if (parts.length > 1) {
        const mangaName = parts[0];
        if (!/^[a-z0-9-]+$/.test(mangaName)) continue;
        const img = parts.slice(1).join("/");
        if (!img.endsWith(".json") && !img.endsWith(".html")) {
          if (!mangaMap[mangaName]) mangaMap[mangaName] = [];
          mangaMap[mangaName].push(img);
        }
      }
    }
  }

  // Tạo index.json và [tên truyện].json cho từng bộ truyện
  for (const [manga, imgs] of Object.entries(mangaMap)) {
    imgs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    const jsonContent = JSON.stringify({
      status: "success",
      manga: manga,
      total_images: imgs.length,
      images: imgs.map(i => `${host}/upload/${manga}/${i}`)
    }, null, 2);

    const buf = Buffer.from(jsonContent, "utf8");
    const h = sha1(buf);

    const p1 = `/upload/${manga}/index.json`;
    const p2 = `/upload/${manga}.json`;
    newFilesMap.set(p1, { hash: h, buffer: buf });
    newFilesMap.set(p2, { hash: h, buffer: buf });
    filesDigest[p1] = h;
    filesDigest[p2] = h;
  }

  // Tạo /upload/index.json tổng hợp tất cả bộ truyện
  const allMangaList = Object.keys(mangaMap).map(manga => ({
    name: manga,
    total_images: mangaMap[manga].length,
    url: `${host}/upload/${manga}`
  }));
  const rootUploadJson = JSON.stringify({
    status: "success",
    service: "cdnjsonhentai Manga Storage API",
    total_manga: allMangaList.length,
    manga_list: allMangaList
  }, null, 2);
  const rootBuf = Buffer.from(rootUploadJson, "utf8");
  const rootH = sha1(rootBuf);
  newFilesMap.set("/upload/index.json", { hash: rootH, buffer: rootBuf });
  filesDigest["/upload/index.json"] = rootH;

  // Tạo /upload/catalog.json và các file story JSON cấp cao (như aov.json)
  const unifiedStories = {};
  for (const [folderName, imgs] of Object.entries(mangaMap)) {
    const parsed = parseFolderSlug(folderName);
    const sSlug = parsed.storySlug;
    let cSlug = parsed.chapterSlug;
    const cName = parsed.chapterName;

    if (!unifiedStories[sSlug]) {
      unifiedStories[sSlug] = {
        slug: sSlug,
        chapters: [],
        allImages: []
      };
    }
    // Tránh trùng chapter_id khi 2 folder khác nhau cùng ra 1 số chương
    if (unifiedStories[sSlug].chapters.some(c => c.chapter_id === cSlug)) {
      cSlug = `${cSlug}-${folderName}`;
    }

    unifiedStories[sSlug].chapters.push({
      chapter_id: cSlug,
      chapter_name: cName,
      total_images: imgs.length,
      images: imgs.map(i => `${host}/upload/${folderName}/${i}`)
    });
    unifiedStories[sSlug].allImages.push(...imgs.map(i => `${host}/upload/${folderName}/${i}`));
  }

  // Tạo file JSON tổng hợp cho từng story (vd /upload/aov.json) nếu có nhiều chapter
  for (const [sSlug, sData] of Object.entries(unifiedStories)) {
    sData.chapters.sort((a, b) => a.chapter_name.localeCompare(b.chapter_name, undefined, { numeric: true, sensitivity: "base" }));
    const sJsonContent = JSON.stringify({
      status: "success",
      manga: sSlug,
      total_chapters: sData.chapters.length,
      total_images: sData.allImages.length,
      chapters: sData.chapters,
      images: sData.allImages
    }, null, 2);

    const sBuf = Buffer.from(sJsonContent, "utf8");
    const sH = sha1(sBuf);
    const pStory1 = `/upload/${sSlug}.json`;
    const pStory2 = `/upload/${sSlug}/index.json`;
    newFilesMap.set(pStory1, { hash: sH, buffer: sBuf });
    newFilesMap.set(pStory2, { hash: sH, buffer: sBuf });
    filesDigest[pStory1] = sH;
    filesDigest[pStory2] = sH;
  }

  const storiesForCatalog = Object.values(unifiedStories).map(s => ({
    slug: s.slug,
    total_chapters: s.chapters.length,
    total_images: s.allImages.length,
    json_url: `${host}/upload/${s.slug}.json`,
    chapters: s.chapters
  }));

  const catalogPayload = JSON.stringify({
    status: "success",
    timestamp: new Date().toISOString(),
    total_stories: storiesForCatalog.length,
    stories: storiesForCatalog
  }, null, 2);
  const catBuf = Buffer.from(catalogPayload, "utf8");
  const catH = sha1(catBuf);
  newFilesMap.set("/upload/catalog.json", { hash: catH, buffer: catBuf });
  filesDigest["/upload/catalog.json"] = catH;

  // Đồng bộ toàn bộ ảnh và file json sang vault bí mật để Guard Function kiểm soát 403
  for (const filePath of Object.keys(filesDigest)) {
    if (filePath.startsWith("/upload/")) {
      const vaultPath = filePath.replace(/^\/upload\//, "/_vault_9f8a7b/");
      filesDigest[vaultPath] = filesDigest[filePath];
    }
  }
  for (const [filePath, fileObj] of Array.from(newFilesMap.entries())) {
    if (filePath.startsWith("/upload/")) {
      const vaultPath = filePath.replace(/^\/upload\//, "/_vault_9f8a7b/");
      filesDigest[vaultPath] = fileObj.hash;
      newFilesMap.set(vaultPath, fileObj);
    }
  }

  // Đóng gói Serverless Guard Function kiểm soát 403 Hotlink Protection
  const guardCode = generateProtectFunctionCode(allowedDomains, allowedIps);
  const fnZip = createZipBuffer([{ name: "guard.js", data: Buffer.from(guardCode, "utf8") }]);
  const fnHash = sha256(fnZip);

  // Cấu hình Redirects bắt buộc mọi request tới /upload/* phải qua Guard Function (chặn 403)
  const redirectsContent = `/upload/*  /.netlify/functions/guard  200!\n`;
  const redBuf = Buffer.from(redirectsContent, "utf8");
  const redH = sha1(redBuf);
  newFilesMap.set("/_redirects", { hash: redH, buffer: redBuf });
  filesDigest["/_redirects"] = redH;

  // 3. Khởi tạo bản deploy mới trên Netlify bằng SHA1 digest và Function Hash
  const deployRes = await fetch(`${NETLIFY_API_BASE}/sites/${siteId}/deploys`, {
    method: "POST",
    headers: {
      ...defaultHeaders,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      files: filesDigest,
      functions: { "guard": fnHash }
    })
  });

  if (!deployRes.ok) {
    // Fallback: nếu lỗi digest thì dùng zip
    const zipFiles = [];
    for (const [p, obj] of newFilesMap.entries()) {
      zipFiles.push({ name: p.replace(/^\//, ""), data: obj.buffer });
    }
    const zipBuf = createZipBuffer(zipFiles);
    const zRes = await fetch(`${NETLIFY_API_BASE}/sites/${siteId}/deploys`, {
      method: "POST",
      headers: { ...defaultHeaders, "Content-Type": "application/zip" },
      body: zipBuf
    });
    if (!zRes.ok) throw new Error(`Netlify Deploy Failed (${zRes.status}): ${await zRes.text()}`);
    return await zRes.json();
  }

  const deployData = await deployRes.json();
  const requiredHashes = new Set(deployData.required || []);
  const requiredFunctions = new Set(deployData.required_functions || []);

  // Tải lên Serverless Guard Function nếu Netlify yêu cầu
  if (requiredFunctions.has(fnHash)) {
    await fetch(`${NETLIFY_API_BASE}/deploys/${deployData.id}/functions/guard?runtime=js`, {
      method: "PUT",
      headers: {
        ...defaultHeaders,
        "Content-Type": "application/octet-stream"
      },
      body: fnZip
    });
  }

  // 4. Chỉ tải lên những file mới mà Netlify yêu cầu (files cũ được giữ nguyên 100%)
  for (const [filePath, fileObj] of newFilesMap.entries()) {
    if (requiredHashes.has(fileObj.hash)) {
      const cleanUploadPath = filePath.replace(/^\//, "");
      await fetch(`${NETLIFY_API_BASE}/deploys/${deployData.id}/files/${cleanUploadPath}`, {
        method: "PUT",
        headers: {
          ...defaultHeaders,
          "Content-Type": "application/octet-stream"
        },
        body: fileObj.buffer
      });
    }
  }

  // 5. Chờ bản deploy sẵn sàng để bảo toàn tính nguyên vẹn cho các lượt tải tiếp theo
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 800));
    try {
      const stRes = await fetch(`${NETLIFY_API_BASE}/deploys/${deployData.id}`, { headers: defaultHeaders });
      if (stRes.ok) {
        const st = await stRes.json();
        if (st.state === "ready" || st.state === "error") {
          return st;
        }
      }
    } catch (e) {}
  }

  return deployData;
}

// 5. Lấy danh mục toàn bộ truyện, chapter, ảnh và giờ đăng chi tiết từ Netlify
async function getMangaCatalog(siteId = "9cfd6ecc-b354-4abd-9c00-9c0659b25ed4") {
  const deploysRes = await fetch(`${NETLIFY_API_BASE}/sites/${siteId}/deploys?state=ready&per_page=10`, { headers: defaultHeaders });
  if (!deploysRes.ok) throw new Error(`Netlify API Error: ${deploysRes.status}`);
  const deploys = await deploysRes.json();
  if (!deploys || deploys.length === 0) {
    return { status: "success", total_stories: 0, total_chapters: 0, total_images: 0, stories: [] };
  }

  const readyDeploy = deploys[0];
  const deployTime = readyDeploy.created_at || new Date().toISOString();
  const filesDigest = await getDeployFiles(readyDeploy.id);
  const host = "http://cdnjsonhentai.netlify.app";

  const titleDisplayMap = {
    "naruto": "Naruto",
    "ai-peak": "Ai Peak",
    "anh-gia-su": "Anh Gia Sư",
    "aov": "AOV",
    "quyen-tap-art-niui-sieu-mlem": "Quyển Tập Art Niui Siêu Mlem"
  };

  // Bảng ánh xạ mốc thời gian tải lên thực tế theo đúng full folder slug trên Netlify
  const folderTimeMap = {
    "naruto": "2026-11-11T16:30:00.000Z",
    "ai-peak": "2026-11-11T16:35:00.000Z",
    "anh-gia-su": "2026-11-11T16:40:00.000Z",
    "aov-chuong-1": "2026-11-12T07:01:09.974Z",
    "aov-chuong-1-1": "2026-11-12T07:01:15.010Z",
    "aov-chuong-1-2": "2026-11-12T07:01:19.675Z",
    "aov-chuong-1-3": "2026-11-12T07:01:24.971Z",
    "aov-chuong-1-4": "2026-11-12T07:01:28.457Z",
    "aov-chuong-1-5": "2026-11-12T07:01:32.070Z",
    "aov-chuong-1-6": "2026-11-12T07:01:36.560Z",
    "aov-chuong-1-7": "2026-11-12T07:01:41.226Z",
    "aov-chuong-1-8": "2026-11-12T07:01:46.049Z",
    "aov-chuong-1-9": "2026-11-12T07:01:51.655Z",
    "aov-chuong-1-10": "2026-11-12T07:01:56.334Z",
    "aov-chuong-1-11": "2026-11-12T07:02:00.764Z",
    "aov-chuong-1-12": "2026-11-12T07:02:05.165Z",
    "aov-chuong-1-13": "2026-11-12T07:02:10.003Z",
    "aov-chuong-2": "2026-11-12T07:02:14.468Z",
    "aov-chuong-3": "2026-11-12T07:02:19.743Z",
    "aov-chuong-4": "2026-11-12T07:02:23.379Z",
    "quyen-tap-art-niui-sieu-mlem-chuong": "2026-11-12T07:58:22.498Z",
    "quyen-tap-art-niui-sieu-mlem-chuong-1": "2026-11-12T07:58:22.498Z",
    "quyen-tap-art-niui-sieu-mlem-chuong-1-1": "2026-11-12T09:17:06.809Z",
    "quyen-tap-art-niui-sieu-mlem-chuong-1-2": "2026-11-12T09:17:12.251Z",
    "quyen-tap-art-niui-sieu-mlem-chuong-1-3": "2026-11-12T09:17:19.362Z",
    "quyen-tap-art-niui-sieu-mlem-chuong-1-4": "2026-11-12T09:17:24.992Z",
    "quyen-tap-art-niui-sieu-mlem-chuong-1-5": "2026-11-12T09:17:31.512Z",
    "quyen-tap-art-niui-sieu-mlem-chuong-1-6": "2026-11-12T09:17:37.814Z",
    "quyen-tap-art-niui-sieu-mlem-chuong-2": "2026-11-12T09:17:43.363Z",
    "quyen-tap-art-niui-sieu-mlem-chuong-3": "2026-11-12T09:17:49.324Z"
  };

  const storyMap = new Map();

  for (const filePath of Object.keys(filesDigest)) {
    if (!filePath.startsWith("/upload/")) continue;
    if (filePath.endsWith(".json") || filePath.endsWith(".html")) continue;

    const rel = filePath.replace(/^\/upload\//, "");
    const parts = rel.split("/");
    if (parts.length < 2) continue;

    const rawFolder = parts[0];
    // Loại bỏ hoàn toàn các thư mục bị lỗi ký tự đặc biệt
    if (!/^[a-z0-9-]+$/.test(rawFolder)) continue;

    let storySlug = "";
    let chapterSlug = "";
    let chapterName = "";
    let fileName = "";

    if (parts.length === 2) {
      fileName = parts[1];

      // Phân tách tự động nếu tên folder chứa chapter (vd: aov-chuong-1-1, ...-chuong-1-dam-ca-nu)
      const parsed = parseFolderSlug(rawFolder);
      storySlug = parsed.storySlug;
      chapterSlug = parsed.chapterSlug;
      chapterName = parsed.chapterName;
    } else {
      storySlug = parts[0];
      chapterSlug = parts[1];
      fileName = parts.slice(2).join("/");

      const match = chapterSlug.match(/^(chuong|chap|tap|ch)-(\d+(?:-\d+)*)$/i);
      if (match) {
        const chapNum = match[2];
        if (chapNum.includes("-")) {
          const cParts = chapNum.split("-");
          chapterName = `Chương ${cParts[0]} (${cParts.slice(1).join("-")})`;
        } else {
          chapterName = `Chương ${chapNum}`;
        }
      } else {
        chapterName = (chapterSlug === "chap-1" || chapterSlug === "1") ? "Chương 1" : chapterSlug;
      }
    }

    if (!storyMap.has(storySlug)) {
      storyMap.set(storySlug, new Map());
    }
    const chapMap = storyMap.get(storySlug);
    // Nếu 2 folder khác nhau cùng ra 1 số chương thì tách riêng để không lẫn ảnh
    if (chapMap.has(chapterSlug) && chapMap.get(chapterSlug).rawFolder !== rawFolder) {
      chapterSlug = `${chapterSlug}-${rawFolder}`;
    }
    if (!chapMap.has(chapterSlug)) {
      chapMap.set(chapterSlug, { name: chapterName, rawFolder, files: [] });
    }

    chapMap.get(chapterSlug).files.push({
      path: filePath,
      fileName,
      url: `${host}${filePath}`,
      sha: filesDigest[filePath]
    });
  }

  const stories = [];
  let grandTotalImages = 0;
  let grandTotalChapters = 0;

  for (const [storySlug, chapMap] of storyMap.entries()) {
    let storyImgCount = 0;
    const chapters = [];
    let oldestStoryTime = null;
    let newestStoryTime = null;

    for (const [chapterSlug, chapData] of chapMap.entries()) {
      const imgs = chapData.files;
      imgs.sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: "base" }));
      storyImgCount += imgs.length;

      // Xác định thời gian tải lên chính xác của từng chapter theo đúng folder gốc
      const chapUploadTime = folderTimeMap[chapData.rawFolder] || folderTimeMap[`${storySlug}-${chapterSlug}`] || folderTimeMap[storySlug] || deployTime;
      const cDate = new Date(chapUploadTime);
      if (!oldestStoryTime || cDate < new Date(oldestStoryTime)) oldestStoryTime = chapUploadTime;
      if (!newestStoryTime || cDate > new Date(newestStoryTime)) newestStoryTime = chapUploadTime;

      chapters.push({
        chapter_id: chapterSlug,
        chapter_name: chapData.name,
        total_images: imgs.length,
        created_at: chapUploadTime,
        images: imgs.map(i => i.url)
      });
    }

    chapters.sort((a, b) => a.chapter_name.localeCompare(b.chapter_name, undefined, { numeric: true, sensitivity: "base" }));

    grandTotalChapters += chapters.length;
    grandTotalImages += storyImgCount;

    let displayTitle = titleDisplayMap[storySlug] || 
      (storySlug.length <= 4 
        ? storySlug.toUpperCase() 
        : storySlug.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "));

    const isCleanSlug = /^[a-z0-9-]+$/.test(storySlug);

    stories.push({
      slug: storySlug,
      title: displayTitle,
      is_clean_slug: isCleanSlug,
      created_at: oldestStoryTime || deployTime,
      updated_at: newestStoryTime || deployTime,
      total_chapters: chapters.length,
      total_images: storyImgCount,
      json_url: `${host}/upload/${storySlug}.json`,
      chapters
    });
  }

  stories.sort((a, b) => {
    if (a.is_clean_slug && !b.is_clean_slug) return -1;
    if (!a.is_clean_slug && b.is_clean_slug) return 1;
    return new Date(b.updated_at) - new Date(a.updated_at);
  });

  return {
    status: "success",
    timestamp: deployTime,
    site_id: siteId,
    site_url: host,
    total_stories: stories.length,
    total_chapters: grandTotalChapters,
    total_images: grandTotalImages,
    stories
  };
}

// 6. Kiểm tra xem chuỗi slug / action đã tồn tại trên CDN hay chưa
async function getExistingSlugs(siteId = "9cfd6ecc-b354-4abd-9c00-9c0659b25ed4") {
  try {
    const deploysRes = await fetch(`${NETLIFY_API_BASE}/sites/${siteId}/deploys?state=ready&per_page=1`, { headers: defaultHeaders });
    if (!deploysRes.ok) return [];
    const deploys = await deploysRes.json();
    if (!deploys || deploys.length === 0) return [];
    const files = await getDeployFiles(deploys[0].id);
    const slugs = new Set();
    for (const p of Object.keys(files)) {
      if (p.startsWith("/upload/") && !p.endsWith(".json") && !p.endsWith(".html")) {
        const parts = p.replace(/^\/upload\//, "").split("/");
        if (parts[0] && /^[a-z0-9-]+$/.test(parts[0])) {
          slugs.add(parts[0]);
        }
      }
    }
    return Array.from(slugs);
  } catch (e) {
    return [];
  }
}

async function checkSlugExists(siteId, slug) {
  if (!slug) return false;
  const existing = await getExistingSlugs(siteId);
  return existing.includes(slug.toLowerCase().trim());
}

module.exports = {
  listNetlifySites,
  createNetlifySite,
  deployMangaToNetlify,
  generateEdgeFunctionCode,
  getMangaCatalog,
  getExistingSlugs,
  checkSlugExists
};

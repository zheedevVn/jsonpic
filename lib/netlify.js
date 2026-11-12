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
        Object.assign(filesDigest, prevDigest);
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
        const img = parts.slice(1).join("/");
        if (!img.endsWith(".json")) {
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

  // Tạo /upload/catalog.json chi tiết toàn bộ truyện và chapter
  const storiesForCatalog = [];
  for (const [manga, imgs] of Object.entries(mangaMap)) {
    const chapMap = {};
    for (const img of imgs) {
      const parts = img.split("/");
      let cName = parts.length > 1 ? parts[0] : "chap-1";
      if (!chapMap[cName]) chapMap[cName] = [];
      chapMap[cName].push(`${host}/upload/${manga}/${img}`);
    }
    const chaps = Object.entries(chapMap).map(([cSlug, cImgs]) => ({
      chapter_id: cSlug,
      chapter_name: cSlug === "chap-1" ? "Chương 1" : cSlug,
      total_images: cImgs.length,
      images: cImgs
    }));
    storiesForCatalog.push({
      slug: manga,
      total_chapters: chaps.length,
      total_images: imgs.length,
      json_url: `${host}/upload/${manga}.json`,
      chapters: chaps
    });
  }
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

  // Tạo /_redirects để khi truy vấn /upload/{tên truyện} hoặc /upload/{tên truyện}/ tự động trả về index.json
  const redirectsContent = `
/upload/*   /upload/:splat/index.json   200
`;
  const redBuf = Buffer.from(redirectsContent, "utf8");
  const redH = sha1(redBuf);
  newFilesMap.set("/_redirects", { hash: redH, buffer: redBuf });
  filesDigest["/_redirects"] = redH;

  // 3. Khởi tạo bản deploy mới trên Netlify bằng SHA1 digest
  const deployRes = await fetch(`${NETLIFY_API_BASE}/sites/${siteId}/deploys`, {
    method: "POST",
    headers: {
      ...defaultHeaders,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ files: filesDigest })
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
    "anh-gia-su": "Anh Gia Sư"
  };

  const storyMap = new Map();

  for (const filePath of Object.keys(filesDigest)) {
    if (!filePath.startsWith("/upload/")) continue;
    if (filePath.endsWith(".json") || filePath.endsWith(".html")) continue;

    const rel = filePath.replace(/^\/upload\//, "");
    const parts = rel.split("/");
    if (parts.length < 2) continue;

    const storySlug = parts[0];
    let chapterSlug = "";
    let fileName = "";

    if (parts.length === 2) {
      chapterSlug = "chap-1";
      fileName = parts[1];
    } else {
      chapterSlug = parts[1];
      fileName = parts.slice(2).join("/");
    }

    if (!storyMap.has(storySlug)) {
      storyMap.set(storySlug, new Map());
    }
    const chapMap = storyMap.get(storySlug);
    if (!chapMap.has(chapterSlug)) {
      chapMap.set(chapterSlug, []);
    }

    chapMap.get(chapterSlug).push({
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

    for (const [chapterSlug, imgs] of chapMap.entries()) {
      imgs.sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: "base" }));
      storyImgCount += imgs.length;

      let chapterName = chapterSlug;
      if (chapterSlug === "chap-1" || chapterSlug === "1") chapterName = "Chương 1";
      else if (/^chap-\d+$/i.test(chapterSlug)) chapterName = "Chương " + chapterSlug.replace(/^chap-/i, "");
      else if (/^chuong-\d+$/i.test(chapterSlug)) chapterName = "Chương " + chapterSlug.replace(/^chuong-/i, "");

      chapters.push({
        chapter_id: chapterSlug,
        chapter_name: chapterName,
        total_images: imgs.length,
        created_at: deployTime,
        images: imgs.map(i => i.url)
      });
    }

    chapters.sort((a, b) => a.chapter_name.localeCompare(b.chapter_name, undefined, { numeric: true, sensitivity: "base" }));
    grandTotalChapters += chapters.length;
    grandTotalImages += storyImgCount;

    let displayTitle = titleDisplayMap[storySlug] || storySlug.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    const isCleanSlug = /^[a-z0-9-]+$/.test(storySlug);

    stories.push({
      slug: storySlug,
      title: displayTitle,
      is_clean_slug: isCleanSlug,
      created_at: deployTime,
      total_chapters: chapters.length,
      total_images: storyImgCount,
      json_url: `${host}/upload/${storySlug}.json`,
      chapters
    });
  }

  const priorityOrder = ["naruto", "ai-peak", "anh-gia-su"];
  stories.sort((a, b) => {
    const idxA = priorityOrder.indexOf(a.slug);
    const idxB = priorityOrder.indexOf(b.slug);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    if (a.is_clean_slug && !b.is_clean_slug) return -1;
    if (!a.is_clean_slug && b.is_clean_slug) return 1;
    return a.title.localeCompare(b.title);
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

module.exports = {
  listNetlifySites,
  createNetlifySite,
  deployMangaToNetlify,
  generateEdgeFunctionCode,
  getMangaCatalog
};

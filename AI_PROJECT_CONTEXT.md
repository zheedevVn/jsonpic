# 🤖 HƯỚNG DẪN DÀNH CHO AI TIẾP QUẢN DỰ ÁN (AI HANDOVER CONTEXT)
> **Dự án:** JSONPic — High Security Manga CDN Storage & Cyber Admin Suite  
> **Cập nhật lần cuối:** 11/11/2026 bởi Zhee Dev & Antigravity AI  
> **Mục đích tài liệu:** Cung cấp 100% bối cảnh kiến trúc, tài khoản, quy tắc bảo mật và các lưu ý cốt lõi để bất kỳ AI nào đọc vào cũng có thể tiếp tục phát triển ngay mà **KHÔNG GẶP BẤT KỲ LỖI NÀO**.

---

## 1. TỔNG QUAN HỆ THỐNG & ĐƯỜNG DẪN

* **Domain chính:** `https://jsonpic.vercel.app`
* **Route 1: Root (`/`)**
  * **Yêu cầu bắt buộc:** Phải trả về **JSON thuần** (Status 200, Content-Type: application/json). Tuyệt đối **KHÔNG** hiển thị giao diện HTML ở trang chủ để tránh lộ thông tin dịch vụ.
* **Route 2: Admin Panel (`/client/admin`)**
  * **Mục đích:** Giao diện quản trị Cyber Admin Suite để đăng truyện tranh và quản lý whitelist.
  * **Tài khoản đăng nhập:**
    * **Username:** `hoducminh`
    * **Password:** `minhhocgioi`
    * *Token sinh ra:* HMAC-SHA256 JWT có hiệu lực 24 giờ.

---

## 2. KHO REPO & QUY TRÌNH DEPLOY VERCEL

* **GitHub:** `https://github.com/zheedevVn/jsonpic.git` (Remote: `origin`, Branch: `main`)
* **GitLab:** `https://gitlab.com/hoducminh4444/jsonpic.git` (Remote: `gitlab`, Branch: `main`, Project ID: `88783508`)
* **Vercel Project:**
  * **Project ID:** `prj_jpqVAct0DBXuEMx0OgQ5RQIChXV0`
  * **Team Slug:** `zhee-dev-tool` (Team ID: `team_mT8Iy0CklAr2GxufQKCqiLfD`)
  * **Vercel Token:** `vcp_1JmOH46Zm1Po4iyyCK8tK...` (Lưu trong biến môi trường `VERCEL_TOKEN`)
  * **GitLab Token:** `glpat-TjeofEG1L1vdVIAbYB...` (Lưu trong biến môi trường `GITLAB_TOKEN`)
* **Cơ chế Auto-Deploy:**
  * Vercel đã liên kết trực tiếp với GitLab repo `hoducminh4444/jsonpic`.
  * **QUY TẮC BẮT BUỘC KHI PUSH CODE:** Luôn luôn push lên cả 2 remote:
    ```bash
    git push origin main && git push gitlab main
    ```
    Khi push vào `gitlab main`, Vercel sẽ tự động trigger build và deploy ra domain `jsonpic.vercel.app` trong 10-15 giây.

---

## 3. TÀI KHOẢN NETLIFY & CƠ CHẾ LƯU TRỮ ẢNH TRUYỆN

* **Netlify Personal Access Token:** `nfp_BkhSuHWnWc3JynUg...` (Lưu trong biến môi trường `NETLIFY_TOKEN`)
* **Mạng lưới Site CDN:** Tài khoản hiện có **74 site** Netlify (`api-doctruyen210`, `doggyv1` đến `doggyv18`, `taianh210`,...).
* **Cách thức Deploy ảnh:**
  * Ảnh được tải lên Netlify qua REST API: `POST https://api.netlify.com/api/v1/sites/{site_id}/deploys` với header `Content-Type: application/zip`.
  * Bộ nén `lib/zip.js` thực hiện nén in-memory không cần thư viện bên ngoài nặng nề.

---

## 4. CƠ CHẾ CHẶN 403 FORBIDDEN TOÀN BỘ INTERNET (ANTI-HOTLINK)

Mỗi lần deploy truyện lên Netlify, hệ thống tự động tiêm:
1. `netlify.toml`:
   ```toml
   [[edge_functions]]
     path = "/*"
     function = "protect"
   ```
2. `netlify/edge-functions/protect.js`:
   * **Kiểm tra 1 (IP Whitelist của Admin):** Nếu `clientIP` của request nằm trong danh sách `allowedIps` $\rightarrow$ Cho phép xem ảnh trực tiếp 200 OK (để Admin bấm link test ảnh mà không bị 403).
   * **Kiểm tra 2 (Website chỉ định):** Nếu `referer` chứa domain nằm trong `allowedDomains` $\rightarrow$ Cho phép load ảnh 200 OK để độc giả đọc truyện.
   * **Tất cả trường hợp còn lại:** Người ngoài bấm link trực tiếp, web lạ nhúng trộm link ảnh $\rightarrow$ Trả về **`HTTP 403 Forbidden`**.

---

## 5. TƯỜNG LỬA WAF VÀ NHỮNG LỖI CỰC KỲ QUAN TRỌNG CẦN TRÁNH

Tệp `lib/security.js` phụ trách bảo vệ hệ sinh thái:
* **Anti-SQLi:** Chặn `UNION SELECT`, `' OR '1'='1`, `benchmark()`, `sleep()`, comment injection.
* **Anti-Dump:** Chặn path traversal `../`, `/etc/passwd`, `.env`, `.git`.
* **Anti-Map:** Chặn các scanner `sqlmap`, `nmap`, `nikto`, `wpscan`, `dirbuster`, `gobuster`.
* **Brute-Force:** Khóa IP 15 phút nếu nhập sai mật khẩu 5 lần.

⚠️ **LƯU Ý CỐT TỬ (CRITICAL GOTCHA CHO AI TIẾP THEO):**
* **TUYỆT ĐỐI KHÔNG** quét toàn bộ HTTP Headers bằng regex chứa ký tự comment SQL `/*` hoặc `--` (ví dụ: `/(--|\#|\/\*|\*\/)/`).
* **Lý do:** Mọi trình duyệt chuẩn (Chrome, Edge, Safari, Firefox) đều gửi header:  
  `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8`  
  Ký tự `*/*` trong header `Accept` sẽ kích hoạt regex comment `/*` $\rightarrow$ Dẫn đến việc **chặn nhầm tất cả người dùng thật bằng mã lỗi 400 WAF Alert!**
* **Quy chuẩn đúng:** Chỉ quét các target sau: `url`, query params, POST `body`, và `x-forwarded-uri`.

---

## 6. QUY TẮC GIAO DIỆN ADMIN (UI RULES)

Theo yêu cầu của người dùng:
1. **Không hiển thị gợi ý (No suggestions/placeholders):**
   * Các input `inputManga`, `inputChapter`, `inputDomains`, `customIpInput` phải để `placeholder=""` và `value=""`.
   * Luôn gắn `autocomplete="off"` và `spellcheck="false"` trên toàn bộ form và input để trình duyệt không xổ popup gợi ý lịch sử nhập.

---

## 7. CẤU TRÚC TỆP DỰ ÁN

```
jsonpic/
├── api/
│   ├── index.js             # Xử lý Root / (trả về JSON) và render /client/admin HTML
│   └── admin.js             # API /api/admin: login, info, sites, create-site, ip-whitelist, upload
├── lib/
│   ├── security.js          # WAF phòng thủ: Anti-SQLi, Anti-Dump, Anti-Map, Rate-limit, JWT
│   ├── netlify.js           # Tương tác Netlify API & sinh mã Edge Function 403 Protection
│   ├── zip.js               # Bộ nén zip in-memory chuẩn PKZIP
│   └── db.js                # Quản lý cài đặt cấu hình IP Whitelist & Domain Whitelist
├── public/
│   └── admin.html           # Giao diện Cyber Luxury Admin Suite
├── vercel.json              # Cấu hình rewrite & security headers của Vercel
├── package.json
├── README.md
└── AI_PROJECT_CONTEXT.md    # Tài liệu này
```

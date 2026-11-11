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

## 3. TÀI KHOẢN NETLIFY & QUY CHUẨN LƯU TRỮ TRUYỆN DUY NHẤT (CDNJSONHENTAI)

* **Netlify Personal Access Token:** `nfp_BkhSuHWnWc3JynUg...` (Lưu trong biến môi trường `NETLIFY_TOKEN`)
* **Site CDN Chuẩn Duy Nhất:**
  * **Site Name:** `cdnjsonhentai`
  * **Site ID:** `9cfd6ecc-b354-4abd-9c00-9c0659b25ed4`
  * **URL Chuẩn Bắt Buộc:** `http://cdnjsonhentai.netlify.app/upload/{tên truyện}/từng ảnh 1`
* **Cơ Chế Deploy Giữ Nguyên 100% Truyện Cũ (Incremental SHA1 Digest):**
  * Không dùng deploy dạng zip ghi đè toàn bộ site.
  * Tệp `lib/netlify.js` tự động truy vấn danh sách file của bản deploy `ready` trước đó qua API Netlify (`/deploys/{id}/files`).
  * Gộp SHA1 digest của các file cũ với các file truyện mới tải lên.
  * Chỉ tải lên (PUT) các file mới mà Netlify yêu cầu (`deploy.required`).
  * Đợi deploy đạt trạng thái `ready` (1-2s) để đảm bảo tính nhất quán dữ liệu cho các lần đăng tiếp theo.
  * Nhờ đó: Người dùng có thể đăng hàng trăm bộ truyện / chương truyện khác nhau mà **KHÔNG BAO GIỜ BỊ MẤT TRUYỆN CŨ**.

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
2. **Quy Chuẩn 1 Domain Duy Nhất (Single CDN Link):**
   * Người dùng không muốn tạo hàng chục site riêng biệt.
   * Tất cả thư mục khi kéo thả (kể cả 3 thư mục độc lập từ máy tính) sẽ cùng đẩy lên site duy nhất `cdnjsonhentai` (`9cfd6ecc-b354-4abd-9c00-9c0659b25ed4`).
   * Cấu trúc URL trả về luôn là:  
     `http://cdnjsonhentai.netlify.app/upload/{tên truyện}/từng ảnh 1`
   * Tự động batching thành các đợt tối đa 15 ảnh để không bao giờ bị dính lỗi `413 Payload Too Large` của Vercel Serverless (4.5MB limit).

---

## 7. CẤU TRÚC TỆP DỰ ÁN

```
jsonpic/
├── api/
│   ├── index.js             # Xử lý Root / (trả về JSON) và render /client/admin HTML
│   └── admin.js             # API /api/admin: login, info, sites, create-site, ip-whitelist, upload
├── lib/
│   ├── security.js          # WAF phòng thủ: Anti-SQLi, Anti-Dump, Anti-Map, Rate-limit, JWT
│   ├── netlify.js           # Netlify SHA1 Digest Deploy (Incremental) & Edge Function 403
│   ├── zip.js               # Bộ nén zip in-memory chuẩn PKZIP
│   └── db.js                # Quản lý cài đặt cấu hình IP Whitelist & Domain Whitelist
├── public/
│   └── admin.html           # Giao diện Cyber Luxury Admin Suite (Batch Upload, Link Generator)
├── vercel.json              # Cấu hình rewrite & security headers của Vercel
├── package.json
├── README.md
└── AI_PROJECT_CONTEXT.md    # Tài liệu này
```

# JSONPic — High Security Manga CDN & Cyber Admin Suite

> **Deploy URL:** [https://jsonpic.vercel.app](https://jsonpic.vercel.app)  
> **Admin Dashboard:** [https://jsonpic.vercel.app/client/admin](https://jsonpic.vercel.app/client/admin)  
> **Author:** Security Server  
> 🤖 **Dành cho AI tiếp quản dự án:** Đọc chi tiết tại [AI_PROJECT_CONTEXT.md](file:///home/antigravity/zheedevVn/jsonpic/AI_PROJECT_CONTEXT.md)

---

## ⚡ Kiến Trúc & Tính Năng

1. **Root URL (`/`)**:
   - Trả về JSON chuẩn API, không lộ giao diện, bảo vệ thông tin dịch vụ.
2. **Admin Suite (`/client/admin`)**:
   - Đăng nhập bảo mật với thông tin: `hoducminh` | `minhhocgioi`.
   - Giao diện **Cyber Luxury Dark 2026** Glassmorphism.
   - Kéo thả / đăng ảnh truyện không cần vào web Netlify thủ công.
   - Tự động nén, cấu hình Edge Function chặn `403 Forbidden` toàn bộ Internet (anti-hotlinking), chỉ mở cho web truyện chỉ định.
   - **IP Whitelist**: Cho phép admin thêm IP của mình vào danh sách để bấm vào link ảnh trực tiếp kiểm tra mà không bị 403!
   - Quản lý 74+ site Netlify CDN, tạo site mới trong 1 giây.
3. **Tường Lửa WAF Đa Tầng**:
   - **Anti-SQLi**: Chặn SQLMap, UNION SELECT, OR 1=1...
   - **Anti-Dump**: Chặn khai thác ../, /etc/passwd, .env, .git...
   - **Anti-Map / Scanner**: Cắt đứt các tool dò quét nmap, nikto, wpscan, dirbuster...
   - **Brute-Force Shield**: Khóa IP sau 5 lần nhập sai mật khẩu.

---

## 🚀 Đẩy code & Deploy
```bash
git push origin main && git push gitlab main
```
*Vercel sẽ tự động deploy mỗi khi push code lên `gitlab main`.*

# OCR Center

เว็บกลางสำหรับมอนิเตอร์กล้อง OCR (CM4) ทั้ง fleet — รับ heartbeat จากกล้อง, ลงทะเบียนอุปกรณ์อัตโนมัติ, เก็บประวัติค่าที่อ่านได้, แสดงสถานะ/สุขภาพเครื่องแบบเรียลไทม์

## โครงสร้าง

```
OCR-Center/
├── package.json
├── .env                  # ตั้งค่า PORT / API_KEY / retention
├── data/center.db        # SQLite (สร้างอัตโนมัติ)
└── src/
    ├── server.js         # express bootstrap + basic-auth dashboard
    ├── db.js             # schema + ingest transaction + prune
    ├── routes/
    │   ├── ingest.js     # POST /api/devices/heartbeat  (ฝั่งกล้อง, X-Api-Key)
    │   └── api.js        # REST ฝั่ง dashboard
    └── public/index.html # หน้า fleet dashboard (ธีมเดียวกับหน้ากล้อง)
```

## ติดตั้ง + รัน

**ทางลัด (Linux/Raspberry Pi — ติดตั้ง + pm2 + auto-start ตอนบูต ครบในคำสั่งเดียว):**

```bash
git clone https://github.com/Commerry/OCR-Center.git
cd OCR-Center
bash install.sh
```

**หรือรันมือ (ทุก OS รวม Windows):**

```bash
npm install
cp .env.example .env    # Windows: copy .env.example .env
npm start               # http://localhost:8090
```

> เครื่องหลัง proxy โรงงาน: ตั้ง proxy ของ npm ก่อน (`npm config set proxy http://10.201.0.54:8080` + `https-proxy` + `strict-ssl false`) — รายละเอียดดู `docs/UPDATE_GUIDE.md` ใน repo กล้อง

## เชื่อมกล้องเข้า Center

ที่หน้าเว็บกล้องแต่ละตัว → **System → Central Server API**:

- Central API URL: `http://<IP เครื่องที่รัน Center>:8090/api/devices/heartbeat`
- API Key: ให้ตรงกับ `API_KEY` ใน `.env` (ถ้าตั้ง)
- เปิด toggle "ส่งข้อมูลไปเว็บกลาง" → Save API Settings

อุปกรณ์จะโผล่บน dashboard เองเมื่อ heartbeat แรกเข้ามา (จำด้วย `deviceId` = MAC address) — ไม่ต้องแอดมือ

## ข้อมูลที่เก็บ

| ตาราง | ข้อมูล | retention |
|---|---|---|
| `devices` | ตัวตนอุปกรณ์ + health ล่าสุด | ถาวร |
| `cameras` | สถานะกล้อง/PLC/ค่าอ่าน/ภาพล่าสุด ต่อกล้อง | ล่าสุดเสมอ |
| `reads` | ประวัติเลขทุกค่าที่ส่ง PLC (กันซ้ำด้วย device+camera+เวลา) | 90 วัน |
| `health_history` | temp/CPU/RAM/disk sample ทุก 5 นาที | 14 วัน |

## Alert rules (คำนวณอัตโนมัติ)

- **OFFLINE** — ไม่มี heartbeat เกิน `OFFLINE_AFTER_SEC` (default 90 วิ)
- **Disk** ≥75% เหลือง, ≥85% แดง
- **Temp** ≥65°C เหลือง, ≥75°C แดง
- **camera enabled แต่ไม่ running** / **PLC enabled แต่ต่อไม่ได้**

## การจัดกลุ่ม (Group / Plant)

อุปกรณ์ใหม่เข้ามาอยู่ "ยังไม่จัดกลุ่ม" เสมอ → จัดกลุ่มจากหน้าเว็บ (ไม่ต้องแตะกล้อง):

- **New Group** บน topbar → สร้างกลุ่ม (เช่น โรงงาน A, ไลน์ผลิต 1)
- ปุ่มลูกศรบนการ์ดอุปกรณ์ → ย้ายเข้ากลุ่ม / สร้างกลุ่มใหม่พร้อมย้าย
- หัวข้อกลุ่ม: คลิกพับ/กาง (จำสถานะไว้), ปุ่มแก้ชื่อ/ลบกลุ่ม (ลบแล้วสมาชิกกลับไป Unassigned)
- ทุกกลุ่มอยู่หน้าเดียว แสดง online/total + alerts ราย.กลุ่ม

API: `GET/POST /api/groups`, `PATCH/DELETE /api/groups/:id`, `POST /api/devices/:id/group {groupId}`

## Dashboard API

- `GET /api/summary` — จำนวน online/offline/alerts
- `GET /api/devices` — รายการอุปกรณ์ + กล้อง + alerts
- `GET /api/devices/:id` — รายละเอียดตัวเดียว
- `GET /api/devices/:id/reads?limit=100` — ประวัติการอ่าน
- `GET /api/devices/:id/health-history?limit=288` — ประวัติสุขภาพเครื่อง
- `GET /api/devices/:id/cameras/:camera/image` — ภาพล่าสุด (webp)

สเปก payload ฝั่งกล้องอยู่ที่ `OCR-V8.1/src/utils/centralReporter.js`

## ตั้งชื่อเว็บ + Login

ตั้งใน `.env`:

```
SITE_NAME=PSE OCR CENTER
SITE_SUBTITLE=Vision Fleet Monitor
DASH_USER=admin
DASH_PASS=your-password
```

- `SITE_NAME` / `SITE_SUBTITLE` — ชื่อที่แสดงบนหัวเว็บ, หน้า login และแท็บเบราว์เซอร์
- `DASH_USER` / `DASH_PASS` — บัญชีเข้าใช้งาน (เว้น `DASH_USER` ว่าง = ไม่ต้อง login)
- แก้ `.env` แล้วต้อง `pm2 restart ocr-center`

## URL หน้าเว็บของอุปกรณ์

ปุ่มลิงก์บนการ์ดใช้ `http://<IP ที่กล้องส่งมา>:64010` อัตโนมัติ — แก้เป็น URL อื่นได้รายอุปกรณ์:
คลิกการ์ด → ปุ่มรูปโซ่ (ข้างปุ่มลบ) → ใส่ URL เต็ม (เว้นว่าง = กลับไปใช้ค่าอัตโนมัติ)

## ความปลอดภัย

- Dashboard: ตั้ง `DASH_USER`/`DASH_PASS` ใน `.env` เพื่อเปิด basic-auth (ค่าว่าง = ไม่ล็อค)
- ฝั่งกล้อง: ตั้ง `API_KEY` แล้วใส่ key เดียวกันในหน้ากล้อง

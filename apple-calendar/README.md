# Apple Calendar MCP

Remote MCP server แบบ single-user ให้ Claude อ่าน สร้าง แก้ และลบนัดใน Apple Calendar (iCloud) ผ่าน CalDAV
นัดที่สร้างจะ sync ขึ้น iPhone / iPad / Mac ผ่าน iCloud เอง

```
Claude ──Streamable HTTP + Bearer──> /mcp ──CalDAV (tsdav)──> caldav.icloud.com
   └──────OAuth 2.1 + PKCE──────────> /authorize, /token, /register
```

- ไม่มี database: credential ของ iCloud อยู่ใน environment variable ของ host, OAuth token เป็น JWT ที่เซ็นและเข้ารหัสด้วย `TOKEN_SECRET`
- Client registration รองรับทั้ง Client ID Metadata Documents และ Dynamic Client Registration
- รับ redirect URI เฉพาะ callback ของ Claude (`https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`) และ `http://localhost` / `http://127.0.0.1`

## Tools

| Tool | หน้าที่ | Hint |
|---|---|---|
| `list_calendars` | รายชื่อปฏิทินทั้งหมด | read-only |
| `get_events` | ดูนัดในช่วงเวลา (ขยาย recurring ให้แล้ว, สูงสุด 100 รายการ) | read-only |
| `create_event` | สร้างนัด รองรับ alert, all-day, recurrence (daily/weekly/monthly) | write |
| `update_event` | แก้นัด เฉพาะ field ที่ส่งมา ใช้ `If-Match` กันเขียนทับ | write, destructive |
| `delete_event` | ลบนัด | destructive |

เวลาเป็น ISO 8601 ถ้าไม่มี offset จะตีความตาม `TIMEZONE`

## Environment variables

| ชื่อ | จำเป็น | คำอธิบาย |
|---|---|---|
| `APPLE_ID` | ใช่ | อีเมล Apple ID |
| `APPLE_APP_PASSWORD` | ใช่ | App-Specific Password จาก account.apple.com |
| `LOGIN_PASSPHRASE` | ใช่ | รหัสที่ใส่ตอนกด Allow ใน Claude อย่างน้อย 16 ตัวอักษร |
| `TOKEN_SECRET` | ใช่ | อย่างน้อย 32 ตัวอักษร เช่น `openssl rand -base64 48` |
| `DEFAULT_CALENDAR_NAME` | ไม่ | ค่าเริ่มต้น `MCP-project` |
| `TIMEZONE` | ไม่ | ค่าเริ่มต้น `Asia/Bangkok` |
| `CALDAV_URL` | ไม่ | ค่าเริ่มต้น `https://caldav.icloud.com` |

ตั้งทุกตัวเป็น Sensitive ใน Vercel แล้ว redeploy หน้า `/` ของ server จะบอกว่าตัวไหนตั้งครบแล้ว (แสดงแค่ ✅/⬜ ไม่แสดงค่า)

## เพิ่มใน Claude

1. Settings → Connectors → Add custom connector
2. ใส่ URL `https://<domain>/mcp`
3. กด Connect แล้วใส่ `LOGIN_PASSPHRASE` ในหน้า Allow

## ยกเลิกการเข้าถึง

- เปลี่ยน `TOKEN_SECRET` แล้ว redeploy: token ทุกตัวใช้ไม่ได้ทันที
- เพิกถอน App-Specific Password ที่ account.apple.com: server เข้า iCloud ไม่ได้อีก

## Development

```bash
npm install
cp .env.example .env.local   # ใส่ค่าจริง
npm run dev                  # http://localhost:3000
npm run typecheck
npm test                     # e2e ต้องมี Radicale: pip install radicale
```

## ข้อจำกัดที่รู้อยู่

- **App-Specific Password เข้าถึงได้มากกว่า Calendar** (บริการ iCloud อื่นที่ใช้ protocol มาตรฐานด้วย) เก็บไว้ใน env ที่เป็น Sensitive เท่านั้น
- **ไม่มี storage** จึงเพิกถอน refresh token ทีละตัวไม่ได้ (rotate แล้วตัวเก่ายังใช้ได้จนหมดอายุ 60 วัน) และการกัน authorization code ใช้ซ้ำกับ rate limit เป็นแบบ per-instance วิธีเพิกถอนทั้งหมดคือเปลี่ยน `TOKEN_SECRET`
- **Recurring event**: `update_event` และ `delete_event` มีผลทั้ง series ยังแก้ทีละ occurrence ไม่ได้ และการย้ายเวลาเริ่มไม่ปรับ `EXDATE` เดิม
- **Timezone ที่มี DST**: เขียนเวลาเป็น UTC แทน `TZID` นัดแบบ recurring จึงเลื่อนตาม DST ได้ (`Asia/Bangkok` ไม่มีปัญหานี้)
- ยังไม่รองรับ invitees และ Reminders

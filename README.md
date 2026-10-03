# WhatsApp Bot Dashboard 🤖

A self-hosted web dashboard for managing multiple WhatsApp numbers with keyword-triggered auto-responses. Built with Node.js + Express + Baileys (no browser required).

## Features

- 🔐 **Login / password auth** — secure admin panel
- 📱 **Multiple WhatsApp numbers** — each number runs independently
- 📦 **Product management** — add products with keywords, messages, and media
- 📎 **File uploads** — videos, images, and audio sent to customers automatically
- ⚡ **Real-time QR code** — scan directly from the dashboard
- 📋 **Live activity logs** — see every incoming message and response
- 🔄 **Auto-reconnect** — bots reconnect automatically on disconnect

## Quick Start

### 1. Install dependencies

```bash
cd whatsapp-dashboard
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env and set SESSION_SECRET to a long random string
```

### 3. Create admin account

```bash
node setup.js
```
Enter your username and password when prompted.

### 4. Start the server

```bash
npm start
```

### 5. Open the dashboard

Go to **http://localhost:3000** in your browser and log in.

---

## Adding a WhatsApp Number

1. Click **"+ Add Number"** in the sidebar
2. Enter a display name (e.g. "Customer Service")
3. Click **"Create & Connect"**
4. A QR code will appear in the dashboard — scan it with WhatsApp:
   - Open WhatsApp on your phone
   - Settings → Linked Devices → Link a Device
   - Scan the QR code
5. The bot is now connected! ✅

---

## Adding Products

1. Select a bot from the sidebar
2. Click **"+ Add Product"**
3. Fill in:
   - **Product Name** — e.g. "Sanya X1000"
   - **Keywords** — type a keyword and press Enter (e.g. `sanya`, `buy`, `info`)
   - **First Message** — text sent before any media
   - **Last Message** — text sent after all media
4. Click **Save Product**
5. Click **✏️ Edit** on the product to upload media files

### How keywords work

When a customer sends a message, the bot checks if the message contains **any** of the product's keywords (case-insensitive). If a match is found, the bot automatically sends:
1. First message (text)
2. All media files (videos → images → audio)
3. Last message (text)

---

## Deploy to a Server (VPS)

### Using PM2

```bash
npm install -g pm2
pm2 start server.js --name whatsapp-dashboard
pm2 save
pm2 startup
```

### Using systemd

Create `/etc/systemd/system/whatsapp-dashboard.service`:

```ini
[Unit]
Description=WhatsApp Bot Dashboard
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/path/to/whatsapp-dashboard
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Then:
```bash
systemctl enable whatsapp-dashboard
systemctl start whatsapp-dashboard
```

### Nginx reverse proxy (HTTPS)

```nginx
server {
    listen 80;
    server_name yourdomain.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        
        # Required for SSE (live logs/QR)
        proxy_buffering off;
        proxy_read_timeout 86400;
    }
}
```

Use **Certbot** to add HTTPS:
```bash
certbot --nginx -d yourdomain.com
```

---

## File Structure

```
whatsapp-dashboard/
├── server.js          # Express server + API routes
├── bot-manager.js     # Baileys multi-bot + SSE events
├── database.js        # SQLite schema + helpers
├── setup.js           # First-run admin setup wizard
├── package.json
├── .env.example
├── data/
│   └── app.db         # SQLite database (auto-created)
├── auth/
│   └── bot_xxx/       # Per-bot session files (auto-created)
└── public/
    ├── index.html     # Dashboard SPA
    └── uploads/       # Uploaded media files (auto-created)
```

---

## GitHub

This project is ready to push to GitHub. Recommended `.gitignore`:

```gitignore
node_modules/
data/
auth/
public/uploads/
.env
*.log
```

---

## Support

- Bots use **@whiskeysockets/baileys** — pure WebSocket, no browser needed
- Works with both `@c.us` and `@lid` WhatsApp contact formats
- Session is saved in `./auth/` — delete to force a new QR scan
- Logs are stored in SQLite and displayed live in the dashboard

'use strict';
require('dotenv').config();

const express        = require('express');
const session        = require('express-session');
const bcrypt         = require('bcryptjs');
const multer         = require('multer');
const path           = require('path');
const fs             = require('fs');
const crypto         = require('crypto');

const db         = require('./database');
const botManager = require('./bot-manager');

const app  = express();
const PORT = process.env.PORT || 3000;

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Multer ────────────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, crypto.randomBytes(16).toString('hex') + ext);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
    fileFilter: (_req, file, cb) => {
        const allowed = /\.(mp4|mov|avi|jpg|jpeg|png|gif|webp|ogg|mp3|m4a|wav)$/i;
        cb(null, allowed.test(path.extname(file.originalname)));
    },
});

// ── Middleware ─────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET || 'whatsapp-dashboard-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 7 * 24 * 3600 * 1000 },
}));

// ── Auth guard ─────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
    if (req.session?.userId) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ── Auth routes ────────────────────────────────────────────────────────────────

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

    const user = db.getUserByUsername(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    req.session.userId   = user.id;
    req.session.username = user.username;
    res.json({ ok: true, username: user.username });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
    res.json({ username: req.session.username });
});

app.post('/api/change-password', requireAuth, async (req, res) => {
    const { current, newPassword } = req.body;
    if (!current || !newPassword) return res.status(400).json({ error: 'Missing fields' });

    const user = db.getUserByUsername(req.session.username);
    const ok = await bcrypt.compare(current, user.password);
    if (!ok) return res.status(401).json({ error: 'Current password wrong' });

    const hash = await bcrypt.hash(newPassword, 12);
    db.updatePassword(user.id, hash);
    res.json({ ok: true });
});

// ── SSE ────────────────────────────────────────────────────────────────────────

app.get('/api/events', requireAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(': connected\n\n');

    const removeSse = botManager.addSseClient(res);
    req.on('close', removeSse);

    // Heartbeat
    const hb = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch(_) { clearInterval(hb); }
    }, 25000);
    req.on('close', () => clearInterval(hb));
});

// ── Bot routes ─────────────────────────────────────────────────────────────────

app.get('/api/bots', requireAuth, (_req, res) => {
    const bots = db.getAllBots().map(b => ({
        ...b,
        ...botManager.getBotStatus(b.id),
    }));
    res.json(bots);
});

app.post('/api/bots', requireAuth, async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const authFolder = 'bot_' + crypto.randomBytes(8).toString('hex');
    const result = db.createBot(name.trim(), authFolder);
    const bot = db.getBotById(result.lastInsertRowid);
    res.json(bot);
});

app.patch('/api/bots/:id', requireAuth, (req, res) => {
    const bot = db.getBotById(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    if (req.body.name) db.updateBotName(bot.id, req.body.name.trim());
    res.json(db.getBotById(bot.id));
});

app.delete('/api/bots/:id', requireAuth, async (req, res) => {
    const bot = db.getBotById(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    await botManager.stopBot(bot.id).catch(() => {});
    db.deleteBot(bot.id);
    botManager.deleteAuth(bot.auth_folder);
    res.json({ ok: true });
});

app.post('/api/bots/:id/start', requireAuth, async (req, res) => {
    const bot = db.getBotById(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    try {
        await botManager.startBot(bot.id);
        res.json({ ok: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/bots/:id/stop', requireAuth, async (req, res) => {
    const bot = db.getBotById(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    await botManager.stopBot(bot.id).catch(() => {});
    res.json({ ok: true });
});

app.post('/api/bots/:id/reset-auth', requireAuth, async (req, res) => {
    const bot = db.getBotById(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    await botManager.stopBot(bot.id).catch(() => {});
    botManager.deleteAuth(bot.auth_folder);
    db.updateBotStatus(bot.id, 'disconnected', null);
    res.json({ ok: true });
});

// ── Product routes ─────────────────────────────────────────────────────────────

app.get('/api/bots/:botId/products', requireAuth, (req, res) => {
    const products = db.getProductsByBot(req.params.botId).map(p => ({
        ...p,
        keywords:      JSON.parse(p.keywords || '[]'),
        multi_keywords: JSON.parse(p.multi_keywords || '[]'),
        media: db.getMediaByProduct(p.id),
    }));
    res.json(products);
});

app.post('/api/bots/:botId/products', requireAuth, (req, res) => {
    const { name, keywords, multi_keywords, first_message, last_message } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const kw  = Array.isArray(keywords)       ? keywords       : (keywords ? [keywords] : []);
    const mkw = Array.isArray(multi_keywords) ? multi_keywords : [];

    const result = db.createProduct(
        req.params.botId, name.trim(), kw, mkw,
        first_message || '', last_message || ''
    );
    const product = {
        ...db.getProductById(result.lastInsertRowid),
        keywords: kw,
        multi_keywords: mkw,
        media: [],
    };
    res.json(product);
});

app.put('/api/products/:id', requireAuth, (req, res) => {
    const p = db.getProductById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });

    const { name, keywords, multi_keywords, first_message, last_message, active } = req.body;
    const kw  = Array.isArray(keywords)       ? keywords       : JSON.parse(p.keywords || '[]');
    const mkw = Array.isArray(multi_keywords) ? multi_keywords : JSON.parse(p.multi_keywords || '[]');

    db.updateProduct(p.id, name || p.name, kw, mkw,
        first_message ?? p.first_message, last_message ?? p.last_message,
        active !== undefined ? active : p.active);

    res.json({ ...db.getProductById(p.id), keywords: kw, multi_keywords: mkw });
});

app.delete('/api/products/:id', requireAuth, (req, res) => {
    const p = db.getProductById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });

    // Delete media files from disk
    const mediaFiles = db.getMediaByProduct(p.id);
    for (const mf of mediaFiles) {
        const fp = path.join(UPLOADS_DIR, mf.filename);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }

    db.deleteProduct(p.id);
    res.json({ ok: true });
});

// ── Media upload routes ────────────────────────────────────────────────────────

app.post('/api/products/:id/media', requireAuth, upload.array('files', 20), (req, res) => {
    const p = db.getProductById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Product not found' });

    const existingCount = db.getMediaByProduct(p.id).length;
    const results = [];

    for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];
        const ext  = path.extname(file.originalname).toLowerCase();
        let mediaType = 'image';
        if (/\.(mp4|mov|avi)$/.test(ext)) mediaType = 'video';
        else if (/\.(ogg|mp3|m4a|wav)$/.test(ext)) mediaType = 'audio';

        const result = db.addMedia(p.id, file.filename, file.originalname, mediaType, existingCount + i);
        results.push({
            id: result.lastInsertRowid,
            filename: file.filename,
            original_name: file.originalname,
            media_type: mediaType,
            sort_order: existingCount + i,
        });
    }

    res.json(results);
});

app.delete('/api/media/:id', requireAuth, (req, res) => {
    const mf = db.getMediaById(req.params.id);
    if (!mf) return res.status(404).json({ error: 'Not found' });

    const fp = path.join(UPLOADS_DIR, mf.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);

    db.deleteMedia(mf.id);
    res.json({ ok: true });
});

// ── Logs routes ────────────────────────────────────────────────────────────────

app.get('/api/logs', requireAuth, (req, res) => {
    const botId = req.query.botId ? Number(req.query.botId) : null;
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    res.json(db.getRecentLogs(botId, limit));
});

// ── Start server ───────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
    console.log(`\n🚀 WhatsApp Dashboard running at http://localhost:${PORT}`);
    if (db.countUsers() === 0) {
        console.log('⚠️  No admin account found. Run: node setup.js\n');
    }
    await botManager.autoStart().catch(console.error);
});

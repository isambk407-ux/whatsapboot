'use strict';
/**
 * BotManager — runs one Baileys socket per WhatsApp number.
 * Emits SSE events so the dashboard updates in real time.
 */

const path = require('path');
const fs   = require('fs');
const db   = require('./database');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'public', 'uploads');

// Map of botId → { sock, status, qr, phone, stopping }
const bots = new Map();

// SSE clients: array of res objects
const sseClients = [];

// ── SSE ───────────────────────────────────────────────────────────────────────

function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
        try { res.write(payload); } catch (_) {}
    }
}

function addSseClient(res) {
    sseClients.push(res);
    // Send current state for all running bots
    for (const [botId, state] of bots) {
        res.write(`event: status\ndata: ${JSON.stringify({ botId, status: state.status, phone: state.phone, qr: state.qr })}\n\n`);
    }
    return () => {
        const idx = sseClients.indexOf(res);
        if (idx !== -1) sseClients.splice(idx, 1);
    };
}

// ── Keyword matching ──────────────────────────────────────────────────────────

function matchProduct(text, botId) {
    const products = db.getProductsByBot(botId);
    const t = text.toLowerCase().trim();

    for (const p of products) {
        if (!p.active) continue;
        let keywords = [];
        let multiKeywords = [];
        try { keywords = JSON.parse(p.keywords || '[]'); } catch (_) {}
        try { multiKeywords = JSON.parse(p.multi_keywords || '[]'); } catch (_) {}

        if (keywords.some(k => k && t.includes(k.toLowerCase()))) return p;
        if (multiKeywords.some(g => Array.isArray(g) && g.every(w => w && t.includes(w.toLowerCase())))) return p;
    }
    return null;
}

// ── Media sending ─────────────────────────────────────────────────────────────

const sending = new Set(); // jid-keys to prevent double-send

const delay = ms => new Promise(r => setTimeout(r, ms));
const rand  = (a, b) => delay(a + Math.floor(Math.random() * (b - a)));

function getMime(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return {
        '.mp4':  'video/mp4',
        '.mov':  'video/quicktime',
        '.avi':  'video/x-msvideo',
        '.jpg':  'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png':  'image/png',
        '.gif':  'image/gif',
        '.webp': 'image/webp',
        '.ogg':  'audio/ogg; codecs=opus',
        '.mp3':  'audio/mpeg',
        '.m4a':  'audio/mp4',
        '.wav':  'audio/wav',
    }[ext] || 'application/octet-stream';
}

async function sendProduct(sock, jid, product, botId) {
    const key = `${botId}:${jid}`;
    if (sending.has(key)) return;
    sending.add(key);

    try {
        // First message
        if (product.first_message) {
            await rand(800, 1500);
            await sock.sendMessage(jid, { text: product.first_message });
        }

        // Media files in sort order
        const mediaFiles = db.getMediaByProduct(product.id);
        for (const mf of mediaFiles) {
            await rand(1200, 2200);
            const fullPath = path.join(UPLOADS_DIR, mf.filename);
            if (!fs.existsSync(fullPath)) {
                log(botId, jid, product.id, `⚠️ Media file missing: ${mf.filename}`, 'warn');
                continue;
            }
            try {
                const buffer = fs.readFileSync(fullPath);
                const mime   = getMime(fullPath);
                let content;
                if      (mf.media_type === 'video') content = { video: buffer, mimetype: mime, caption: '' };
                else if (mf.media_type === 'image') content = { image: buffer, mimetype: mime, caption: '' };
                else if (mf.media_type === 'audio') content = { audio: buffer, mimetype: mime, ptt: true };
                if (content) {
                    await sock.sendMessage(jid, content);
                    log(botId, jid, product.id, `📤 Sent ${mf.media_type}: ${mf.original_name}`, 'info');
                }
            } catch(e) {
                log(botId, jid, product.id, `⚠️ Failed to send ${mf.original_name}: ${e.message?.slice(0, 80)}`, 'warn');
            }
        }

        // Last message
        if (product.last_message) {
            await rand(1000, 2000);
            await sock.sendMessage(jid, { text: product.last_message });
        }

        log(botId, jid, product.id, `✅ Done sending product "${product.name}" to ${jid}`, 'info');
    } catch(e) {
        log(botId, jid, product.id, `❌ sendProduct error: ${e.message}`, 'error');
    } finally {
        sending.delete(key);
    }
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(botId, jid, productId, message, level) {
    db.addLog(botId, jid, productId, message, level || 'info');
    broadcast('log', { botId, jid, productId, message, level: level || 'info', time: new Date().toISOString() });
}

// ── Start / Stop ──────────────────────────────────────────────────────────────

async function startBot(botId) {
    const botRow = db.getBotById(botId);
    if (!botRow) throw new Error('Bot not found: ' + botId);

    if (bots.get(botId)?.status === 'connected') return; // already running

    // Mark as connecting
    bots.set(botId, { sock: null, status: 'connecting', qr: null, phone: botRow.phone });
    db.updateBotStatus(botId, 'connecting', botRow.phone);
    broadcast('status', { botId, status: 'connecting', phone: botRow.phone, qr: null });

    let {
        default: makeWASocket,
        useMultiFileAuthState,
        DisconnectReason,
        Browsers,
        makeCacheableSignalKeyStore,
        fetchLatestBaileysVersion,
    } = await import('@whiskeysockets/baileys');

    const { default: pino } = await import('pino');
    const logger = pino({ level: 'silent' });

    const authDir = path.join(__dirname, 'auth', botRow.auth_folder);
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys:  makeCacheableSignalKeyStore(state.keys, logger),
        },
        printQRInTerminal: false,  // We send QR via SSE to the dashboard
        logger,
        browser: Browsers.macOS('Desktop'),
        defaultQueryTimeoutMs: 60_000,
        connectTimeoutMs:      60_000,
        retryRequestDelayMs:   2_000,
        maxMsgRetryCount: 3,
        generateHighQualityLinkPreview: false,
    });

    bots.set(botId, { sock, status: 'connecting', qr: null, phone: botRow.phone });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr: qrString }) => {
        const state = bots.get(botId);
        if (!state) return;

        if (qrString) {
            // Convert QR string to data URL
            let qrDataUrl = null;
            try {
                const QRCode = require('qrcode');
                qrDataUrl = await QRCode.toDataURL(qrString);
            } catch(e) {
                qrDataUrl = qrString; // fallback: raw string
            }
            state.qr = qrDataUrl;
            state.status = 'qr';
            db.updateBotStatus(botId, 'qr', null);
            broadcast('status', { botId, status: 'qr', qr: qrDataUrl, phone: null });
            log(botId, null, null, '📱 QR code ready — scan with WhatsApp', 'info');
        }

        if (connection === 'open') {
            const phone = sock.user?.id?.split(':')[0] || sock.user?.id || null;
            state.status = 'connected';
            state.qr     = null;
            state.phone  = phone;
            db.updateBotStatus(botId, 'connected', phone);
            broadcast('status', { botId, status: 'connected', phone, qr: null });
            log(botId, null, null, `🟢 Connected as ${phone || 'unknown'}`, 'info');
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            state.status = 'disconnected';
            state.qr     = null;
            db.updateBotStatus(botId, 'disconnected', state.phone);
            broadcast('status', { botId, status: 'disconnected', phone: state.phone, qr: null });

            if (code === DisconnectReason.loggedOut) {
                log(botId, null, null, '❌ Logged out. Delete auth and re-scan QR.', 'error');
                bots.delete(botId);
                return;
            }

            if (state.stopping) {
                log(botId, null, null, '⏹️ Bot stopped by user', 'info');
                bots.delete(botId);
                return;
            }

            log(botId, null, null, `🔄 Disconnected (code ${code || '?'}) — reconnecting in 5 s...`, 'warn');
            setTimeout(() => startBot(botId).catch(console.error), 5000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            const jid = msg.key.remoteJid;
            if (!jid || jid.endsWith('@g.us')) continue;

            const text = (
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                msg.message?.videoMessage?.caption || ''
            ).trim();

            if (!text) continue;

            log(botId, jid, null, `📨 Message from ${jid}: "${text.slice(0, 60)}"`, 'info');

            const product = matchProduct(text, botId);
            if (!product) {
                log(botId, jid, null, '❓ No product match', 'info');
                continue;
            }

            log(botId, jid, product.id, `✅ Matched product: ${product.name}`, 'info');
            sendProduct(sock, jid, product, botId).catch(console.error);
        }
    });
}

async function stopBot(botId) {
    const state = bots.get(botId);
    if (!state) return;
    state.stopping = true;
    try {
        await state.sock?.logout();
    } catch(_) {}
    try {
        await state.sock?.end();
    } catch(_) {}
    bots.delete(botId);
    db.updateBotStatus(botId, 'disconnected', state.phone);
    broadcast('status', { botId, status: 'disconnected', phone: state.phone, qr: null });
}

function getBotStatus(botId) {
    const s = bots.get(botId);
    if (!s) return { status: 'stopped', qr: null, phone: null };
    return { status: s.status, qr: s.qr, phone: s.phone };
}

function deleteAuth(authFolder) {
    const authDir = path.join(__dirname, 'auth', authFolder);
    if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
    }
}

// ── Auto-start all 'connected' bots on server startup ─────────────────────────

async function autoStart() {
    const allBots = db.getAllBots();
    for (const bot of allBots) {
        if (bot.status === 'connected' || bot.status === 'connecting') {
            try {
                await startBot(bot.id);
            } catch(e) {
                console.error(`Failed to auto-start bot ${bot.id}: ${e.message}`);
            }
        }
    }
}

module.exports = { startBot, stopBot, getBotStatus, deleteAuth, addSseClient, broadcast, autoStart, log };

'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    username  TEXT    NOT NULL UNIQUE,
    password  TEXT    NOT NULL,
    created_at TEXT   DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    phone       TEXT,
    status      TEXT    DEFAULT 'disconnected',
    auth_folder TEXT    NOT NULL UNIQUE,
    created_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id        INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    name          TEXT    NOT NULL,
    keywords      TEXT    NOT NULL DEFAULT '[]',
    multi_keywords TEXT   NOT NULL DEFAULT '[]',
    first_message TEXT    NOT NULL DEFAULT '',
    last_message  TEXT    NOT NULL DEFAULT '',
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS media_files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    filename    TEXT    NOT NULL,
    original_name TEXT  NOT NULL,
    media_type  TEXT    NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id      INTEGER REFERENCES bots(id) ON DELETE SET NULL,
    jid         TEXT,
    product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
    message     TEXT    NOT NULL,
    level       TEXT    NOT NULL DEFAULT 'info',
    created_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_logs_bot    ON logs(bot_id);
  CREATE INDEX IF NOT EXISTS idx_logs_time   ON logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_media_prod  ON media_files(product_id);
`);

// ── Helpers ───────────────────────────────────────────────────────────────────

module.exports = {
    db,

    // Users
    createUser(username, passwordHash) {
        return db.prepare('INSERT INTO users (username,password) VALUES (?,?)').run(username, passwordHash);
    },
    getUserByUsername(username) {
        return db.prepare('SELECT * FROM users WHERE username=?').get(username);
    },
    countUsers() {
        return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    },
    updatePassword(userId, passwordHash) {
        return db.prepare('UPDATE users SET password=? WHERE id=?').run(passwordHash, userId);
    },

    // Bots
    createBot(name, authFolder) {
        return db.prepare('INSERT INTO bots (name,auth_folder) VALUES (?,?)').run(name, authFolder);
    },
    getAllBots() {
        return db.prepare('SELECT * FROM bots ORDER BY created_at').all();
    },
    getBotById(id) {
        return db.prepare('SELECT * FROM bots WHERE id=?').get(id);
    },
    updateBotStatus(id, status, phone) {
        return db.prepare('UPDATE bots SET status=?, phone=? WHERE id=?').run(status, phone || null, id);
    },
    updateBotName(id, name) {
        return db.prepare('UPDATE bots SET name=? WHERE id=?').run(name, id);
    },
    deleteBot(id) {
        return db.prepare('DELETE FROM bots WHERE id=?').run(id);
    },

    // Products
    createProduct(botId, name, keywords, multiKeywords, firstMessage, lastMessage) {
        return db.prepare(`
            INSERT INTO products (bot_id,name,keywords,multi_keywords,first_message,last_message)
            VALUES (?,?,?,?,?,?)
        `).run(botId, name, JSON.stringify(keywords || []), JSON.stringify(multiKeywords || []), firstMessage || '', lastMessage || '');
    },
    getProductsByBot(botId) {
        return db.prepare('SELECT * FROM products WHERE bot_id=? ORDER BY created_at').all(botId);
    },
    getProductById(id) {
        return db.prepare('SELECT * FROM products WHERE id=?').get(id);
    },
    updateProduct(id, name, keywords, multiKeywords, firstMessage, lastMessage, active) {
        return db.prepare(`
            UPDATE products SET name=?,keywords=?,multi_keywords=?,first_message=?,last_message=?,active=?
            WHERE id=?
        `).run(name, JSON.stringify(keywords || []), JSON.stringify(multiKeywords || []), firstMessage || '', lastMessage || '', active ? 1 : 0, id);
    },
    deleteProduct(id) {
        return db.prepare('DELETE FROM products WHERE id=?').run(id);
    },

    // Media
    addMedia(productId, filename, originalName, mediaType, sortOrder) {
        return db.prepare(`
            INSERT INTO media_files (product_id,filename,original_name,media_type,sort_order)
            VALUES (?,?,?,?,?)
        `).run(productId, filename, originalName, mediaType, sortOrder || 0);
    },
    getMediaByProduct(productId) {
        return db.prepare('SELECT * FROM media_files WHERE product_id=? ORDER BY sort_order,id').all(productId);
    },
    deleteMedia(id) {
        return db.prepare('DELETE FROM media_files WHERE id=?').get(id);
    },
    getMediaById(id) {
        return db.prepare('SELECT * FROM media_files WHERE id=?').get(id);
    },

    // Logs
    addLog(botId, jid, productId, message, level) {
        return db.prepare(`
            INSERT INTO logs (bot_id,jid,product_id,message,level) VALUES (?,?,?,?,?)
        `).run(botId || null, jid || null, productId || null, message, level || 'info');
    },
    getRecentLogs(botId, limit) {
        if (botId) {
            return db.prepare('SELECT * FROM logs WHERE bot_id=? ORDER BY created_at DESC LIMIT ?').all(botId, limit || 100);
        }
        return db.prepare('SELECT * FROM logs ORDER BY created_at DESC LIMIT ?').all(limit || 100);
    },
    clearOldLogs() {
        // Keep last 500 logs per bot
        db.prepare(`
            DELETE FROM logs WHERE id NOT IN (
                SELECT id FROM logs ORDER BY created_at DESC LIMIT 500
            )
        `).run();
    },
};

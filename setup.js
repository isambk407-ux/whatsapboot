#!/usr/bin/env node
'use strict';
/**
 * One-time setup: create the first admin account.
 * Run: node setup.js
 */
require('dotenv').config();
const readline = require('readline');
const bcrypt   = require('bcryptjs');
const db       = require('./database');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, r));

async function main() {
    console.log('\n╔═══════════════════════════════════════╗');
    console.log('║   WhatsApp Dashboard — First Setup    ║');
    console.log('╚═══════════════════════════════════════╝\n');

    if (db.countUsers() > 0) {
        const proceed = await ask('⚠️  An admin account already exists. Create another? [y/N] ');
        if (!proceed.toLowerCase().startsWith('y')) {
            console.log('Aborted.\n');
            process.exit(0);
        }
    }

    const username = (await ask('Username: ')).trim();
    if (!username) { console.error('Username cannot be empty.'); process.exit(1); }

    const password = (await ask('Password: ')).trim();
    if (password.length < 6) { console.error('Password must be at least 6 characters.'); process.exit(1); }

    const confirm = (await ask('Confirm password: ')).trim();
    if (password !== confirm) { console.error('Passwords do not match.'); process.exit(1); }

    const hash = await bcrypt.hash(password, 12);
    db.createUser(username, hash);

    console.log('\n✅ Admin account created!');
    console.log('   Start the server: npm start');
    console.log('   Then open:        http://localhost:3000\n');
    rl.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });

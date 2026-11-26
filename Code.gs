/**
 * Nutrilaben – stockage des commandes dans Google Sheets
 * Colle ce code dans Extensions > Apps Script du Google Sheet,
 * puis Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 */

var SHEET_NAME = 'Commandes';

var HEADERS = [
  'Date', 'Nom', 'Téléphone', 'Adresse', 'Pack', 'Prix (zł)', 'Statut',
  'adid', 'adsetid', 'campaignid', 'adname', 'adsetname', 'fbclid', 'Page'
];

var PRICES = { '1': 149, '3': 298, '5': 447 };
var PACK_LABELS = { '1': '1 opakowanie', '3': '2 + 1 GRATIS', '5': '3 + 2 GRATIS' };

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var p = (e && e.parameter) || {};

    // Anti-spam : champ caché rempli = bot
    if (p.website) return json({ ok: true });

    var name = clean(p.name), phone = clean(p.phone), address = clean(p.address);
    if (!name || !phone || !address) return json({ ok: false, error: 'missing_fields' });

    var pack = PRICES[p.pack] ? p.pack : '3';
    var sheet = getSheet();

    sheet.appendRow([
      new Date(), name, phone, address, PACK_LABELS[pack], PRICES[pack], 'Nouveau',
      clean(p.adid), clean(p.adsetid), clean(p.campaignid),
      clean(p.adname), clean(p.adsetname), clean(p.fbclid), clean(p.page)
    ]);

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// Test rapide : ouvre l'URL du Web App dans le navigateur, tu dois voir {"ok":true,"status":"running"}
function doGet() {
  return json({ ok: true, status: 'running' });
}

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#111827').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    // Liste déroulante pour la colonne Statut
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['Nouveau', 'Confirmé', 'Pas de réponse', 'Annulé', 'Expédié', 'Livré', 'Retour'], true)
      .build();
    sheet.getRange('G2:G').setDataValidation(rule);
  }
  return sheet;
}

// Nettoie la valeur et bloque l'injection de formules (=, +, -, @)
function clean(v) {
  v = String(v == null ? '' : v).trim().slice(0, 500);
  if (/^[=+\-@]/.test(v)) v = "'" + v;
  return v;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

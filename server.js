const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

const OHME_BASE          = (process.env.OHME_BASE_URL || '').replace(/\/$/, '');
const OHME_CLIENT_NAME   = process.env.OHME_CLIENT_NAME;
const OHME_CLIENT_SECRET = process.env.OHME_CLIENT_SECRET;
const UPSTASH_URL        = (process.env.UPSTASH_REDIS_REST_URL  || '').replace(/\/$/, '');
const UPSTASH_TOKEN      = process.env.UPSTASH_REDIS_REST_TOKEN || '';

if (!OHME_CLIENT_NAME || !OHME_CLIENT_SECRET || !OHME_BASE) {
  console.error('OHME_BASE_URL, OHME_CLIENT_NAME et OHME_CLIENT_SECRET sont requis.');
  process.exit(1);
}

app.use(cors({ origin: process.env.FRONTEND_URL || '*', methods: ['GET'] }));

const HEADERS = {
  'Accept':        'application/json',
  'client-name':   OHME_CLIENT_NAME,
  'client-secret': OHME_CLIENT_SECRET,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const DELAY = 2000;
const REDIS_KEY     = 'defi_enfance_dossards_v2';
const REDIS_TTL_SEC = 6 * 60 * 60;

// ── Redis Upstash REST API
async function redisGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.result === null || json.result === undefined) return null;
    return json.result;
  } catch (e) { console.error('Redis GET error:', e.message); return null; }
}

async function redisSet(key, value, ttlSec) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
  try {
    // Upstash REST: POST /set/key/value?ex=ttl
    const res = await fetch(
      `${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}?ex=${ttlSec}`,
      {
        method:  'GET',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      }
    );
    return res.ok;
  } catch (e) { console.error('Redis SET error:', e.message); return false; }
}

async function redisDel(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
      method:  'GET',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
  } catch {}
}

// ── Ohme
async function fetchAllPayments() {
  const all = [];
  let cursor = null;
  while (true) {
    await sleep(DELAY);
    // Pas de filtre payment_type_id — on prend tous les paiements et on filtre côté serveur
    const url = cursor
      ? `${OHME_BASE}/api/v1/payments?limit=250&since_date=2025-01-01&cursor=${encodeURIComponent(cursor)}`
      : `${OHME_BASE}/api/v1/payments?limit=250&since_date=2025-01-01`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`Payments Ohme ${res.status}`);
    const json = await res.json();
    const items = json.data || [];
    all.push(...items);
    cursor = json.cursor || null;
    if (!cursor || items.length < 250) break;
  }
  return all;
}

async function fetchContactById(contactId, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    await sleep(DELAY * attempt); // délai croissant : 500ms, 1000ms, 1500ms
    try {
      const res = await fetch(`${OHME_BASE}/api/v1/contacts/${contactId}`, { headers: HEADERS });
      if (res.status === 429) {
        console.log(`Rate limit contact ${contactId} — attente 10s (tentative ${attempt}/${retries})`);
        await sleep(30000);
        continue;
      }
      if (!res.ok) {
        console.log(`Contact ${contactId} erreur ${res.status} — tentative ${attempt}/${retries}`);
        continue;
      }
      const json = await res.json();
      return json.data || json;
    } catch (e) {
      console.log(`Contact ${contactId} exception : ${e.message}`);
    }
  }
  console.log(`Contact ${contactId} abandonné après ${retries} tentatives.`);
  return null;
}

async function loadFromOhme() {
  // Verrou Redis anti-instances-parallèles
  const lockKey = 'defi_enfance_dossards_lock';
  const lockVal = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const existing = await redisGet(lockKey);
  if (existing) {
    console.log('Chargement déjà en cours sur une autre instance — abandon.');
    return null; // retourne null pour signaler qu'on n'a pas chargé
  }
  // Poser le verrou (expire dans 10 min)
  await redisSet(lockKey, lockVal, 600);

  console.log('Chargement des paiements Ohme...');
  const rawPayments = await fetchAllPayments();
  console.log(`${rawPayments.length} paiements récupérés.`);

  const contactIds = new Map();
  for (const p of rawPayments) {
    if (!p.contact_id) continue;
    const eventName = (p.nom_de_levent || '').toUpperCase();
    if (!eventName.includes('ANGERS')) continue;
    const qualite = (p.qualite_du_participant || '').toLowerCase();
    if (qualite === 'don attendu' || qualite === 'exclu') continue;
    // Garder uniquement les paiements avec une équipe OU une asso soutenue (= coureurs inscrits)
    const equipe = (p.equipe || '').trim();
    const asso   = (p.asso_soutenue || '').trim();
    if (!equipe && !asso) continue;
    const id = String(p.contact_id);
    if (!contactIds.has(id)) contactIds.set(id, p);
  }

  console.log(`${contactIds.size} coureurs Angers — chargement individuel...`);

  const coureurs = [];
  let i = 0;
  for (const [contactId, paiement] of contactIds) {
    i++;
    if (i % 50 === 0) console.log(`Progression : ${i}/${contactIds.size}...`);

    const contact = await fetchContactById(contactId);
    if (!contact) continue;

    const dossard = contact.numero_dossard_angers_2026 ?? null;
    if (dossard === null || dossard === undefined || dossard === '' || dossard === 0) continue;

    coureurs.push({
      id:      contactId,
      prenom:  contact.firstname || '',
      nom:     contact.lastname  || '',
      dossard: dossard,
      equipe:  (() => { const e = (paiement.equipe || '').trim(); return (!e || e.toLowerCase() === 'je cours solo') ? null : e; })(),
    });
  }

  console.log(`${coureurs.length} coureurs avec dossard chargés depuis Ohme.`);
  // Libérer le verrou Redis
  await redisDel('defi_enfance_dossards_lock');
  return coureurs;
}

// ── Cache mémoire + Redis
let _memCache     = null;
let _memCacheTime = 0;
const MEM_TTL  = 5 * 60 * 1000;
let _loading   = false; // verrou anti-chargements parallèles
let _loadingP  = null;  // promesse partagée

async function getData() {
  // 1. Cache mémoire (5 min)
  if (_memCache && Date.now() - _memCacheTime < MEM_TTL) return _memCache;

  // 2. Redis uniquement — jamais d'appel Ohme automatique
  const raw = await redisGet(REDIS_KEY);
  if (raw) {
    try {
      const coureurs = JSON.parse(raw);
      if (Array.isArray(coureurs) && coureurs.length > 0) {
        console.log(`${coureurs.length} coureurs chargés depuis Redis.`);
        _memCache     = coureurs;
        _memCacheTime = Date.now();
        return coureurs;
      }
    } catch (e) { console.log('Redis parse error:', e.message); }
  }

  // Redis vide — retourner tableau vide, ne jamais appeler Ohme automatiquement
  // Utiliser /api/seed ou /api/refresh pour charger les données
  console.log('Redis vide — utilisez /api/seed pour charger les données.');
  return [];
}

async function saveToRedis_key(key, str, ttlSec) {
  try {
    const res = await fetch(`${UPSTASH_URL}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        ['SET', key, str, 'EX', ttlSec],
      ]),
    });
    const ok = res.ok;
    console.log(`Sauvegarde Redis [${key}] : ${ok ? 'OK' : 'échec'}`);
    return ok;
  } catch (e) {
    console.error(`Redis pipeline error [${key}]:`, e.message);
    return false;
  }
}

async function saveToRedis(coureurs) {
  const str = JSON.stringify(coureurs);
  // Upstash a une limite sur les URLs — on utilise l'API pipeline pour les gros payloads
  try {
    const res = await fetch(`${UPSTASH_URL}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        ['SET', REDIS_KEY, str, 'EX', REDIS_TTL_SEC],
      ]),
    });
    const ok = res.ok;
    console.log(`Sauvegarde Redis pipeline : ${ok ? 'OK' : 'échec'}`);
    return ok;
  } catch (e) {
    console.error('Redis pipeline error:', e.message);
    return false;
  }
}

// ── Routes
app.get('/health', (_, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
);

app.get('/api/search', async (req, res) => {
  try {
    const { q, type } = req.query;
    if (!q || q.trim().length < 2)
      return res.status(400).json({ error: 'Au moins 2 caractères requis.' });

    const term     = q.trim().toLowerCase();
    const coureurs = await getData();
    let results    = [];

    if (type === 'equipe') {
      results = coureurs
        .filter(c => c.equipe && c.equipe.toLowerCase() === term)
        .sort((a, b) => a.prenom.localeCompare(b.prenom, 'fr'));
    } else {
      results = coureurs
        .filter(c =>
          c.nom.toLowerCase().includes(term) ||
          c.prenom.toLowerCase().includes(term)
        )
        .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    }

    res.json({ results, count: results.length, query: q.trim(), type: type || 'nom' });

  } catch (err) {
    console.error('search error:', err.message);
    res.status(500).json({ error: 'Erreur serveur. Veuillez réessayer.' });
  }
});

app.get('/api/equipes', async (req, res) => {
  try {
    const coureurs = await getData();
    const equipes  = [
      ...new Set(coureurs.map(c => c.equipe).filter(Boolean))
    ].sort((a, b) => a.localeCompare(b, 'fr'));
    res.json({ equipes });
  } catch (err) {
    console.error('equipes error:', err.message);
    res.status(500).json({ error: 'Impossible de charger les équipes.' });
  }
});

// Complète Redis avec les coureurs manquants (sans tout recharger)
// Debug — stats par type de paiement pour les événements Angers
app.get('/api/debug-types', async (req, res) => {
  try {
    const all = [];
    let cursor = null;
    while (true) {
      await sleep(500);
      const url = cursor
        ? `${OHME_BASE}/api/v1/payments?limit=250&since_date=2025-01-01&cursor=${encodeURIComponent(cursor)}`
        : `${OHME_BASE}/api/v1/payments?limit=250&since_date=2025-01-01`;
      const r = await fetch(url, { headers: HEADERS });
      if (!r.ok) break;
      const json = await r.json();
      const items = json.data || [];
      all.push(...items);
      cursor = json.cursor || null;
      if (!cursor || items.length < 250) break;
    }

    // Filtrer sur Angers
    const angers = all.filter(p => (p.nom_de_levent || '').toUpperCase().includes('ANGERS'));

    // Stats par type
    const parType = {};
    for (const p of angers) {
      const t = p.payment_type_id;
      parType[t] = (parType[t] || 0) + 1;
    }

    // Contact IDs uniques par type
    const idsParType = {};
    for (const p of angers) {
      const t = p.payment_type_id;
      if (!idsParType[t]) idsParType[t] = new Set();
      if (p.contact_id) idsParType[t].add(String(p.contact_id));
    }
    const resumeIds = {};
    for (const [t, s] of Object.entries(idsParType)) resumeIds[t] = s.size;

    res.json({
      total_paiements_angers: angers.length,
      paiements_par_type: parType,
      contacts_uniques_par_type: resumeIds,
      exemples_noms_event: [...new Set(angers.map(p => p.nom_de_levent))].slice(0, 10),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/complete', async (req, res) => {
  if (_loading) {
    return res.json({ message: 'Chargement déjà en cours, patientez...', loading: true });
  }
  try {
    // Charger ce qui est déjà dans Redis
    const raw = await redisGet(REDIS_KEY);
    const dejaDans = raw ? JSON.parse(raw) : [];
    const dejaIds  = new Set(dejaDans.map(c => c.id));
    console.log(`${dejaDans.length} coureurs déjà dans Redis.`);

    // Charger les paiements pour trouver les IDs manquants
    const rawPayments = await fetchAllPayments();
    const contactIds  = new Map();
    for (const p of rawPayments) {
      if (!p.contact_id) continue;
      const eventName = (p.nom_de_levent || '').toUpperCase();
      if (!eventName.includes('ANGERS')) continue;
      const qualite = (p.qualite_du_participant || '').toLowerCase();
      if (qualite === 'don attendu' || qualite === 'exclu') continue;
      const id = String(p.contact_id);
      if (!dejaIds.has(id) && !contactIds.has(id)) contactIds.set(id, p);
    }

    console.log(`${contactIds.size} coureurs manquants à charger...`);
    if (contactIds.size === 0) {
      return res.json({ success: true, added: 0, total: dejaDans.length, message: 'Rien à compléter' });
    }

    _loading  = true;
    _loadingP = (async () => {
      try {
        const nouveaux = [];
        let i = 0;
        for (const [contactId, paiement] of contactIds) {
          i++;
          const contact = await fetchContactById(contactId);
          if (!contact) continue;
          const dossard = contact.numero_dossard_angers_2026 ?? null;
          if (!dossard || dossard === 0) continue;
          nouveaux.push({
            id:      contactId,
            prenom:  contact.firstname || '',
            nom:     contact.lastname  || '',
            dossard: dossard,
            equipe:  (() => { const e = (paiement.equipe || '').trim(); return (!e || e.toLowerCase() === 'je cours solo') ? null : e; })(),
          });
        }
        const tous = [...dejaDans, ...nouveaux];
        await saveToRedis(tous);
        _memCache     = tous;
        _memCacheTime = Date.now();
        console.log(`Complété : +${nouveaux.length} coureurs. Total : ${tous.length}`);
        return { added: nouveaux.length, total: tous.length };
      } finally {
        _loading  = false;
        _loadingP = null;
      }
    })();
    const result = await _loadingP;
    res.json({ success: true, ...result });
  } catch (err) {
    _loading  = false;
    _loadingP = null;
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/refresh', async (req, res) => {
  if (_loading) {
    return res.json({ message: 'Chargement déjà en cours, patientez...', loading: true });
  }
  try {
    console.log('Rechargement forcé depuis Ohme...');
    _memCache     = null;
    _memCacheTime = 0;
    await redisDel(REDIS_KEY);
    _loading  = true;
    _loadingP = (async () => {
      try {
        const coureurs = await loadFromOhme();
        await saveToRedis(coureurs);
        _memCache     = coureurs;
        _memCacheTime = Date.now();
        return coureurs;
      } finally {
        _loading  = false;
        _loadingP = null;
      }
    })();
    const coureurs = await _loadingP;
    res.json({ success: true, count: coureurs.length });
  } catch (err) {
    _loading  = false;
    _loadingP = null;
    res.status(500).json({ error: err.message });
  }
});


// Route seed — injecte les données Excel directement dans Redis
// Les IDs Excel sont préfixés "excel_" pour les distinguer des IDs Ohme
app.get('/api/seed', async (req, res) => {
  try {
    const COUREURS_EXCEL = [{"id": "excel_1", "prenom": "AAINA ANGE", "nom": "Le Picart", "dossard": 1, "equipe": "Ecole Saint Serge"}, {"id": "excel_2", "prenom": "Abla", "nom": "LAHROU", "dossard": 2, "equipe": "N.I.A.H."}, {"id": "excel_3", "prenom": "Adam", "nom": "Msolli", "dossard": 3, "equipe": "Ecole Saint Serge"}, {"id": "excel_4", "prenom": "Adélaïde", "nom": "RAMÉ", "dossard": 4, "equipe": "FSDV"}, {"id": "excel_5", "prenom": "Adélaïde", "nom": "Villemain", "dossard": 5, "equipe": "À Deux Mains"}, {"id": "excel_6", "prenom": "Adèle", "nom": "BERGEROT", "dossard": 6, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_7", "prenom": "Adrien", "nom": "(Colibri)", "dossard": 7, "equipe": "Colibri"}, {"id": "excel_8", "prenom": "Agathe", "nom": "COTINET", "dossard": 8, "equipe": "Becouze"}, {"id": "excel_9", "prenom": "Agathe", "nom": "Fournier", "dossard": 9, "equipe": "La cravate solidaire"}, {"id": "excel_10", "prenom": "Aïcha", "nom": "YATERA", "dossard": 10, "equipe": "Le Gouvernail"}, {"id": "excel_11", "prenom": "Alasdair", "nom": "MACKAY", "dossard": 11, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_12", "prenom": "Albane", "nom": "JUSTEAU", "dossard": 12, "equipe": "Le Gouvernail"}, {"id": "excel_13", "prenom": "Alexandre", "nom": "(Colibri)", "dossard": 13, "equipe": "Colibri"}, {"id": "excel_14", "prenom": "alexandre", "nom": "autin", "dossard": 14, "equipe": "6e Régiment du Génie d’Angers"}, {"id": "excel_15", "prenom": "Alexandre", "nom": "BIZON", "dossard": 15, "equipe": "Nameshield"}, {"id": "excel_16", "prenom": "Alexandre", "nom": "FABLET", "dossard": 16, "equipe": "AXA Prévoyance et Patrimoine"}, {"id": "excel_17", "prenom": "Alexandre", "nom": "MILLE", "dossard": 17, "equipe": "Nameshield"}, {"id": "excel_18", "prenom": "Alexiane", "nom": "BOURDAIS", "dossard": 18, "equipe": "Angers Technopole"}, {"id": "excel_19", "prenom": "Alexis", "nom": "CHATELIER", "dossard": 19, "equipe": "FSDV"}, {"id": "excel_20", "prenom": "Alexis", "nom": "VICARI", "dossard": 20, "equipe": "Xilo Menuiserie"}, {"id": "excel_21", "prenom": "Alice", "nom": "de Kergorlay", "dossard": 21, "equipe": "Association EFATA - La Boussole"}, {"id": "excel_22", "prenom": "Alice", "nom": "Pineau", "dossard": 22, "equipe": "Esperancia"}, {"id": "excel_23", "prenom": "Alice", "nom": "RIVIERE", "dossard": 23, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_24", "prenom": "Alicia", "nom": "PEHU", "dossard": 24, "equipe": "Assureurs associés"}, {"id": "excel_25", "prenom": "Aliénor", "nom": "LABORDE", "dossard": 25, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_26", "prenom": "ALIX", "nom": "Bouvier", "dossard": 26, "equipe": "Ecole Saint Serge"}, {"id": "excel_27", "prenom": "Alix", "nom": "FLAMA", "dossard": 27, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_28", "prenom": "Alix", "nom": "Garrigou Grandchamp", "dossard": 28, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_29", "prenom": "Alix", "nom": "JACQUET", "dossard": 29, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_30", "prenom": "Alixia", "nom": "(Colibri)", "dossard": 30, "equipe": "Colibri"}, {"id": "excel_31", "prenom": "Aliya", "nom": "KARAMOKO", "dossard": 31, "equipe": "Le Gouvernail"}, {"id": "excel_32", "prenom": "Almedina", "nom": "(Colibri)", "dossard": 32, "equipe": "Colibri"}, {"id": "excel_33", "prenom": "Almes", "nom": "AIT OUELHAJ", "dossard": 33, "equipe": "Le Gouvernail"}, {"id": "excel_34", "prenom": "Amada", "nom": "GARNICA LEMARCHAND", "dossard": 34, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_35", "prenom": "Amance", "nom": "LEMEE", "dossard": 35, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_36", "prenom": "Amaury", "nom": "GESLIN", "dossard": 36, "equipe": "Le Gouvernail"}, {"id": "excel_37", "prenom": "Amaury", "nom": "REVEL", "dossard": 37, "equipe": "FSDV"}, {"id": "excel_38", "prenom": "Amélia", "nom": "MANCEAU", "dossard": 38, "equipe": "Angers Technopole"}, {"id": "excel_39", "prenom": "Amélie", "nom": "CHAMPION", "dossard": 39, "equipe": "FSDV"}, {"id": "excel_40", "prenom": "Amicie", "nom": "RAMÉ", "dossard": 40, "equipe": "FSDV"}, {"id": "excel_41", "prenom": "Amira", "nom": "Orfali", "dossard": 41, "equipe": "Ecole Saint Serge"}, {"id": "excel_42", "prenom": "Anais", "nom": "(Colibri)", "dossard": 42, "equipe": "Colibri"}, {"id": "excel_43", "prenom": "Anaïs", "nom": "Hiron", "dossard": 43, "equipe": null}, {"id": "excel_44", "prenom": "ANAS", "nom": "Magherbi", "dossard": 44, "equipe": "Ecole Saint Serge"}, {"id": "excel_45", "prenom": "ANGEL", "nom": "MACHINE", "dossard": 45, "equipe": "Département de Maine-et-Loire"}, {"id": "excel_46", "prenom": "Angéline", "nom": "NIANGORAN", "dossard": 46, "equipe": "Le Gouvernail"}, {"id": "excel_47", "prenom": "Anne-Sophie", "nom": "Tesson", "dossard": 47, "equipe": null}, {"id": "excel_48", "prenom": "Annette", "nom": "Bouet", "dossard": 48, "equipe": "Ecole Saint Serge"}, {"id": "excel_49", "prenom": "Annonciade", "nom": "GADENNE", "dossard": 49, "equipe": "Le Gouvernail"}, {"id": "excel_50", "prenom": "Anselme", "nom": "GADENNE", "dossard": 50, "equipe": "Le Gouvernail"}, {"id": "excel_51", "prenom": "Anthony", "nom": "BOURSIN", "dossard": 51, "equipe": "Becouze"}, {"id": "excel_52", "prenom": "Antoine", "nom": "(Colibri)", "dossard": 52, "equipe": "Colibri"}, {"id": "excel_53", "prenom": "Armand", "nom": "BONY", "dossard": 53, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_54", "prenom": "Arnaud", "nom": "BOULERY", "dossard": 54, "equipe": "Octopus Patrimoine"}, {"id": "excel_55", "prenom": "Arnaud", "nom": "JOLIVET", "dossard": 55, "equipe": "Nameshield"}, {"id": "excel_56", "prenom": "Arthis", "nom": "Texier", "dossard": 56, "equipe": "T'CAP-T'PRO"}, {"id": "excel_57", "prenom": "Arthur", "nom": "DUBAIL", "dossard": 57, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_58", "prenom": "Arthur", "nom": "Dubois Stoyanov", "dossard": 58, "equipe": "Ecole Saint Serge"}, {"id": "excel_59", "prenom": "Arthur", "nom": "ROUSSEAU", "dossard": 59, "equipe": "AXA Prévoyance et Patrimoine"}, {"id": "excel_60", "prenom": "Arthus", "nom": "DE KERGORLAY", "dossard": 60, "equipe": "Le Gouvernail"}, {"id": "excel_61", "prenom": "Asaël-Néhémie", "nom": "Le Picart", "dossard": 61, "equipe": "Ecole Saint Serge"}, {"id": "excel_62", "prenom": "Atilio", "nom": "OUTIOU", "dossard": 62, "equipe": "Marie Durand"}, {"id": "excel_63", "prenom": "Atimad", "nom": "ER RAMACH", "dossard": 63, "equipe": "N.I.A.H."}, {"id": "excel_64", "prenom": "Atimad", "nom": "ER RAMACH", "dossard": 64, "equipe": "N.I.A.H."}, {"id": "excel_65", "prenom": "AUBIN", "nom": "ROMBOUT", "dossard": 65, "equipe": "Pause Angevine - UPE"}, {"id": "excel_66", "prenom": "Audrey", "nom": "DUSSOT AMATO", "dossard": 66, "equipe": "Le Gouvernail"}, {"id": "excel_67", "prenom": "AUDREY", "nom": "MANATA GOMES", "dossard": 67, "equipe": "Campus ESPL"}, {"id": "excel_68", "prenom": "Audrey", "nom": "Rousval", "dossard": 68, "equipe": "LVA Le Logis"}, {"id": "excel_69", "prenom": "Augustin", "nom": "BOUREUX", "dossard": 69, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_70", "prenom": "Augustin", "nom": "de BAGNEAUX", "dossard": 70, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_71", "prenom": "Augustin", "nom": "MARTIN", "dossard": 71, "equipe": "Le Gouvernail"}, {"id": "excel_72", "prenom": "Aurélie", "nom": "Gaud", "dossard": 72, "equipe": null}, {"id": "excel_73", "prenom": "Aurélie", "nom": "Meunier", "dossard": 73, "equipe": "Marie Durand"}, {"id": "excel_74", "prenom": "Aurélie", "nom": "RICHÉ", "dossard": 74, "equipe": "SDEL Energis Angers"}, {"id": "excel_75", "prenom": "Aurélien", "nom": "DELORME", "dossard": 75, "equipe": "Becouze"}, {"id": "excel_76", "prenom": "Aurélien", "nom": "Hardy", "dossard": 76, "equipe": "Pas à Pas 49"}, {"id": "excel_77", "prenom": "Aurélien", "nom": "Le Foll", "dossard": 77, "equipe": "Agapè Anjou"}, {"id": "excel_78", "prenom": "Aurore", "nom": "VERNIER-ESNAULT", "dossard": 78, "equipe": "ALDEV"}, {"id": "excel_79", "prenom": "Axel", "nom": "Goulet", "dossard": 79, "equipe": "Ecole Saint Serge"}, {"id": "excel_80", "prenom": "Axel", "nom": "Rivas Acosta", "dossard": 80, "equipe": "AFOCAL"}, {"id": "excel_81", "prenom": "Ayaan", "nom": "(Colibri)", "dossard": 81, "equipe": "Colibri"}, {"id": "excel_82", "prenom": "Aymen", "nom": "AMIR IBRAHIM", "dossard": 82, "equipe": "LE JARDIN DE COCAGNE ANGEVIN"}, {"id": "excel_83", "prenom": "Aymeric", "nom": "MARIE-JEANNE", "dossard": 83, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_84", "prenom": "Baptiste", "nom": "Beillard", "dossard": 84, "equipe": "LVA Le Logis"}, {"id": "excel_85", "prenom": "Baptiste", "nom": "BOLO", "dossard": 85, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_86", "prenom": "Baptiste", "nom": "MOCQUET", "dossard": 86, "equipe": "ANJOU LOIRE TERRITOIRE"}, {"id": "excel_87", "prenom": "BAPTISTE", "nom": "Reynard", "dossard": 87, "equipe": "Ecole Saint Serge"}, {"id": "excel_88", "prenom": "Basma", "nom": "BENAYAD", "dossard": 88, "equipe": "N.I.A.H."}, {"id": "excel_89", "prenom": "Bastien", "nom": "MAUSSION", "dossard": 89, "equipe": "FSDV"}, {"id": "excel_90", "prenom": "Baudouin", "nom": "BOUSQUET", "dossard": 90, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_91", "prenom": "Baudouin", "nom": "PERROUD", "dossard": 91, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_92", "prenom": "Baya", "nom": "Fria", "dossard": 92, "equipe": "Agapè Anjou"}, {"id": "excel_93", "prenom": "Benjamin", "nom": "KARAMOKO", "dossard": 93, "equipe": "Le Gouvernail"}, {"id": "excel_94", "prenom": "BENJAMIN", "nom": "Leboeuf", "dossard": 94, "equipe": "Ecole Saint Serge"}, {"id": "excel_95", "prenom": "Benoit", "nom": "CHARRUAU", "dossard": 95, "equipe": "Saint Jean Espérance"}, {"id": "excel_96", "prenom": "Benoit", "nom": "MESSIE", "dossard": 96, "equipe": "Assureurs associés"}, {"id": "excel_97", "prenom": "Benoît", "nom": "Maïsto", "dossard": 97, "equipe": "6e Régiment du Génie d’Angers"}, {"id": "excel_98", "prenom": "Bertrand", "nom": "TERTRAIS", "dossard": 98, "equipe": "AXA Prévoyance et Patrimoine"}, {"id": "excel_99", "prenom": "Bilal", "nom": "(Colibri)", "dossard": 99, "equipe": "Colibri"}, {"id": "excel_100", "prenom": "Bintou", "nom": "SIDIBE", "dossard": 100, "equipe": "Agence Kalia"}, {"id": "excel_101", "prenom": "Blanche", "nom": "LEBORGNE", "dossard": 101, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_102", "prenom": "Blandine", "nom": "de MOLLANS", "dossard": 102, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_103", "prenom": "Bosco", "nom": "GADENNE", "dossard": 103, "equipe": "Le Gouvernail"}, {"id": "excel_104", "prenom": "Boubacar", "nom": "Diallo", "dossard": 104, "equipe": "T'CAP-T'PRO"}, {"id": "excel_105", "prenom": "BRIEUC", "nom": "Prosper", "dossard": 105, "equipe": "Ecole Saint Serge"}, {"id": "excel_106", "prenom": "Camille", "nom": "BERGE", "dossard": 106, "equipe": "La cravate solidaire"}, {"id": "excel_107", "prenom": "Camille", "nom": "Boisseau", "dossard": 107, "equipe": "Campus Coach Angers"}, {"id": "excel_108", "prenom": "Camille", "nom": "Chombart", "dossard": 108, "equipe": "Marraine et vous"}, {"id": "excel_109", "prenom": "Camille", "nom": "Dufrêne", "dossard": 109, "equipe": "Pause Angevine - UPE"}, {"id": "excel_110", "prenom": "Camille", "nom": "DUVEAU", "dossard": 110, "equipe": "Becouze"}, {"id": "excel_111", "prenom": "CAMILLE", "nom": "Messner", "dossard": 111, "equipe": "Ecole Saint Serge"}, {"id": "excel_112", "prenom": "Camille", "nom": "MOREAU", "dossard": 112, "equipe": "FSDV"}, {"id": "excel_113", "prenom": "Candice", "nom": "Chalet", "dossard": 113, "equipe": null}, {"id": "excel_114", "prenom": "CAPUCINE", "nom": "Graemiger", "dossard": 114, "equipe": "Ecole Saint Serge"}, {"id": "excel_115", "prenom": "Caroline", "nom": "(Colibri)", "dossard": 115, "equipe": "Colibri"}, {"id": "excel_116", "prenom": "Cassandre", "nom": "LEGRAS", "dossard": 116, "equipe": "T'CAP-T'PRO"}, {"id": "excel_117", "prenom": "catherine", "nom": "GAULT", "dossard": 117, "equipe": "ALDEV"}, {"id": "excel_118", "prenom": "Cecile", "nom": "Clemenceau", "dossard": 118, "equipe": null}, {"id": "excel_119", "prenom": "Cécile", "nom": "DIEPPEDALLE", "dossard": 119, "equipe": "Becouze"}, {"id": "excel_120", "prenom": "Cédric", "nom": "BARON-PLANTE", "dossard": 120, "equipe": "Campus ESPL"}, {"id": "excel_121", "prenom": "Célestin", "nom": "LEMALE", "dossard": 121, "equipe": "AFOCAL"}, {"id": "excel_122", "prenom": "Célestin", "nom": "PUEL", "dossard": 122, "equipe": "LE JARDIN DE COCAGNE ANGEVIN"}, {"id": "excel_123", "prenom": "Céline", "nom": "(Colibri)", "dossard": 123, "equipe": "Colibri"}, {"id": "excel_124", "prenom": "Céline", "nom": "HUNAULT", "dossard": 124, "equipe": "ANJOU LOIRE TERRITOIRE"}, {"id": "excel_125", "prenom": "Céline", "nom": "LIGNEL", "dossard": 125, "equipe": "Campus ESPL"}, {"id": "excel_126", "prenom": "Charleen", "nom": "Fajardo", "dossard": 126, "equipe": "Département de Maine-et-Loire"}, {"id": "excel_127", "prenom": "Charles", "nom": "de MOLLANS", "dossard": 127, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_128", "prenom": "Charles", "nom": "GASCOGNE", "dossard": 128, "equipe": "Octopus Patrimoine"}, {"id": "excel_129", "prenom": "Charles", "nom": "Raynaud de fitte", "dossard": 129, "equipe": "Saint Jean Espérance"}, {"id": "excel_130", "prenom": "Chayma", "nom": "M'HADHBI", "dossard": 130, "equipe": "N.I.A.H."}, {"id": "excel_131", "prenom": "Cheyenne", "nom": "(Colibri)", "dossard": 131, "equipe": "Colibri"}, {"id": "excel_132", "prenom": "Chloé", "nom": "Guilleux", "dossard": 132, "equipe": "Campus ESPL"}, {"id": "excel_133", "prenom": "chloé", "nom": "piton", "dossard": 133, "equipe": null}, {"id": "excel_134", "prenom": "Christelle", "nom": "BOONE", "dossard": 134, "equipe": "FSDV"}, {"id": "excel_135", "prenom": "Christiane", "nom": "LAUDE", "dossard": 135, "equipe": "La cravate solidaire"}, {"id": "excel_136", "prenom": "Christine", "nom": "Bellec", "dossard": 136, "equipe": "Marie Durand"}, {"id": "excel_137", "prenom": "Christophe", "nom": "Roche", "dossard": 137, "equipe": "Octopus Patrimoine"}, {"id": "excel_138", "prenom": "Claire", "nom": "Pasquier", "dossard": 138, "equipe": "Marie Durand"}, {"id": "excel_139", "prenom": "Clara", "nom": "DELATOUR", "dossard": 139, "equipe": "Assureurs associés"}, {"id": "excel_140", "prenom": "Claude", "nom": "ALLAIS", "dossard": 140, "equipe": "La cravate solidaire"}, {"id": "excel_141", "prenom": "CLAUDINE", "nom": "BIDAL", "dossard": 141, "equipe": "ANJOU LOIRE TERRITOIRE"}, {"id": "excel_142", "prenom": "Clémence", "nom": "(Colibri)", "dossard": 142, "equipe": "Colibri"}, {"id": "excel_143", "prenom": "Clémence", "nom": "JACQUET", "dossard": 143, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_144", "prenom": "Clémence", "nom": "LEPLOMB", "dossard": 144, "equipe": "FSDV"}, {"id": "excel_145", "prenom": "Clement", "nom": "JERRO", "dossard": 145, "equipe": "Saint Jean Espérance"}, {"id": "excel_146", "prenom": "Clémentine", "nom": "Forcard", "dossard": 146, "equipe": "Ecole Saint Serge"}, {"id": "excel_147", "prenom": "Clotilde", "nom": "BOUREUX", "dossard": 147, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_148", "prenom": "Clotilde", "nom": "de LA VOLPILIERE", "dossard": 148, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_149", "prenom": "Côme", "nom": "LAMALLE", "dossard": 149, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_150", "prenom": "Coralie", "nom": "Bellin", "dossard": 150, "equipe": null}, {"id": "excel_151", "prenom": "Cybélia", "nom": "GENEVOIS", "dossard": 151, "equipe": "ADEPAPE-Repairs! 49"}, {"id": "excel_152", "prenom": "Cyriaque", "nom": "GESLIN", "dossard": 152, "equipe": "Le Gouvernail"}, {"id": "excel_153", "prenom": "Cyril", "nom": "Sauvetre", "dossard": 153, "equipe": "Marie Durand"}, {"id": "excel_154", "prenom": "Danicia", "nom": "AUGUSTUS", "dossard": 154, "equipe": "La Rose Fraternelle"}, {"id": "excel_155", "prenom": "Daphné", "nom": "Berranger Escar", "dossard": 155, "equipe": "Ecole Saint Serge"}, {"id": "excel_156", "prenom": "Deka", "nom": "OSMAN MADHI", "dossard": 156, "equipe": "LE JARDIN DE COCAGNE ANGEVIN"}, {"id": "excel_157", "prenom": "Delphine", "nom": "Delobelle", "dossard": 157, "equipe": "Agapè Anjou"}, {"id": "excel_158", "prenom": "Denis", "nom": "BARAILLE", "dossard": 158, "equipe": "AXA Prévoyance et Patrimoine"}, {"id": "excel_159", "prenom": "Denis", "nom": "Germond", "dossard": 159, "equipe": "Département de Maine-et-Loire"}, {"id": "excel_160", "prenom": "Diane", "nom": "de Sèze", "dossard": 160, "equipe": "La Tilma"}, {"id": "excel_161", "prenom": "Diégo", "nom": "(Colibri)", "dossard": 161, "equipe": "Colibri"}, {"id": "excel_162", "prenom": "Djama", "nom": "(Colibri)", "dossard": 162, "equipe": "Colibri"}, {"id": "excel_163", "prenom": "Dom", "nom": "COSNEAU", "dossard": 163, "equipe": "Réseau Entreprendre Maine et Loire"}, {"id": "excel_164", "prenom": "Dylan", "nom": "(Colibri)", "dossard": 164, "equipe": "Colibri"}, {"id": "excel_165", "prenom": "EDGAR", "nom": "Martinet", "dossard": 165, "equipe": "Ecole Saint Serge"}, {"id": "excel_166", "prenom": "Efraim", "nom": "APALONE", "dossard": 166, "equipe": "La Rose Fraternelle"}, {"id": "excel_167", "prenom": "Ekhlas", "nom": "JEDO OMAR", "dossard": 167, "equipe": "LE JARDIN DE COCAGNE ANGEVIN"}, {"id": "excel_168", "prenom": "Eléonore", "nom": "DE CARVALHO", "dossard": 168, "equipe": "Le Gouvernail"}, {"id": "excel_169", "prenom": "Éléonore", "nom": "CAYREL", "dossard": 169, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_170", "prenom": "Elise", "nom": "CADIOU", "dossard": 170, "equipe": "FSDV"}, {"id": "excel_171", "prenom": "Ellyana", "nom": "(Colibri)", "dossard": 171, "equipe": "Colibri"}, {"id": "excel_172", "prenom": "Elodie", "nom": "BAILLY", "dossard": 172, "equipe": "ANJOU LOIRE TERRITOIRE"}, {"id": "excel_173", "prenom": "Elodie", "nom": "Poidevin", "dossard": 173, "equipe": "Yendouboame"}, {"id": "excel_174", "prenom": "Elodie", "nom": "SAIVRE", "dossard": 174, "equipe": "Solar Bird"}, {"id": "excel_175", "prenom": "Eloi", "nom": "Baumard", "dossard": 175, "equipe": "Ecole Saint Serge"}, {"id": "excel_176", "prenom": "Eloi", "nom": "Miret", "dossard": 176, "equipe": "Nameshield"}, {"id": "excel_177", "prenom": "Elvire", "nom": "CHATIN de CHASTAING", "dossard": 177, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_178", "prenom": "Elyes", "nom": "GUERBAA", "dossard": 178, "equipe": "Le Gouvernail"}, {"id": "excel_179", "prenom": "Emérentienne", "nom": "Suter", "dossard": 179, "equipe": "À Deux Mains"}, {"id": "excel_180", "prenom": "Emilien", "nom": "Pasco", "dossard": 180, "equipe": "AFOCAL"}, {"id": "excel_181", "prenom": "Emmanuel", "nom": "LEGUY", "dossard": 181, "equipe": "Becouze"}, {"id": "excel_182", "prenom": "Emmanuel", "nom": "PARMENTIER", "dossard": 182, "equipe": "AXA Prévoyance et Patrimoine"}, {"id": "excel_183", "prenom": "Emmy", "nom": "COSTALAT", "dossard": 183, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_184", "prenom": "Enzo", "nom": "(Colibri)", "dossard": 184, "equipe": "Colibri"}, {"id": "excel_185", "prenom": "Enzo", "nom": "Gabory", "dossard": 185, "equipe": "SDEL Energis Angers"}, {"id": "excel_186", "prenom": "Enzo", "nom": "Lavaud", "dossard": 186, "equipe": "Campus ESPL"}, {"id": "excel_187", "prenom": "Enzo", "nom": "Medard", "dossard": 187, "equipe": null}, {"id": "excel_188", "prenom": "Eric", "nom": "REVEILLANT", "dossard": 188, "equipe": "Le Gouvernail"}, {"id": "excel_189", "prenom": "Erin", "nom": "Marias", "dossard": 189, "equipe": "Marie Durand"}, {"id": "excel_190", "prenom": "Estéban", "nom": "Chene", "dossard": 190, "equipe": "Ecole Saint Serge"}, {"id": "excel_191", "prenom": "Esther", "nom": "LUISIER", "dossard": 191, "equipe": "Le Gouvernail"}, {"id": "excel_192", "prenom": "Ethan", "nom": "Deletang", "dossard": 192, "equipe": "Agapè Anjou"}, {"id": "excel_193", "prenom": "Étienne", "nom": "PETIT", "dossard": 193, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_194", "prenom": "Étienne", "nom": "SUBRA", "dossard": 194, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_195", "prenom": "Eugénie", "nom": "de BETUNE HESDIGNEUL", "dossard": 195, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_196", "prenom": "Eugénie", "nom": "DE KERGORLAY", "dossard": 196, "equipe": "Le Gouvernail"}, {"id": "excel_197", "prenom": "Eugénie", "nom": "KUN-DARBOIS", "dossard": 197, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_198", "prenom": "Eugénie", "nom": "Vincent", "dossard": 198, "equipe": "ARIFTS"}, {"id": "excel_199", "prenom": "Eve", "nom": "(Colibri)", "dossard": 199, "equipe": "Colibri"}, {"id": "excel_200", "prenom": "Eve", "nom": "LE FESSANT", "dossard": 200, "equipe": "Angers Technopole"}, {"id": "excel_201", "prenom": "Evelyne", "nom": "MAILLET", "dossard": 201, "equipe": "Angers Technopole"}, {"id": "excel_202", "prenom": "Ezzedine", "nom": "Adam", "dossard": 202, "equipe": "SDEL Energis Angers"}, {"id": "excel_203", "prenom": "Fatoumata", "nom": "DIAKITE", "dossard": 203, "equipe": "LE JARDIN DE COCAGNE ANGEVIN"}, {"id": "excel_204", "prenom": "Félicie", "nom": "de FOUGEROUX", "dossard": 204, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_205", "prenom": "Félicie", "nom": "des JAMONIERES", "dossard": 205, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_206", "prenom": "Félix", "nom": "MARTIN", "dossard": 206, "equipe": "Le Gouvernail"}, {"id": "excel_207", "prenom": "Fidelis", "nom": "LEE", "dossard": 207, "equipe": "Saint Jean Espérance"}, {"id": "excel_208", "prenom": "Florence", "nom": "Bopp", "dossard": 208, "equipe": "PARRAINS PAR MILLE"}, {"id": "excel_209", "prenom": "Florence", "nom": "MOURAIT", "dossard": 209, "equipe": "FSDV"}, {"id": "excel_210", "prenom": "Florian", "nom": "BERTIN", "dossard": 210, "equipe": "Solar Bird"}, {"id": "excel_211", "prenom": "Florian", "nom": "LABRUT", "dossard": 211, "equipe": "FSDV"}, {"id": "excel_212", "prenom": "Floriane", "nom": "(Colibri)", "dossard": 212, "equipe": "Colibri"}, {"id": "excel_213", "prenom": "Florine", "nom": "Blond", "dossard": 213, "equipe": "LVA Le Logis"}, {"id": "excel_214", "prenom": "Fr Eric", "nom": "LE GRELLE", "dossard": 214, "equipe": "Saint Jean Espérance"}, {"id": "excel_215", "prenom": "Francois", "nom": "de La Perraudiere", "dossard": 215, "equipe": null}, {"id": "excel_216", "prenom": "François", "nom": "PETIT", "dossard": 216, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_217", "prenom": "Frédéric", "nom": "Clabau", "dossard": 217, "equipe": "Angers Technopole"}, {"id": "excel_218", "prenom": "Frédéric", "nom": "HERIN", "dossard": 218, "equipe": "LE JARDIN DE COCAGNE ANGEVIN"}, {"id": "excel_219", "prenom": "Gabriel", "nom": "Devirieux", "dossard": 219, "equipe": "AFOCAL"}, {"id": "excel_220", "prenom": "Gaël", "nom": "TEPA", "dossard": 220, "equipe": "6e Régiment du Génie d’Angers"}, {"id": "excel_221", "prenom": "Gaëtane", "nom": "BRANCOUR", "dossard": 221, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_222", "prenom": "Gaspard", "nom": "GERBIER", "dossard": 222, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_223", "prenom": "Gauthier", "nom": "BOUSQUET", "dossard": 223, "equipe": "Le Gouvernail"}, {"id": "excel_224", "prenom": "Gladys", "nom": "CHATIN de CHASTAING", "dossard": 224, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_225", "prenom": "Glenn", "nom": "ROUVRAIS", "dossard": 225, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_226", "prenom": "Gregory", "nom": "Thomas", "dossard": 226, "equipe": "Marie Durand"}, {"id": "excel_227", "prenom": "Guilhem", "nom": "D'ABBADIE", "dossard": 227, "equipe": "Le Gouvernail"}, {"id": "excel_228", "prenom": "Guillaume", "nom": "(Colibri)", "dossard": 228, "equipe": "Colibri"}, {"id": "excel_229", "prenom": "Guillaume", "nom": "KOFFI", "dossard": 229, "equipe": null}, {"id": "excel_230", "prenom": "Guillaume", "nom": "Messié", "dossard": 230, "equipe": "Assureurs associés"}, {"id": "excel_231", "prenom": "Guillaume", "nom": "PICHOT", "dossard": 231, "equipe": "Le Gouvernail"}, {"id": "excel_232", "prenom": "Guillaume", "nom": "TRIN", "dossard": 232, "equipe": "Octopus Patrimoine"}, {"id": "excel_233", "prenom": "Gwen", "nom": "Mary", "dossard": 233, "equipe": "Département de Maine-et-Loire"}, {"id": "excel_234", "prenom": "Haitam", "nom": "El Qassimi", "dossard": 234, "equipe": "Campus ESPL"}, {"id": "excel_235", "prenom": "Héléna", "nom": "Jousseaume Petit", "dossard": 235, "equipe": "AXA Prévoyance et Patrimoine"}, {"id": "excel_236", "prenom": "Hélène", "nom": "DURAND", "dossard": 236, "equipe": "Yendouboame"}, {"id": "excel_237", "prenom": "Hélie", "nom": "de QUATREBARBES", "dossard": 237, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_238", "prenom": "HELIO", "nom": "Pezet", "dossard": 238, "equipe": "Ecole Saint Serge"}, {"id": "excel_239", "prenom": "Héloïse", "nom": "MAILLET", "dossard": 239, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_240", "prenom": "Héloïse", "nom": "PEDERSEN", "dossard": 240, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_241", "prenom": "hermance", "nom": "medawar", "dossard": 241, "equipe": "AFOCAL"}, {"id": "excel_242", "prenom": "Hermann", "nom": "(Colibri)", "dossard": 242, "equipe": "Colibri"}, {"id": "excel_243", "prenom": "Hilaire", "nom": "Crocombette", "dossard": 243, "equipe": "Excellence Ruralités"}, {"id": "excel_244", "prenom": "HYLA", "nom": "Gautron-Goineau", "dossard": 244, "equipe": "Ecole Saint Serge"}, {"id": "excel_245", "prenom": "Hyomé", "nom": "YOUKOU", "dossard": 245, "equipe": "Le Gouvernail"}, {"id": "excel_246", "prenom": "Ilias", "nom": "ZENAINI", "dossard": 246, "equipe": "La Rose Fraternelle"}, {"id": "excel_247", "prenom": "Illona", "nom": "ROUEZ", "dossard": 247, "equipe": "Agence Kalia"}, {"id": "excel_248", "prenom": "Ines", "nom": "(Colibri)", "dossard": 248, "equipe": "Colibri"}, {"id": "excel_249", "prenom": "Iris", "nom": "SOTKINE", "dossard": 249, "equipe": "Assureurs associés"}, {"id": "excel_250", "prenom": "Isabelle", "nom": "CARICHON", "dossard": 250, "equipe": "FSDV"}, {"id": "excel_251", "prenom": "Isabelle", "nom": "de Préville", "dossard": 251, "equipe": "La Tilma"}, {"id": "excel_252", "prenom": "IZILE", "nom": "Grezeleau Delaunay", "dossard": 252, "equipe": "Ecole Saint Serge"}, {"id": "excel_253", "prenom": "Jacky", "nom": "Giraudeau", "dossard": 253, "equipe": "T'CAP-T'PRO"}, {"id": "excel_254", "prenom": "Jacques", "nom": "GADENNE", "dossard": 254, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_255", "prenom": "Jacques", "nom": "MARTIN", "dossard": 255, "equipe": "Le Gouvernail"}, {"id": "excel_256", "prenom": "Jade", "nom": "feybesse", "dossard": 256, "equipe": null}, {"id": "excel_257", "prenom": "Jean", "nom": "ROLAND", "dossard": 257, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_258", "prenom": "Jean-Lin", "nom": "BEUQUE", "dossard": 258, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_259", "prenom": "Jean-Loic", "nom": "BEAUGENDRE", "dossard": 259, "equipe": "Saint Jean Espérance"}, {"id": "excel_260", "prenom": "JEANNE", "nom": "Bassinat", "dossard": 260, "equipe": "Ecole Saint Serge"}, {"id": "excel_261", "prenom": "JEANNE", "nom": "Ferrandon", "dossard": 261, "equipe": "Ecole Saint Serge"}, {"id": "excel_262", "prenom": "Jeanne", "nom": "KUN-DARBOIS", "dossard": 262, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_263", "prenom": "Jean-Philippe", "nom": "BLOT", "dossard": 263, "equipe": "SDEL Energis Angers"}, {"id": "excel_264", "prenom": "Jeffalbert", "nom": "DELBOS", "dossard": 264, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_265", "prenom": "Jeremy", "nom": "BONNET", "dossard": 265, "equipe": "Saint Jean Espérance"}, {"id": "excel_266", "prenom": "Jildaz", "nom": "LE CAM", "dossard": 266, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_267", "prenom": "Jimmy", "nom": "(Colibri)", "dossard": 267, "equipe": "Colibri"}, {"id": "excel_268", "prenom": "Joachim", "nom": "BOURGEOIS", "dossard": 268, "equipe": "Le Gouvernail"}, {"id": "excel_269", "prenom": "Joffrey", "nom": "JAMIN", "dossard": 269, "equipe": "FSDV"}, {"id": "excel_270", "prenom": "Johann", "nom": "AUPIAIS", "dossard": 270, "equipe": "FSDV"}, {"id": "excel_271", "prenom": "Jonathan", "nom": "Raulin", "dossard": 271, "equipe": "T'CAP-T'PRO"}, {"id": "excel_272", "prenom": "Joseph", "nom": "de QUATREBARBES", "dossard": 272, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_273", "prenom": "Joseph", "nom": "ESQUIER", "dossard": 273, "equipe": "Solar Bird"}, {"id": "excel_274", "prenom": "Joseph", "nom": "RENOUL", "dossard": 274, "equipe": "Saint Jean Espérance"}, {"id": "excel_275", "prenom": "Joséphine", "nom": "MARTIN", "dossard": 275, "equipe": "Le Gouvernail"}, {"id": "excel_276", "prenom": "Joulia", "nom": "Billouin", "dossard": 276, "equipe": "Ecole Saint Serge"}, {"id": "excel_277", "prenom": "Joy", "nom": "Ylend", "dossard": 277, "equipe": "Ecole Saint Serge"}, {"id": "excel_278", "prenom": "JP", "nom": "Béchu", "dossard": 278, "equipe": "Esperancia"}, {"id": "excel_279", "prenom": "JP", "nom": "Béchu", "dossard": 279, "equipe": "Esperancia"}, {"id": "excel_280", "prenom": "Judith", "nom": "GIRAUD", "dossard": 280, "equipe": "Le Gouvernail"}, {"id": "excel_281", "prenom": "Jules", "nom": "Bareau Mahaza", "dossard": 281, "equipe": "Ecole Saint Serge"}, {"id": "excel_282", "prenom": "Jules", "nom": "HERIDEL", "dossard": 282, "equipe": "Réseau Entreprendre Maine et Loire"}, {"id": "excel_283", "prenom": "JULES", "nom": "Roy", "dossard": 283, "equipe": "Ecole Saint Serge"}, {"id": "excel_284", "prenom": "Julie", "nom": "COUDRAIN", "dossard": 284, "equipe": "AXA Prévoyance et Patrimoine"}, {"id": "excel_285", "prenom": "Julie", "nom": "Picard-Bodard", "dossard": 285, "equipe": "Agence Kalia"}, {"id": "excel_286", "prenom": "Julien", "nom": "FLECHET-CHARNEAU", "dossard": 286, "equipe": "ADEPAPE-Repairs! 49"}, {"id": "excel_287", "prenom": "Julien", "nom": "Havard", "dossard": 287, "equipe": "6e Régiment du Génie d’Angers"}, {"id": "excel_288", "prenom": "Julien", "nom": "Lemarchand", "dossard": 288, "equipe": "LE JARDIN DE COCAGNE ANGEVIN"}, {"id": "excel_289", "prenom": "Juliette", "nom": "Lorand", "dossard": 289, "equipe": "AFOCAL"}, {"id": "excel_290", "prenom": "Julyano", "nom": "Boutruche", "dossard": 290, "equipe": "LVA Le Logis"}, {"id": "excel_291", "prenom": "Justine", "nom": "DERRIEN", "dossard": 291, "equipe": null}, {"id": "excel_292", "prenom": "Justine", "nom": "Martinis", "dossard": 292, "equipe": "Nameshield"}, {"id": "excel_293", "prenom": "Kaïs", "nom": "BACAR", "dossard": 293, "equipe": "La Rose Fraternelle"}, {"id": "excel_294", "prenom": "Kaki", "nom": "DIAKHABY", "dossard": 294, "equipe": "Le Gouvernail"}, {"id": "excel_295", "prenom": "Kamilia", "nom": "KOUDIAN", "dossard": 295, "equipe": "Le Gouvernail"}, {"id": "excel_296", "prenom": "Karine", "nom": "PERREAULT", "dossard": 296, "equipe": "FSDV"}, {"id": "excel_297", "prenom": "Karine", "nom": "Poidevin", "dossard": 297, "equipe": "Yendouboame"}, {"id": "excel_298", "prenom": "Karl", "nom": "Dia", "dossard": 298, "equipe": "Ecole Saint Serge"}, {"id": "excel_299", "prenom": "KEVIN", "nom": "MITTON", "dossard": 299, "equipe": "Assureurs associés"}, {"id": "excel_300", "prenom": "Kingley", "nom": "(Colibri)", "dossard": 300, "equipe": "Colibri"}, {"id": "excel_301", "prenom": "Laëtitia", "nom": "de Miollis", "dossard": 301, "equipe": "Les Cahutes de Louise"}, {"id": "excel_302", "prenom": "Lancelot", "nom": "de LA ROUSSERIE", "dossard": 302, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_303", "prenom": "Laura", "nom": "BRILLET", "dossard": 303, "equipe": "Réseau Entreprendre Maine et Loire"}, {"id": "excel_304", "prenom": "Lauren", "nom": "Zasso", "dossard": 304, "equipe": null}, {"id": "excel_305", "prenom": "Laurette", "nom": "Marchal", "dossard": 305, "equipe": "Campus ESPL"}, {"id": "excel_306", "prenom": "Laurie", "nom": "Rochais", "dossard": 306, "equipe": "Marie Durand"}, {"id": "excel_307", "prenom": "Layana", "nom": "ROUAULT HOGDAY", "dossard": 307, "equipe": "Le Gouvernail"}, {"id": "excel_308", "prenom": "Léa", "nom": "Bonneau", "dossard": 308, "equipe": "T'CAP-T'PRO"}, {"id": "excel_309", "prenom": "Léa", "nom": "Drouot", "dossard": 309, "equipe": "Ecole Saint Serge"}, {"id": "excel_310", "prenom": "Léa", "nom": "LEMASSON", "dossard": 310, "equipe": "SDEL Energis Angers"}, {"id": "excel_311", "prenom": "Léandre", "nom": "ROUGER", "dossard": 311, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_312", "prenom": "LENA", "nom": "Barkallah", "dossard": 312, "equipe": "Ecole Saint Serge"}, {"id": "excel_313", "prenom": "Lénaïc", "nom": "Parois", "dossard": 313, "equipe": "AFOCAL"}, {"id": "excel_314", "prenom": "Léo", "nom": "(Colibri)", "dossard": 314, "equipe": "Colibri"}, {"id": "excel_315", "prenom": "Léontine", "nom": "de FOUGEROUX", "dossard": 315, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_316", "prenom": "Léopold", "nom": "BOLO", "dossard": 316, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_317", "prenom": "Léopold", "nom": "LEBORGNE", "dossard": 317, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_318", "prenom": "Liam", "nom": "(Colibri)", "dossard": 318, "equipe": "Colibri"}, {"id": "excel_319", "prenom": "Lilas", "nom": "Bellanger", "dossard": 319, "equipe": "Campus ESPL"}, {"id": "excel_320", "prenom": "Lilou", "nom": "(Colibri)", "dossard": 320, "equipe": "Colibri"}, {"id": "excel_321", "prenom": "LILOU", "nom": "Doucet-Blin", "dossard": 321, "equipe": "Ecole Saint Serge"}, {"id": "excel_322", "prenom": "Lina", "nom": "Nedelcheva", "dossard": 322, "equipe": "Nameshield"}, {"id": "excel_323", "prenom": "Lino", "nom": "(Colibri)", "dossard": 323, "equipe": "Colibri"}, {"id": "excel_324", "prenom": "Lisa", "nom": "MANARANCHE-MICHON", "dossard": 324, "equipe": "ADEPAPE-Repairs! 49"}, {"id": "excel_325", "prenom": "Lise", "nom": "CHAUVIN", "dossard": 325, "equipe": "FSDV"}, {"id": "excel_326", "prenom": "Loïc", "nom": "MALET", "dossard": 326, "equipe": "LE JARDIN DE COCAGNE ANGEVIN"}, {"id": "excel_327", "prenom": "Lola", "nom": "Gilbert", "dossard": 327, "equipe": "Campus ESPL"}, {"id": "excel_328", "prenom": "Lola", "nom": "Rivault", "dossard": 328, "equipe": "AFOCAL"}, {"id": "excel_329", "prenom": "Lolita", "nom": "Godineau", "dossard": 329, "equipe": "Marie Durand"}, {"id": "excel_330", "prenom": "Lorenn", "nom": "ROUVRAIS", "dossard": 330, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_331", "prenom": "Lou", "nom": "Montibert", "dossard": 331, "equipe": "Ecole Saint Serge"}, {"id": "excel_332", "prenom": "Lou", "nom": "Moriancourt", "dossard": 332, "equipe": "Réseau Entreprendre Maine et Loire"}, {"id": "excel_333", "prenom": "Lou-Ann", "nom": "Monnier", "dossard": 333, "equipe": "AFOCAL"}, {"id": "excel_334", "prenom": "Louis", "nom": "COLLOT", "dossard": 334, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_335", "prenom": "Louis", "nom": "de LA ROUSSERIE", "dossard": 335, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_336", "prenom": "LOUIS", "nom": "Mallet", "dossard": 336, "equipe": "Ecole Saint Serge"}, {"id": "excel_337", "prenom": "Louis", "nom": "RICHER", "dossard": 337, "equipe": "Solar Bird"}, {"id": "excel_338", "prenom": "LOUISE", "nom": "Hardy", "dossard": 338, "equipe": "Ecole Saint Serge"}, {"id": "excel_339", "prenom": "Louise", "nom": "TESSIER", "dossard": 339, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_340", "prenom": "LOUISON", "nom": "Cointreau", "dossard": 340, "equipe": "Ecole Saint Serge"}, {"id": "excel_341", "prenom": "Lucie", "nom": "CASTAY", "dossard": 341, "equipe": "FSDV"}, {"id": "excel_342", "prenom": "Lucie", "nom": "ROLAND", "dossard": 342, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_343", "prenom": "Lucile", "nom": "de MAS LATRIE", "dossard": 343, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_344", "prenom": "Lucille", "nom": "LE PERRU", "dossard": 344, "equipe": "Becouze"}, {"id": "excel_345", "prenom": "Lucy", "nom": "(Colibri)", "dossard": 345, "equipe": "Colibri"}, {"id": "excel_346", "prenom": "Ludivine", "nom": "BRAZILLE", "dossard": 346, "equipe": "AFOCAL"}, {"id": "excel_347", "prenom": "Luigi", "nom": "VEAU", "dossard": 347, "equipe": "FSDV"}, {"id": "excel_348", "prenom": "Lyam", "nom": "ROUAULT-HOGDAY", "dossard": 348, "equipe": "Le Gouvernail"}, {"id": "excel_349", "prenom": "Madeleine", "nom": "MARESCAUX", "dossard": 349, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_350", "prenom": "Madeleine", "nom": "MARTIN", "dossard": 350, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_351", "prenom": "Maelis", "nom": "anger", "dossard": 351, "equipe": "AFOCAL"}, {"id": "excel_352", "prenom": "Maelys", "nom": "Chevrier", "dossard": 352, "equipe": null}, {"id": "excel_353", "prenom": "Maëlys", "nom": "ANGER", "dossard": 353, "equipe": "AFOCAL"}, {"id": "excel_354", "prenom": "Maeva", "nom": "Amitrano", "dossard": 354, "equipe": "AFOCAL"}, {"id": "excel_355", "prenom": "Magalie", "nom": "Guillet", "dossard": 355, "equipe": "Campus ESPL"}, {"id": "excel_356", "prenom": "Maguelone", "nom": "SCOFFIER", "dossard": 356, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_357", "prenom": "Mahé", "nom": "Hersart de La Villemarqué", "dossard": 357, "equipe": "We are lovers"}, {"id": "excel_358", "prenom": "Maia", "nom": "Chiffoleau", "dossard": 358, "equipe": "Ecole Saint Serge"}, {"id": "excel_359", "prenom": "Malek", "nom": "Amari Legot", "dossard": 359, "equipe": "Ecole Saint Serge"}, {"id": "excel_360", "prenom": "Mamadou", "nom": "DIABY", "dossard": 360, "equipe": "Le Gouvernail"}, {"id": "excel_361", "prenom": "Mamadou Aliou", "nom": "Diallo", "dossard": 361, "equipe": "T'CAP-T'PRO"}, {"id": "excel_362", "prenom": "Mandine", "nom": "NIANGORAN", "dossard": 362, "equipe": "Le Gouvernail"}, {"id": "excel_363", "prenom": "Manon", "nom": "(Colibri)", "dossard": 363, "equipe": "Colibri"}, {"id": "excel_364", "prenom": "Manon", "nom": "BROSSET", "dossard": 364, "equipe": "AFOCAL"}, {"id": "excel_365", "prenom": "Manon", "nom": "Carré", "dossard": 365, "equipe": "Octopus Patrimoine"}, {"id": "excel_366", "prenom": "Manon", "nom": "Chedet", "dossard": 366, "equipe": "Campus ESPL"}, {"id": "excel_367", "prenom": "Manon", "nom": "MÊME", "dossard": 367, "equipe": "FSDV"}, {"id": "excel_368", "prenom": "Manon", "nom": "Micheneau", "dossard": 368, "equipe": "Marie Durand"}, {"id": "excel_369", "prenom": "Manon", "nom": "Moreau", "dossard": 369, "equipe": "Marie Durand"}, {"id": "excel_370", "prenom": "Manon", "nom": "THOMAS", "dossard": 370, "equipe": "LE JARDIN DE COCAGNE ANGEVIN"}, {"id": "excel_371", "prenom": "Marcellino", "nom": "(Colibri)", "dossard": 371, "equipe": "Colibri"}, {"id": "excel_372", "prenom": "Mariam", "nom": "GIRAUD", "dossard": 372, "equipe": "Le Gouvernail"}, {"id": "excel_373", "prenom": "Marie", "nom": "CAUSSE", "dossard": 373, "equipe": "Xilo Menuiserie"}, {"id": "excel_374", "prenom": "Marie", "nom": "Furet", "dossard": 374, "equipe": null}, {"id": "excel_375", "prenom": "marie", "nom": "thibierge", "dossard": 375, "equipe": "La Tilma"}, {"id": "excel_376", "prenom": "Marie-Capucine", "nom": "FAVRE", "dossard": 376, "equipe": "Le Gouvernail"}, {"id": "excel_377", "prenom": "Marie-Gabrielle", "nom": "Pichon", "dossard": 377, "equipe": "Esperancia"}, {"id": "excel_378", "prenom": "Marieke", "nom": "ANSCUTTER", "dossard": 378, "equipe": "FSDV"}, {"id": "excel_379", "prenom": "Marie-Laure", "nom": "FAVRE", "dossard": 379, "equipe": "Le Gouvernail"}, {"id": "excel_380", "prenom": "Marie-Liesse", "nom": "de La Villesboisnet", "dossard": 380, "equipe": null}, {"id": "excel_381", "prenom": "Marie-rose", "nom": "Tevenino", "dossard": 381, "equipe": "6e Régiment du Génie d’Angers"}, {"id": "excel_382", "prenom": "Marion", "nom": "du Peloux", "dossard": 382, "equipe": "Esperancia"}, {"id": "excel_383", "prenom": "Marion", "nom": "Soulard", "dossard": 383, "equipe": "Marie Durand"}, {"id": "excel_384", "prenom": "Marley", "nom": "Gourdon", "dossard": 384, "equipe": "Ecole Saint Serge"}, {"id": "excel_385", "prenom": "Marthe", "nom": "Millet", "dossard": 385, "equipe": "La cravate solidaire"}, {"id": "excel_386", "prenom": "Martin", "nom": "MARTIN", "dossard": 386, "equipe": "Angers Technopole"}, {"id": "excel_387", "prenom": "Martine", "nom": "BONNEROT", "dossard": 387, "equipe": "Le Gouvernail"}, {"id": "excel_388", "prenom": "Mathéo", "nom": "AIGRON", "dossard": 388, "equipe": "La Rose Fraternelle"}, {"id": "excel_389", "prenom": "Mathéo", "nom": "AIGRON", "dossard": 389, "equipe": "La Rose Fraternelle"}, {"id": "excel_390", "prenom": "Mathéo", "nom": "THIERRY", "dossard": 390, "equipe": "Le Gouvernail"}, {"id": "excel_391", "prenom": "Mattias", "nom": "(Colibri)", "dossard": 391, "equipe": "Colibri"}, {"id": "excel_392", "prenom": "Maud", "nom": "GAUMER", "dossard": 392, "equipe": null}, {"id": "excel_393", "prenom": "Maud", "nom": "JUHEL", "dossard": 393, "equipe": "AXA Prévoyance et Patrimoine"}, {"id": "excel_394", "prenom": "Maxence", "nom": "RIZZI", "dossard": 394, "equipe": "Nameshield"}, {"id": "excel_395", "prenom": "Maxime", "nom": "BAUDRY", "dossard": 395, "equipe": "Xilo Menuiserie"}, {"id": "excel_396", "prenom": "Maxime", "nom": "DE ROBIEN", "dossard": 396, "equipe": "AXA Prévoyance et Patrimoine"}, {"id": "excel_397", "prenom": "Maxime", "nom": "MELIN", "dossard": 397, "equipe": "SDEL Energis Angers"}, {"id": "excel_398", "prenom": "MAXIME", "nom": "Pouillart", "dossard": 398, "equipe": "Ecole Saint Serge"}, {"id": "excel_399", "prenom": "Maximilien", "nom": "de BETHUNE HESDIGNEUL", "dossard": 399, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_400", "prenom": "Maya", "nom": "Plantard Aldebert", "dossard": 400, "equipe": "Ecole Saint Serge"}, {"id": "excel_401", "prenom": "Mayeul", "nom": "BEUQUE", "dossard": 401, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_402", "prenom": "Mayeul", "nom": "De ROECK", "dossard": 402, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_403", "prenom": "Mélanie", "nom": "PELÉ", "dossard": 403, "equipe": "FSDV"}, {"id": "excel_404", "prenom": "Melchior", "nom": "BONHOURE", "dossard": 404, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_405", "prenom": "Melie", "nom": "JUDEE", "dossard": 405, "equipe": "Marie Durand"}, {"id": "excel_406", "prenom": "Mélissa", "nom": "Sourisseau", "dossard": 406, "equipe": "Campus Coach Angers"}, {"id": "excel_407", "prenom": "Melvin", "nom": "(Colibri)", "dossard": 407, "equipe": "Colibri"}, {"id": "excel_408", "prenom": "Menehould", "nom": "PAPIN", "dossard": 408, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_409", "prenom": "Michel", "nom": "Boutin", "dossard": 409, "equipe": "123 Cessions"}, {"id": "excel_410", "prenom": "Michèle", "nom": "Durand", "dossard": 410, "equipe": "Yendouboame"}, {"id": "excel_411", "prenom": "Mickael", "nom": "Pottier", "dossard": 411, "equipe": "SDEL Energis Angers"}, {"id": "excel_412", "prenom": "Mohammad", "nom": "YAHYA ELTAIB", "dossard": 412, "equipe": "LE JARDIN DE COCAGNE ANGEVIN"}, {"id": "excel_413", "prenom": "Morgane", "nom": "Banchereau", "dossard": 413, "equipe": "Département de Maine-et-Loire"}, {"id": "excel_414", "prenom": "Munkhbayar", "nom": "BATSAIKHAN", "dossard": 414, "equipe": "Campus ESPL"}, {"id": "excel_415", "prenom": "Muriel", "nom": "DEVOS", "dossard": 415, "equipe": "FSDV"}, {"id": "excel_416", "prenom": "Muriel", "nom": "Lopez", "dossard": 416, "equipe": "Département de Maine-et-Loire"}, {"id": "excel_417", "prenom": "Myriam", "nom": "Myriam Luisier", "dossard": 417, "equipe": "La Rose Fraternelle"}, {"id": "excel_418", "prenom": "Nadine", "nom": "(Colibri)", "dossard": 418, "equipe": "Colibri"}, {"id": "excel_419", "prenom": "Nathalie", "nom": "DARRAS", "dossard": 419, "equipe": "La Tilma"}, {"id": "excel_420", "prenom": "Nathalie", "nom": "Gourdon", "dossard": 420, "equipe": "AFOCAL"}, {"id": "excel_421", "prenom": "Nicolas", "nom": "ATONATTY", "dossard": 421, "equipe": "AXA Prévoyance et Patrimoine"}, {"id": "excel_422", "prenom": "Nicolas", "nom": "PIERRE", "dossard": 422, "equipe": "AXA Prévoyance et Patrimoine"}, {"id": "excel_423", "prenom": "Nicolas", "nom": "RAMÉ", "dossard": 423, "equipe": "FSDV"}, {"id": "excel_424", "prenom": "Nina", "nom": "CAM", "dossard": 424, "equipe": "Angers Technopole"}, {"id": "excel_425", "prenom": "Noé", "nom": "Verdière", "dossard": 425, "equipe": "T'CAP-T'PRO"}, {"id": "excel_426", "prenom": "Noémie", "nom": "BELLARD", "dossard": 426, "equipe": "Becouze"}, {"id": "excel_427", "prenom": "Océane", "nom": "Fournier", "dossard": 427, "equipe": "Réseau Entreprendre Maine et Loire"}, {"id": "excel_428", "prenom": "Océane", "nom": "Placet", "dossard": 428, "equipe": "Ecole Saint Serge"}, {"id": "excel_429", "prenom": "Olga", "nom": "de VILLELE", "dossard": 429, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_430", "prenom": "Olivier", "nom": "BETIL", "dossard": 430, "equipe": "Nameshield"}, {"id": "excel_431", "prenom": "Olivier", "nom": "Chevillard", "dossard": 431, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_432", "prenom": "Olivier", "nom": "Tetard", "dossard": 432, "equipe": "Angers Technopole"}, {"id": "excel_433", "prenom": "Ombline", "nom": "BESNIER", "dossard": 433, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_434", "prenom": "Omer", "nom": "SAID IBRAHIM", "dossard": 434, "equipe": "LE JARDIN DE COCAGNE ANGEVIN"}, {"id": "excel_435", "prenom": "Ophélie", "nom": "GUITTON", "dossard": 435, "equipe": null}, {"id": "excel_436", "prenom": "Paola", "nom": "Vesnier", "dossard": 436, "equipe": null}, {"id": "excel_437", "prenom": "Pascale", "nom": "YOU", "dossard": 437, "equipe": "Saint Jean Espérance"}, {"id": "excel_438", "prenom": "Patricia", "nom": "(Colibri)", "dossard": 438, "equipe": "Colibri"}, {"id": "excel_439", "prenom": "Patricia", "nom": "COCHIN", "dossard": 439, "equipe": "ALDEV"}, {"id": "excel_440", "prenom": "Patricia", "nom": "JANNIN", "dossard": 440, "equipe": "Yendouboame"}, {"id": "excel_441", "prenom": "Patrick", "nom": "GUENANTEN", "dossard": 441, "equipe": "AXA Prévoyance et Patrimoine"}, {"id": "excel_442", "prenom": "Paul", "nom": "Blandin", "dossard": 442, "equipe": "Ecole Saint Serge"}, {"id": "excel_443", "prenom": "Paul", "nom": "BOURGEOIS", "dossard": 443, "equipe": "Le Gouvernail"}, {"id": "excel_444", "prenom": "Paul", "nom": "Kugener", "dossard": 444, "equipe": "LVA Le Logis"}, {"id": "excel_445", "prenom": "Paul", "nom": "MILLAN", "dossard": 445, "equipe": "Saint Jean Espérance"}, {"id": "excel_446", "prenom": "Paul", "nom": "POUPON", "dossard": 446, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_447", "prenom": "PAUL", "nom": "PROVOST", "dossard": 447, "equipe": "Octopus Patrimoine"}, {"id": "excel_448", "prenom": "Paul", "nom": "Ramé", "dossard": 448, "equipe": "Xilo Menuiserie"}, {"id": "excel_449", "prenom": "Pauline", "nom": "CHEVRINAIS", "dossard": 449, "equipe": "FSDV"}, {"id": "excel_450", "prenom": "Pauline", "nom": "Laroche", "dossard": 450, "equipe": "Marie Durand"}, {"id": "excel_451", "prenom": "Paulos", "nom": "TEKLE", "dossard": 451, "equipe": "La Rose Fraternelle"}, {"id": "excel_452", "prenom": "Pavel", "nom": "Beaudoin", "dossard": 452, "equipe": "AFOCAL"}, {"id": "excel_453", "prenom": "Pedro Jose", "nom": "Diaz", "dossard": 453, "equipe": "Ecole Saint Serge"}, {"id": "excel_454", "prenom": "Pénélope", "nom": "Lebeau", "dossard": 454, "equipe": "La cravate solidaire"}, {"id": "excel_455", "prenom": "Perrine", "nom": "JACQUET", "dossard": 455, "equipe": "FSDV"}, {"id": "excel_456", "prenom": "Philomène", "nom": "PAPIN", "dossard": 456, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_457", "prenom": "Pia", "nom": "AUDOYER", "dossard": 457, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_458", "prenom": "Pia", "nom": "de MAS LATRIE", "dossard": 458, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_459", "prenom": "Pierre", "nom": "(Colibri)", "dossard": 459, "equipe": "Colibri"}, {"id": "excel_460", "prenom": "Pierre", "nom": "Boisneau", "dossard": 460, "equipe": "6e Régiment du Génie d’Angers"}, {"id": "excel_461", "prenom": "Pierre", "nom": "Cottreau", "dossard": 461, "equipe": "Nameshield"}, {"id": "excel_462", "prenom": "Pierre", "nom": "LEUYET", "dossard": 462, "equipe": "Saint Jean Espérance"}, {"id": "excel_463", "prenom": "Pierre", "nom": "PETIT", "dossard": 463, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_464", "prenom": "Pierre-Louis", "nom": "Bonamy", "dossard": 464, "equipe": "Maîtrise des Pays de la Loire"}, {"id": "excel_465", "prenom": "Quentin", "nom": "FRESNAIS", "dossard": 465, "equipe": "Solar Bird"}, {"id": "excel_466", "prenom": "Quentin", "nom": "MOREAU", "dossard": 466, "equipe": "Solar Bird"}, {"id": "excel_467", "prenom": "Quitterie", "nom": "Perchais", "dossard": 467, "equipe": null}, {"id": "excel_468", "prenom": "Rachel", "nom": "(Colibri)", "dossard": 468, "equipe": "Colibri"}, {"id": "excel_469", "prenom": "Rafael", "nom": "(Colibri)", "dossard": 469, "equipe": "Colibri"}, {"id": "excel_470", "prenom": "Rebecca", "nom": "Marias", "dossard": 470, "equipe": "Marie Durand"}, {"id": "excel_471", "prenom": "Rémy", "nom": "LUISIER", "dossard": 471, "equipe": "LE JARDIN DE COCAGNE ANGEVIN"}, {"id": "excel_472", "prenom": "Riad", "nom": "Qial", "dossard": 472, "equipe": "Ecole Saint Serge"}, {"id": "excel_473", "prenom": "Richard", "nom": "FOURMOND", "dossard": 473, "equipe": "Solar Bird"}, {"id": "excel_474", "prenom": "Robinson", "nom": "Berthet", "dossard": 474, "equipe": "Campus ESPL"}, {"id": "excel_475", "prenom": "Roch", "nom": "de QUATREBARBES", "dossard": 475, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_476", "prenom": "Romaric", "nom": "PAULMIER", "dossard": 476, "equipe": "AXA Prévoyance et Patrimoine"}, {"id": "excel_477", "prenom": "Sacha", "nom": "Cimetière", "dossard": 477, "equipe": "Xilo Menuiserie"}, {"id": "excel_478", "prenom": "Salima", "nom": "DJABRAILOVA", "dossard": 478, "equipe": "La Rose Fraternelle"}, {"id": "excel_479", "prenom": "Sandra", "nom": "ELINEAU", "dossard": 479, "equipe": "AXA Prévoyance et Patrimoine"}, {"id": "excel_480", "prenom": "SANNA", "nom": "Tourneux", "dossard": 480, "equipe": "Ecole Saint Serge"}, {"id": "excel_481", "prenom": "Sara", "nom": "(Colibri)", "dossard": 481, "equipe": "Colibri"}, {"id": "excel_482", "prenom": "Sarah", "nom": "Ledroit", "dossard": 482, "equipe": "6e Régiment du Génie d’Angers"}, {"id": "excel_483", "prenom": "Shaina", "nom": "QUEVREUX GARNIER", "dossard": 483, "equipe": "Marie Durand"}, {"id": "excel_484", "prenom": "Sixtine", "nom": "HERUBEL", "dossard": 484, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_485", "prenom": "Sixtine", "nom": "LABORDE", "dossard": 485, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_486", "prenom": "Sixtine", "nom": "LECOQ-VALLON", "dossard": 486, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_487", "prenom": "sofya", "nom": "delestre", "dossard": 487, "equipe": "Campus ESPL"}, {"id": "excel_488", "prenom": "Solene", "nom": "ROBERT", "dossard": 488, "equipe": null}, {"id": "excel_489", "prenom": "Solène", "nom": "LE MARCHAND", "dossard": 489, "equipe": "FSDV"}, {"id": "excel_490", "prenom": "Solveig", "nom": "DEHEN", "dossard": 490, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_491", "prenom": "Sophie", "nom": "Jollivet", "dossard": 491, "equipe": "Nameshield"}, {"id": "excel_492", "prenom": "Sophie", "nom": "LEROUX", "dossard": 492, "equipe": "La Rose Fraternelle"}, {"id": "excel_493", "prenom": "Stacie", "nom": "ROULLOIS", "dossard": 493, "equipe": "Assureurs associés"}, {"id": "excel_494", "prenom": "stanislas", "nom": "Poulain", "dossard": 494, "equipe": "Solar Bird"}, {"id": "excel_495", "prenom": "Stéphane", "nom": "(Colibri)", "dossard": 495, "equipe": "Colibri"}, {"id": "excel_496", "prenom": "Steve", "nom": "BERTRAND", "dossard": 496, "equipe": "Solar Bird"}, {"id": "excel_497", "prenom": "Suzanne", "nom": "CHAVANES", "dossard": 497, "equipe": "Le Gouvernail"}, {"id": "excel_498", "prenom": "Suzanne", "nom": "Suzanne Ouvrard", "dossard": 498, "equipe": "PARRAINS PAR MILLE"}, {"id": "excel_499", "prenom": "Sylvain", "nom": "(Colibri)", "dossard": 499, "equipe": "Colibri"}, {"id": "excel_500", "prenom": "Sylvain", "nom": "Ménoret", "dossard": 500, "equipe": "ADEPAPE-Repairs! 49"}, {"id": "excel_501", "prenom": "Sylvain", "nom": "Verardo", "dossard": 501, "equipe": null}, {"id": "excel_502", "prenom": "Sylvie", "nom": "GODARD", "dossard": 502, "equipe": "ADEPAPE-Repairs! 49"}, {"id": "excel_503", "prenom": "Syméon", "nom": "LUISIER", "dossard": 503, "equipe": "Le Gouvernail"}, {"id": "excel_504", "prenom": "Taylor", "nom": "(Colibri)", "dossard": 504, "equipe": "Colibri"}, {"id": "excel_505", "prenom": "Teame", "nom": "GIRMAY", "dossard": 505, "equipe": "LE JARDIN DE COCAGNE ANGEVIN"}, {"id": "excel_506", "prenom": "Teo", "nom": "BABOU", "dossard": 506, "equipe": "Saint Jean Espérance"}, {"id": "excel_507", "prenom": "Théo", "nom": "Fouble", "dossard": 507, "equipe": "T'CAP-T'PRO"}, {"id": "excel_508", "prenom": "Théo", "nom": "Marchesseau", "dossard": 508, "equipe": "LVA Le Logis"}, {"id": "excel_509", "prenom": "Théodore", "nom": "d'Oysonville", "dossard": 509, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_510", "prenom": "Théodore", "nom": "RAMÉ", "dossard": 510, "equipe": "FSDV"}, {"id": "excel_511", "prenom": "Théophile", "nom": "JUCHET", "dossard": 511, "equipe": "Le Gouvernail"}, {"id": "excel_512", "prenom": "Thibault", "nom": "Gallouedec", "dossard": 512, "equipe": "À Deux Mains"}, {"id": "excel_513", "prenom": "thibault", "nom": "Royer", "dossard": 513, "equipe": "ADEPAPE-Repairs! 49"}, {"id": "excel_514", "prenom": "Thibaut", "nom": "CAUSSE", "dossard": 514, "equipe": "Xilo Menuiserie"}, {"id": "excel_515", "prenom": "Thierry", "nom": "Subranne", "dossard": 515, "equipe": null}, {"id": "excel_516", "prenom": "Thomas", "nom": "DABOUT", "dossard": 516, "equipe": "Nameshield"}, {"id": "excel_517", "prenom": "Thomas", "nom": "de FLAUJAC", "dossard": 517, "equipe": "Saint Jean Espérance"}, {"id": "excel_518", "prenom": "Thomas", "nom": "NGUYEN", "dossard": 518, "equipe": "Campus ESPL"}, {"id": "excel_519", "prenom": "Thomas", "nom": "PATTYN", "dossard": 519, "equipe": "AXA Prévoyance et Patrimoine"}, {"id": "excel_520", "prenom": "Timéo", "nom": "Robin", "dossard": 520, "equipe": "T'CAP-T'PRO"}, {"id": "excel_521", "prenom": "Timothée", "nom": "BONHOURE", "dossard": 521, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_522", "prenom": "Timothée", "nom": "DE CARVALHO", "dossard": 522, "equipe": "Le Gouvernail"}, {"id": "excel_523", "prenom": "Tita", "nom": "Arai", "dossard": 523, "equipe": "6e Régiment du Génie d’Angers"}, {"id": "excel_524", "prenom": "Tiurai", "nom": "Pahi", "dossard": 524, "equipe": "6e Régiment du Génie d’Angers"}, {"id": "excel_525", "prenom": "TOAN", "nom": "Guennec", "dossard": 525, "equipe": "Ecole Saint Serge"}, {"id": "excel_526", "prenom": "Tom", "nom": "Guillot", "dossard": 526, "equipe": "Campus ESPL"}, {"id": "excel_527", "prenom": "TOM", "nom": "Teillet", "dossard": 527, "equipe": "Ecole Saint Serge"}, {"id": "excel_528", "prenom": "Tonyo", "nom": "(Colibri)", "dossard": 528, "equipe": "Colibri"}, {"id": "excel_529", "prenom": "Véronique", "nom": "HUVELIN", "dossard": 529, "equipe": "Le Gouvernail"}, {"id": "excel_530", "prenom": "Vianney", "nom": "de Bagneaux", "dossard": 530, "equipe": null}, {"id": "excel_531", "prenom": "Victoire", "nom": "BOUREZ", "dossard": 531, "equipe": "Le Gouvernail"}, {"id": "excel_532", "prenom": "Victor", "nom": "LEBRETON", "dossard": 532, "equipe": "Pas à Pas 49"}, {"id": "excel_533", "prenom": "Victor", "nom": "MARÉCHAL", "dossard": 533, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_534", "prenom": "Victor", "nom": "Vieilfault", "dossard": 534, "equipe": "Agapè Anjou"}, {"id": "excel_535", "prenom": "Victor", "nom": "WILLOTEAUX", "dossard": 535, "equipe": "Campus ESPL"}, {"id": "excel_536", "prenom": "VICTORIA", "nom": "Chauvigné", "dossard": 536, "equipe": "Ecole Saint Serge"}, {"id": "excel_537", "prenom": "Vincent", "nom": "Bruggeman", "dossard": 537, "equipe": "À Deux Mains"}, {"id": "excel_538", "prenom": "Vincent", "nom": "FARGUE", "dossard": 538, "equipe": "Le Gouvernail"}, {"id": "excel_539", "prenom": "Violette", "nom": "Schot", "dossard": 539, "equipe": "La cravate solidaire"}, {"id": "excel_540", "prenom": "VIRGIL", "nom": "RIZZI", "dossard": 540, "equipe": "Nameshield"}, {"id": "excel_541", "prenom": "Virginie", "nom": "PAYRAUDEAU", "dossard": 541, "equipe": "FSDV"}, {"id": "excel_542", "prenom": "Viviane", "nom": "Mols Viviane", "dossard": 542, "equipe": "Réseau Entreprendre Maine et Loire"}, {"id": "excel_543", "prenom": "Wahid", "nom": "Gazoum", "dossard": 543, "equipe": null}, {"id": "excel_544", "prenom": "Wilfried", "nom": "Cesbron", "dossard": 544, "equipe": null}, {"id": "excel_545", "prenom": "Wilfried", "nom": "GAUDY", "dossard": 545, "equipe": "AXA Prévoyance et Patrimoine"}, {"id": "excel_546", "prenom": "WILLIAM", "nom": "MICHEL", "dossard": 546, "equipe": "Marie Durand"}, {"id": "excel_547", "prenom": "Xavier", "nom": "LEGUEN", "dossard": 547, "equipe": "FSDV"}, {"id": "excel_548", "prenom": "Yanis", "nom": "AITOUELHAJ", "dossard": 548, "equipe": "Le Gouvernail"}, {"id": "excel_549", "prenom": "Yann", "nom": "Schnabel", "dossard": 549, "equipe": "Saint Jean Espérance"}, {"id": "excel_550", "prenom": "Yannick", "nom": "Godefroy", "dossard": 550, "equipe": "Marie Durand"}, {"id": "excel_551", "prenom": "Yasmina", "nom": "CHOUCHEN", "dossard": 551, "equipe": "Le Gouvernail"}, {"id": "excel_552", "prenom": "Yoan", "nom": "(Colibri)", "dossard": 552, "equipe": "Colibri"}, {"id": "excel_553", "prenom": "Yoann", "nom": "Moret", "dossard": 553, "equipe": "Département de Maine-et-Loire"}, {"id": "excel_554", "prenom": "Yohan", "nom": "Leleu", "dossard": 554, "equipe": "Nameshield"}, {"id": "excel_555", "prenom": "Yohann", "nom": "BESNARD", "dossard": 555, "equipe": "FSDV"}, {"id": "excel_556", "prenom": "Youri", "nom": "Gomis Fournier", "dossard": 556, "equipe": "Ecole Saint Serge"}, {"id": "excel_557", "prenom": "Yves", "nom": "ANTHONIOZ", "dossard": 557, "equipe": "Saint Jean Espérance"}, {"id": "excel_558", "prenom": "Zélie", "nom": "DE KERGORLAY", "dossard": 558, "equipe": "Le Gouvernail"}, {"id": "excel_559", "prenom": "Zita", "nom": "de LA CROIX", "dossard": 559, "equipe": "Cours Bienheureux Charles d'Autriche"}, {"id": "excel_560", "prenom": "ZOE", "nom": "Raballand", "dossard": 560, "equipe": "Ecole Saint Serge"}, {"id": "excel_561", "prenom": "Zyhann", "nom": "SAUNIER RANARISON", "dossard": 561, "equipe": "Marie Durand"}, {"id": "excel_562", "prenom": "Anthony", "nom": "GARREAU", "dossard": 562, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_563", "prenom": "Antoine", "nom": "HERAULT", "dossard": 563, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_564", "prenom": "Antonin", "nom": "Trédan", "dossard": 564, "equipe": "La Maison commune - UPE"}, {"id": "excel_565", "prenom": "Arron", "nom": "Guilbault", "dossard": 565, "equipe": "ETHIK KEHF"}, {"id": "excel_566", "prenom": "Arthur", "nom": "LERAY", "dossard": 566, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_567", "prenom": "Baptiste", "nom": "GENET DE CHATENAY", "dossard": 567, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_568", "prenom": "Béatrice", "nom": "PICARD", "dossard": 568, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_569", "prenom": "Bertrand", "nom": "MEME", "dossard": 569, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_570", "prenom": "Brandon", "nom": "Thévenet", "dossard": 570, "equipe": "La Maison commune - UPE"}, {"id": "excel_571", "prenom": "Bryan", "nom": "BOMPAS", "dossard": 571, "equipe": "ADEPAPE-Repairs! 49"}, {"id": "excel_572", "prenom": "Cecile", "nom": "THOMY", "dossard": 572, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_573", "prenom": "Cedric", "nom": "Bechu", "dossard": 573, "equipe": null}, {"id": "excel_574", "prenom": "Christian", "nom": "Gohore", "dossard": 574, "equipe": "ETHIK KEHF"}, {"id": "excel_575", "prenom": "Clément", "nom": "BOUTIN", "dossard": 575, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_576", "prenom": "Corentin", "nom": "HERVE", "dossard": 576, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_577", "prenom": "Corentin", "nom": "Prampart", "dossard": 577, "equipe": "ETHIK KEHF"}, {"id": "excel_578", "prenom": "Cyril", "nom": "Boukerrou", "dossard": 578, "equipe": "ETHIK KEHF"}, {"id": "excel_579", "prenom": "Cyril", "nom": "CROUZET", "dossard": 579, "equipe": "ANJOU LOIRE TERRITOIRE"}, {"id": "excel_580", "prenom": "Cyrille", "nom": "THOMY", "dossard": 580, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_581", "prenom": "Damien", "nom": "TOUCHET", "dossard": 581, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_582", "prenom": "Danya", "nom": "Azzoug", "dossard": 582, "equipe": "ETHIK KEHF"}, {"id": "excel_583", "prenom": "Emilie", "nom": "Langlais", "dossard": 583, "equipe": "AFOCAL"}, {"id": "excel_584", "prenom": "Enzo", "nom": "Amougou", "dossard": 584, "equipe": "ETHIK KEHF"}, {"id": "excel_585", "prenom": "Evan", "nom": "Borhis", "dossard": 585, "equipe": "ETHIK KEHF"}, {"id": "excel_586", "prenom": "Fabien", "nom": "BOUCHET", "dossard": 586, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_587", "prenom": "Fabien", "nom": "GIRARDEAU", "dossard": 587, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_588", "prenom": "Fatimé", "nom": "Adoum Idriss", "dossard": 588, "equipe": "ETHIK KEHF"}, {"id": "excel_589", "prenom": "Fatoumata", "nom": "Dabo", "dossard": 589, "equipe": "ETHIK KEHF"}, {"id": "excel_590", "prenom": "Florian", "nom": "DAUDIN", "dossard": 590, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_591", "prenom": "François-Xavier", "nom": "GROLLEAU", "dossard": 591, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_592", "prenom": "Jeremy", "nom": "TAILLANDIER", "dossard": 592, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_593", "prenom": "Joachim", "nom": "Cochard", "dossard": 593, "equipe": "ETHIK KEHF"}, {"id": "excel_594", "prenom": "Juliane", "nom": "GASNIER", "dossard": 594, "equipe": "ANJOU LOIRE TERRITOIRE"}, {"id": "excel_595", "prenom": "Julien", "nom": "CIROT", "dossard": 595, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_596", "prenom": "Julien", "nom": "RICHARD", "dossard": 596, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_597", "prenom": "Katia", "nom": "THOMY", "dossard": 597, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_598", "prenom": "Kevin", "nom": "RETHORE", "dossard": 598, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_599", "prenom": "Lèmia", "nom": "Gamry", "dossard": 599, "equipe": "ETHIK KEHF"}, {"id": "excel_600", "prenom": "Louann", "nom": "LARDEUX", "dossard": 600, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_601", "prenom": "Lucille", "nom": "CROCHARD", "dossard": 601, "equipe": "ANJOU LOIRE TERRITOIRE"}, {"id": "excel_602", "prenom": "Ludovic", "nom": "JARRY", "dossard": 602, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_603", "prenom": "Mackeal", "nom": "Bezin", "dossard": 603, "equipe": "ETHIK KEHF"}, {"id": "excel_604", "prenom": "Mael", "nom": "Paris", "dossard": 604, "equipe": "ETHIK KEHF"}, {"id": "excel_605", "prenom": "Marc", "nom": "LAFLEUR", "dossard": 605, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_606", "prenom": "Marie", "nom": "Bordier", "dossard": 606, "equipe": null}, {"id": "excel_607", "prenom": "Marie-Lise", "nom": "DESCHAMPS", "dossard": 607, "equipe": "Marie Durand"}, {"id": "excel_608", "prenom": "Marine", "nom": "HUMEAU", "dossard": 608, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_609", "prenom": "Marvin", "nom": "Ndouba", "dossard": 609, "equipe": "ETHIK KEHF"}, {"id": "excel_610", "prenom": "Matheo", "nom": "Changeon Monot", "dossard": 610, "equipe": "ETHIK KEHF"}, {"id": "excel_611", "prenom": "Maxime", "nom": "CHALLET", "dossard": 611, "equipe": "ANJOU LOIRE TERRITOIRE"}, {"id": "excel_612", "prenom": "Mickael", "nom": "VIDREQUIN", "dossard": 612, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_613", "prenom": "Nelwel", "nom": "Bendcor", "dossard": 613, "equipe": "ETHIK KEHF"}, {"id": "excel_614", "prenom": "Noah", "nom": "Batard", "dossard": 614, "equipe": "ETHIK KEHF"}, {"id": "excel_615", "prenom": "Noah", "nom": "Mc Clendon", "dossard": 615, "equipe": "ETHIK KEHF"}, {"id": "excel_616", "prenom": "Samira", "nom": "De Sousa Carreira", "dossard": 616, "equipe": "ETHIK KEHF"}, {"id": "excel_617", "prenom": "Sarah", "nom": "Deguil", "dossard": 617, "equipe": "ANJOU LOIRE TERRITOIRE"}, {"id": "excel_618", "prenom": "Scarlett", "nom": "Pollet", "dossard": 618, "equipe": "ANJOU LOIRE TERRITOIRE"}, {"id": "excel_619", "prenom": "Steven", "nom": "MERAND", "dossard": 619, "equipe": "Les pompiers du SDIS 49"}, {"id": "excel_620", "prenom": "Styliven", "nom": "Menard Bodereau", "dossard": 620, "equipe": "La Maison commune - UPE"}, {"id": "excel_621", "prenom": "Tanguy", "nom": "Morin Grosbois", "dossard": 621, "equipe": "ETHIK KEHF"}, {"id": "excel_622", "prenom": "Théo", "nom": "Keller", "dossard": 622, "equipe": "La Maison commune - UPE"}, {"id": "excel_623", "prenom": "Youness", "nom": "Dagnet Soulaigre", "dossard": 623, "equipe": "ETHIK KEHF"},
    {"id": "excel_624", "prenom": "pauline", "nom": "piet", "dossard": 624, "equipe": null}, {"id": "excel_625", "prenom": "Samar", "nom": "Mohamed Ali", "dossard": 625, "equipe": null}, {"id": "excel_626", "prenom": "Mahnoor", "nom": "Mohamed Ali", "dossard": 626, "equipe": null}, {"id": "excel_627", "prenom": "Afifa", "nom": "Barkallah", "dossard": 627, "equipe": "Colibri"}, {"id": "excel_628", "prenom": "Sophie", "nom": "Graemiger", "dossard": 628, "equipe": "Colibri"}, {"id": "excel_629", "prenom": "Charlotte", "nom": "Ponsard", "dossard": 629, "equipe": "Esperancia"}, {"id": "excel_630", "prenom": "Tanguy", "nom": "Queinnec", "dossard": 630, "equipe": "Marie Durand"}, {"id": "excel_631", "prenom": "Alix", "nom": "Bechu", "dossard": 631, "equipe": null}];
    
    // Charger ce qui est déjà dans Redis (depuis Ohme)
    const raw = await redisGet(REDIS_KEY);
    const dejaDans = (raw ? JSON.parse(raw) : []).filter(c => !c.id.startsWith('excel_'));
    const dejaIds  = new Set(dejaDans.map(c => c.id));
    
    // Construire la liste finale : données Excel en priorité (plus complètes)
    // Pour les doublons, on garde la donnée Excel
    const parDossard = {};
    
    // D'abord les données Ohme
    for (const c of dejaDans) {
      parDossard[c.dossard] = c;
    }
    // Ensuite les données Excel (écrasent Ohme si même dossard)
    for (const c of COUREURS_EXCEL) {
      parDossard[c.dossard] = c;
    }
    
    const tous = Object.values(parDossard);
    tous.sort((a, b) => a.dossard - b.dossard);
    
    await saveToRedis(tous);
    _memCache     = tous;
    _memCacheTime = Date.now();
    
    res.json({
      success: true,
      total: tous.length,
      depuis_excel: COUREURS_EXCEL.length,
      depuis_ohme: dejaDans.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── Routes résultats ─────────────────────────────────────────────────────────

// Charge les résultats depuis Ohme (contacts + structures)
async function loadResultats() {
  console.log('Chargement résultats depuis Ohme...');

  // 1. Contacts : km_parcourus_angers2026 + classement_angers2026
  const contacts = [];
  let cursor = null;
  while (true) {
    await sleep(DELAY);
    const url = cursor
      ? `${OHME_BASE}/api/v1/contacts?limit=500&cursor=${encodeURIComponent(cursor)}`
      : `${OHME_BASE}/api/v1/contacts?limit=500`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) break;
    const json = await res.json();
    const items = json.data || [];
    contacts.push(...items);
    cursor = json.cursor || null;
    if (!cursor || items.length < 500) break;
  }

  // 2. Structures : km_parcourus_equipe_angers_2026 + classement_angers20261
  const structures = [];
  let cursorS = null;
  while (true) {
    await sleep(DELAY);
    const url = cursorS
      ? `${OHME_BASE}/api/v1/structures?limit=500&cursor=${encodeURIComponent(cursorS)}`
      : `${OHME_BASE}/api/v1/structures?limit=500`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) break;
    const json = await res.json();
    const items = json.data || [];
    structures.push(...items);
    cursorS = json.cursor || null;
    if (!cursorS || items.length < 500) break;
  }

  // Construire classement coureurs
  const classementCoureurs = contacts
    .map(c => ({
      prenom:     c.firstname || '',
      nom:        c.lastname  || '',
      km:         parseFloat(c.km_parcourus_angers2026 || 0),
      classement: parseInt(c.classement_angers2026 || 0),
      dossard:    parseInt(c.numero_dossard_angers_2026 || 0),
    }))
    .filter(c => c.km > 0 || c.classement > 0)
    .sort((a, b) => (a.classement || 9999) - (b.classement || 9999));

  // Construire classement équipes
  const classementEquipes = structures
    .map(s => ({
      equipe:     s.name || '',
      km:         parseFloat(s.km_parcourus_equipe_angers_2026 || 0),
      classement: parseInt(s.classement_angers20261 || 0),
    }))
    .filter(e => e.km > 0 || e.classement > 0)
    .sort((a, b) => (a.classement || 9999) - (b.classement || 9999));

  console.log(`${classementCoureurs.length} coureurs classés, ${classementEquipes.length} équipes classées.`);
  return { coureurs: classementCoureurs, equipes: classementEquipes };
}

// GET /api/resultats — lit depuis Redis
app.get('/api/resultats', async (req, res) => {
  try {
    const raw = await redisGet('defi_enfance_resultats');
    if (raw) {
      return res.json(JSON.parse(raw));
    }
    res.json({ coureurs: [], equipes: [], message: 'Pas encore de résultats — utilisez /api/resultats/refresh' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/resultats/refresh — charge depuis Ohme et sauvegarde dans Redis
app.get('/api/resultats/refresh', async (req, res) => {
  try {
    const data = await loadResultats();
    await saveToRedis_key('defi_enfance_resultats', JSON.stringify(data), 24 * 60 * 60);
    res.json({ success: true, coureurs: data.coureurs.length, equipes: data.equipes.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () =>
  console.log(`Défi Enfance API démarrée sur le port ${PORT}`)
);

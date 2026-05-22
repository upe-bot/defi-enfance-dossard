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
const DELAY = 300;

const REDIS_KEY     = 'defi_enfance_dossards';
const REDIS_TTL_SEC = 6 * 60 * 60; // 6 heures

// ── Redis Upstash
async function redisGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.result ?? null;
  } catch { return null; }
}

async function redisSet(key, value, ttlSec) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
  try {
    const res = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ value, ex: ttlSec }),
    });
    return res.ok;
  } catch { return false; }
}

// ── Ohme
async function fetchAllPayments() {
  const all = [];
  let cursor = null;
  while (true) {
    await sleep(DELAY);
    const url = cursor
      ? `${OHME_BASE}/api/v1/payments?payment_type_id=3&limit=250&since_date=2026-01-01&cursor=${encodeURIComponent(cursor)}`
      : `${OHME_BASE}/api/v1/payments?payment_type_id=3&limit=250&since_date=2026-01-01`;
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

async function fetchContactById(contactId) {
  await sleep(DELAY);
  const res = await fetch(`${OHME_BASE}/api/v1/contacts/${contactId}`, { headers: HEADERS });
  if (!res.ok) return null;
  const json = await res.json();
  return json.data || json;
}

// ── Chargement complet depuis Ohme (~3 min pour 630 coureurs)
async function loadFromOhme() {
  console.log('Chargement des paiements Ohme...');
  const rawPayments = await fetchAllPayments();
  console.log(`${rawPayments.length} paiements récupérés.`);

  // Dédoublonner les coureurs Angers
  const contactIds = new Map();
  for (const p of rawPayments) {
    if (!p.contact_id) continue;
    const eventName = (p.nom_de_levent || '').toUpperCase();
    if (!eventName.includes('ANGERS')) continue;
    const qualite = (p.qualite_du_participant || '').toLowerCase();
    if (qualite === 'don attendu' || qualite === 'exclu') continue;
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
      equipe:  (paiement.equipe || '').trim() || null,
    });
  }

  console.log(`${coureurs.length} coureurs avec dossard chargés depuis Ohme.`);
  return coureurs;
}

// ── getData : Redis d'abord, puis Ohme si absent
let _memCache     = null;
let _memCacheTime = 0;
const MEM_TTL = 5 * 60 * 1000; // 5 min en mémoire

async function getData() {
  // 1. Cache mémoire (5 min) — évite les appels Redis répétés
  if (_memCache && Date.now() - _memCacheTime < MEM_TTL) return _memCache;

  // 2. Redis (6h) — survit aux redémarrages Render
  const raw = await redisGet(REDIS_KEY);
  if (raw) {
    try {
      const coureurs = JSON.parse(raw);
      console.log(`${coureurs.length} coureurs chargés depuis Redis.`);
      _memCache     = coureurs;
      _memCacheTime = Date.now();
      return coureurs;
    } catch { console.log('Redis parse error — rechargement depuis Ohme'); }
  }

  // 3. Ohme — chargement complet (~3 min)
  const coureurs = await loadFromOhme();

  // Sauvegarder dans Redis pour les prochains démarrages
  const ok = await redisSet(REDIS_KEY, JSON.stringify(coureurs), REDIS_TTL_SEC);
  console.log(`Sauvegarde Redis : ${ok ? 'OK' : 'échec'}`);

  _memCache     = coureurs;
  _memCacheTime = Date.now();
  return coureurs;
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

// Force le rechargement depuis Ohme et met à jour Redis
app.get('/api/refresh', async (req, res) => {
  try {
    console.log('Rechargement forcé depuis Ohme...');
    _memCache     = null;
    _memCacheTime = 0;
    await redisSet(REDIS_KEY, '', 1); // expire Redis immédiatement
    const coureurs = await loadFromOhme();
    const ok = await redisSet(REDIS_KEY, JSON.stringify(coureurs), REDIS_TTL_SEC);
    _memCache     = coureurs;
    _memCacheTime = Date.now();
    res.json({ success: true, count: coureurs.length, redis: ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () =>
  console.log(`Défi Enfance API démarrée sur le port ${PORT}`)
);

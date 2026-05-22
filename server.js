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

async function loadFromOhme() {
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
  return coureurs;
}

// ── Cache mémoire + Redis
let _memCache     = null;
let _memCacheTime = 0;
const MEM_TTL  = 5 * 60 * 1000;
let _loading   = false; // verrou anti-chargements parallèles
let _loadingP  = null;  // promesse partagée

async function getData() {
  // 1. Cache mémoire
  if (_memCache && Date.now() - _memCacheTime < MEM_TTL) return _memCache;

  // 2. Redis
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

  // 3. Ohme — avec verrou pour éviter les chargements parallèles
  if (_loading) {
    console.log('Chargement déjà en cours, attente...');
    return _loadingP;
  }
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
  return _loadingP;
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

app.listen(PORT, () =>
  console.log(`Défi Enfance API démarrée sur le port ${PORT}`)
);

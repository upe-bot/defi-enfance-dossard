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
const DELAY = 800;
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
        await sleep(10000);
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

  // 3. Ohme — avec verrou mémoire + Redis pour éviter les chargements parallèles
  if (_loading) {
    console.log('Chargement déjà en cours (mémoire), attente...');
    return _loadingP;
  }
  _loading  = true;
  _loadingP = (async () => {
    try {
      const coureurs = await loadFromOhme();
      if (coureurs === null) {
        // Une autre instance charge déjà — on attend et on relit Redis dans 30s
        console.log('Autre instance en cours — attente 30s puis relecture Redis...');
        await sleep(30000);
        const raw2 = await redisGet(REDIS_KEY);
        if (raw2) {
          const c2 = JSON.parse(raw2);
          if (Array.isArray(c2) && c2.length > 0) return c2;
        }
        return _memCache || [];
      }
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

app.listen(PORT, () =>
  console.log(`Défi Enfance API démarrée sur le port ${PORT}`)
);

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

const OHME_BASE          = (process.env.OHME_BASE_URL || '').replace(/\/$/, '');
const OHME_CLIENT_NAME   = process.env.OHME_CLIENT_NAME;
const OHME_CLIENT_SECRET = process.env.OHME_CLIENT_SECRET;

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

async function fetchAllContacts() {
  const all = [];
  let cursor = null;
  while (true) {
    const url = cursor
      ? `${OHME_BASE}/api/v1/contacts?limit=500&include[]=custom_fields&cursor=${encodeURIComponent(cursor)}`
      : `${OHME_BASE}/api/v1/contacts?limit=500&include[]=custom_fields`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`Contacts Ohme ${res.status}`);
    const json  = await res.json();
    const root  = Array.isArray(json) ? json[0] : json;
    const items = root.data || [];
    all.push(...items);
    cursor = root.cursor || null;
    if (!cursor || items.length < 500) break;
  }
  return all;
}

async function fetchAllPayments() {
  const all = [];
  let cursor = null;
  while (true) {
    const url = cursor
      ? `${OHME_BASE}/api/v1/payments?payment_type_id=3&limit=250&since_date=2026-01-01&cursor=${encodeURIComponent(cursor)}`
      : `${OHME_BASE}/api/v1/payments?payment_type_id=3&limit=250&since_date=2026-01-01`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`Payments Ohme ${res.status}`);
    const json  = await res.json();
    const root  = Array.isArray(json) ? json[0] : json;
    const items = root.data || json.data || (Array.isArray(json) ? [] : json) || [];
    all.push(...items);
    cursor = root.cursor || null;
    if (!cursor || items.length < 250) break;
  }
  return all;
}

function fmtContact(c) {
  const f = c.custom_fields || {};
  return {
    id:      String(c.id),
    prenom:  c.firstname || '',
    nom:     c.lastname  || '',
    dossard: f.numero_dossard_angers_2026 ?? null,
    equipe:  null,
  };
}

let _cache     = null;
let _cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function getData() {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;

  console.log('Chargement contacts + paiements Ohme...');
  const [rawContacts, rawPayments] = await Promise.all([
    fetchAllContacts(),
    fetchAllPayments(),
  ]);

  console.log(`${rawContacts.length} contacts, ${rawPayments.length} paiements récupérés.`);

  const equipeByContactId = new Map();
  for (const p of rawPayments) {
    if (!p.contact_id) continue;
    const cf     = p.custom_fields || p;
    const equipe = (cf.equipe || '').trim();
    if (equipe) equipeByContactId.set(String(p.contact_id), equipe);
  }

  const contacts = rawContacts
    .map(c => {
      const fmt = fmtContact(c);
      fmt.equipe = equipeByContactId.get(fmt.id) || null;
      return fmt;
    })
    .filter(c => c.dossard !== null && c.dossard !== undefined && c.dossard !== '');

  console.log(`${contacts.length} coureurs avec dossard chargés.`);
  _cache     = contacts;
  _cacheTime = Date.now();
  return _cache;
}

app.get('/health', (_, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
);

// Route debug temporaire — à supprimer après vérification
app.get('/api/debug', async (req, res) => {
  const raw = await fetchAllContacts();
  res.json(raw.slice(0, 2));
});

app.get('/api/search', async (req, res) => {
  try {
    const { q, type } = req.query;
    if (!q || q.trim().length < 2)
      return res.status(400).json({ error: 'Au moins 2 caractères requis.' });

    const term     = q.trim().toLowerCase();
    const contacts = await getData();
    let results    = [];

    if (type === 'equipe') {
      results = contacts
        .filter(c => c.equipe && c.equipe.toLowerCase() === term)
        .sort((a, b) => a.prenom.localeCompare(b.prenom, 'fr'));
    } else {
      results = contacts
        .filter(c => {
          const nom    = c.nom.toLowerCase();
          const prenom = c.prenom.toLowerCase();
          return nom.includes(term) || prenom.includes(term);
        })
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
    const contacts = await getData();
    const equipes  = [
      ...new Set(contacts.map(c => c.equipe).filter(Boolean))
    ].sort((a, b) => a.localeCompare(b, 'fr'));
    res.json({ equipes });
  } catch (err) {
    console.error('equipes error:', err.message);
    res.status(500).json({ error: 'Impossible de charger les équipes.' });
  }
});

app.listen(PORT, () =>
  console.log(`Défi Enfance API démarrée sur le port ${PORT}`)
);

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

// Charge tous les contacts via pagination cursor
async function fetchAllContacts() {
  const all = [];
  let cursor = null;

  while (true) {
    const url = cursor
      ? `${OHME_BASE}/api/v1/contacts?limit=500&cursor=${encodeURIComponent(cursor)}`
      : `${OHME_BASE}/api/v1/contacts?limit=500`;

    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Ohme ${res.status}: ${err}`);
    }

    const json = await res.json();
    const items = json.data || json.contacts || json || [];
    all.push(...items);

    cursor = json.next_cursor || json.cursor || null;
    if (!cursor || items.length === 0) break;
  }

  return all;
}

function fmt(contact) {
  const f = contact.custom_fields || {};
  return {
    id:      contact.id,
    prenom:  contact.first_name  || contact.firstname || '',
    nom:     contact.last_name   || contact.lastname  || '',
    dossard: f.numero_dossard_angers_2026 ?? null,
    equipe:  f.equipe || null,
  };
}

function hasDossard(c) {
  return c.dossard !== null && c.dossard !== undefined && c.dossard !== '';
}

// Cache en mémoire — rechargé toutes les 5 minutes
let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function getContacts() {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;
  console.log('Chargement des contacts Ohme...');
  const raw = await fetchAllContacts();
  _cache = raw.map(fmt);
  _cacheTime = Date.now();
  console.log(`${_cache.length} contacts chargés.`);
  return _cache;
}

app.get('/health', (_, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
);

app.get('/api/search', async (req, res) => {
  try {
    const { q, type } = req.query;
    if (!q || q.trim().length < 2)
      return res.status(400).json({ error: 'Au moins 2 caractères requis.' });

    const term = q.trim().toLowerCase();
    const contacts = await getContacts();
    let results = [];

    if (type === 'equipe') {
      results = contacts
        .filter(c => hasDossard(c) && c.equipe && c.equipe.toLowerCase() === term)
        .sort((a, b) => a.prenom.localeCompare(b.prenom, 'fr'));
    } else {
      results = contacts
        .filter(c => {
          if (!hasDossard(c)) return false;
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
    const contacts = await getContacts();
    const equipes = [
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

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const OHME_BASE_URL  = process.env.OHME_BASE_URL  || 'https://api.ohme.io/v1';
const OHME_CLIENT_NAME   = process.env.OHME_CLIENT_NAME;
const OHME_CLIENT_SECRET = process.env.OHME_CLIENT_SECRET;

if (!OHME_CLIENT_NAME || !OHME_CLIENT_SECRET) {
  console.error('❌  OHME_CLIENT_NAME et OHME_CLIENT_SECRET sont requis.');
  process.exit(1);
}

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET'],
}));

// ─── OAuth token cache ───────────────────────────────────────────────────────
let _token     = null;
let _tokenExp  = 0;   // timestamp ms

async function getToken() {
  if (_token && Date.now() < _tokenExp - 30_000) return _token;

  const res = await fetch(`${OHME_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type:    'client_credentials',
      client_id:     OHME_CLIENT_NAME,
      client_secret: OHME_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OAuth Ohme ${res.status}: ${err}`);
  }

  const data = await res.json();
  _token    = data.access_token;
  _tokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  console.log('🔑  Token Ohme renouvelé.');
  return _token;
}

// ─── Ohme API helper ─────────────────────────────────────────────────────────
async function ohmeGet(path, params = {}) {
  const token = await getToken();
  const url   = new URL(`${OHME_BASE_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
  });

  // token expiré en cours de route → on retente une fois
  if (res.status === 401) {
    _token = null;
    const token2 = await getToken();
    const res2   = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${token2}`, 'Content-Type': 'application/json' },
    });
    if (!res2.ok) throw new Error(`Ohme API ${res2.status}`);
    return res2.json();
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Ohme API ${res.status}: ${err}`);
  }
  return res.json();
}

// ─── Formateur contact ────────────────────────────────────────────────────────
function fmt(contact) {
  const f = contact.custom_fields || {};
  return {
    id:      contact.id,
    prenom:  contact.first_name  || '',
    nom:     contact.last_name   || '',
    dossard: f.numero_dossard_angers_2026 ?? null,
    equipe:  f.equipe            || null,
  };
}

function hasDossard(c) {
  return c.dossard !== null && c.dossard !== undefined && c.dossard !== '';
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
);

// GET /api/search?q=TERM&type=nom|equipe
app.get('/api/search', async (req, res) => {
  try {
    const { q, type } = req.query;
    if (!q || q.trim().length < 2)
      return res.status(400).json({ error: 'Au moins 2 caractères requis.' });

    const term = q.trim();
    let contacts = [];

    if (type === 'equipe') {
      const data = await ohmeGet('/contacts', {
        'custom_fields[equipe]': term,
        limit: 200,
      });
      contacts = (data.data || data.contacts || data || [])
        .map(fmt)
        .filter(hasDossard)
        .sort((a, b) => a.prenom.localeCompare(b.prenom, 'fr'));

    } else {
      // Recherche simultanée nom + prénom
      const [rNom, rPrenom] = await Promise.all([
        ohmeGet('/contacts', { last_name:  term, limit: 50 }),
        ohmeGet('/contacts', { first_name: term, limit: 50 }),
      ]);

      const seen = new Set();
      contacts = [
        ...(rNom.data   || rNom.contacts   || rNom   || []),
        ...(rPrenom.data || rPrenom.contacts || rPrenom || []),
      ]
        .map(fmt)
        .filter(c => {
          if (seen.has(c.id)) return false;
          seen.add(c.id);
          return hasDossard(c);
        })
        .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    }

    res.json({ results: contacts, count: contacts.length, query: term, type: type || 'nom' });

  } catch (err) {
    console.error('search error:', err.message);
    res.status(500).json({ error: 'Erreur serveur. Veuillez réessayer.' });
  }
});

// GET /api/equipes  — liste dédupliquée de toutes les équipes
app.get('/api/equipes', async (req, res) => {
  try {
    const data = await ohmeGet('/contacts', {
      'custom_fields[type_de_participation]': 'Coureur',
      limit: 500,
    });

    const equipes = [
      ...new Set(
        (data.data || data.contacts || data || [])
          .map(fmt)
          .map(c => c.equipe)
          .filter(Boolean)
      ),
    ].sort((a, b) => a.localeCompare(b, 'fr'));

    res.json({ equipes });
  } catch (err) {
    console.error('equipes error:', err.message);
    res.status(500).json({ error: 'Impossible de charger les équipes.' });
  }
});

app.listen(PORT, () =>
  console.log(`✅  Défi Enfance API démarrée sur le port ${PORT}`)
);

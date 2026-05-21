const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

const OHME_BASE          = (process.env.OHME_BASE_URL || '').replace(/\/$/, '');
const OHME_CLIENT_NAME   = process.env.OHME_CLIENT_NAME;
const OHME_CLIENT_SECRET = process.env.OHME_CLIENT_SECRET;

if (!OHME_CLIENT_NAME || !OHME_CLIENT_SECRET || !OHME_BASE) {
  console.error('❌  OHME_BASE_URL, OHME_CLIENT_NAME et OHME_CLIENT_SECRET sont requis.');
  process.exit(1);
}

app.use(cors({ origin: process.env.FRONTEND_URL || '*', methods: ['GET'] }));

async function ohmeGet(path, params = {}) {
  const url = new URL(`${OHME_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

  const res = await fetch(url.toString(), {
    headers: {
      'Accept':        'application/json',
      'client-name':   OHME_CLIENT_NAME,
      'client-secret': OHME_CLIENT_SECRET,
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Ohme ${res.status}: ${err}`);
  }
  return res.json();
}

function fmt(contact) {
  const f = contact.custom_fields || {};
  return {
    id:      contact.id,
    prenom:  contact.first_name || '',
    nom:     contact.last_name  || '',
    dossard: f.numero_dossard_angers_2026 ?? null,
    equipe:  f.equipe || null,
  };
}

function hasDossard(c) {
  return c.dossard !== null && c.dossard !== undefined && c.dossard !== '';
}

app.get('/health', (_, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
);

app.get('/api/search', async (req, res) => {
  try {
    const { q, type } = req.query;
    if (!q || q.trim().length < 2)
      return res.status(400).json({ error: 'Au moins 2 caractères requis.' });

    const term = q.trim();
    let contacts = [];

    if (type === 'equipe') {
      const data = await ohmeGet('/api/v1/contacts', {
        'custom_fields[equipe]': term,
        limit: 200,
      });
      contacts = (data.data || data.contacts || data || [])
        .map(fmt)
        .filter(hasDossard)
        .sort((a, b) => a.prenom.localeCompare(b.prenom, 'fr'));

    } else {
      const [rNom, rPrenom] = await Promise.all([
        ohmeGet('/api/v1/contacts', { last_name:  term, limit: 50 }),
        ohmeGet('/api/v1/contacts', { first_name: term, limit: 50 }),
      ]);

      const seen = new Set();
      contacts = [
        ...(rNom.data    || rNom.contacts    || rNom    || []),
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

app.get('/api/equipes', async (req, res) => {
  try {
    const data = await ohmeGet('/api/v1/contacts', {
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

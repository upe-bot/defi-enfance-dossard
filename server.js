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

const sleep = ms => new Promise(r => setTimeout(r, ms));
const DELAY = 300;

// ── Charge tous les paiements billetterie type 3 (contient les champs perso)
async function fetchAllPayments() {
  const all = [];
  let cursor = null;
  while (true) {
    await sleep(DELAY);
    const url = cursor
      ? `${OHME_BASE}/api/v1/payments?payment_type_id=3&limit=250&since_date=2026-01-01&cursor=${encodeURIComponent(cursor)}`
      : `${OHME_BASE}/api/v1/payments?payment_type_id=3&limit=250&since_date=2026-01-01`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`Payments Ohme ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const items = json.data || [];
    all.push(...items);
    cursor = json.cursor || null;
    if (!cursor || items.length < 250) break;
  }
  return all;
}

// ── Charge tous les contacts (pour nom/prénom)
async function fetchAllContacts() {
  const all = [];
  let cursor = null;
  while (true) {
    await sleep(DELAY);
    const url = cursor
      ? `${OHME_BASE}/api/v1/contacts?limit=500&cursor=${encodeURIComponent(cursor)}`
      : `${OHME_BASE}/api/v1/contacts?limit=500`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`Contacts Ohme ${res.status}`);
    const json = await res.json();
    const items = json.data || [];
    all.push(...items);
    cursor = json.cursor || null;
    if (!cursor || items.length < 500) break;
  }
  return all;
}

// ── Cache en mémoire 5 min
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

  // Map contact_id → {prenom, nom, email}
  const contactMap = new Map();
  for (const c of rawContacts) {
    contactMap.set(String(c.id), {
      prenom: c.firstname || '',
      nom:    c.lastname  || '',
      email:  c.email     || '',
    });
  }

  // Construire la liste des coureurs depuis les paiements billetterie
  // Un paiement billetterie = une inscription coureur avec ses champs perso
  const seen = new Set();
  const coureurs = [];

  for (const p of rawPayments) {
    if (!p.contact_id) continue;
    const contactId = String(p.contact_id);

    // Eviter les doublons (un coureur peut avoir plusieurs paiements)
    if (seen.has(contactId)) continue;

    const cf = p.custom_fields || p;
    const dossard = cf.numero_dossard_angers_2026 ?? null;

    // On ne garde que les contacts avec un dossard
    if (dossard === null || dossard === undefined || dossard === '' || dossard === 0) continue;

    const contact = contactMap.get(contactId) || { prenom: '', nom: '', email: '' };
    const equipe  = (cf.equipe || '').trim() || null;
    const eventName = (p.nom_de_levent || cf.nom_de_levent || '').toUpperCase();

    // Filtrer sur l'événement Angers 2026
    if (!eventName.includes('ENFANCE') && !eventName.includes('ANGERS')) continue;

    seen.add(contactId);
    coureurs.push({
      id:      contactId,
      prenom:  contact.prenom,
      nom:     contact.nom,
      dossard: dossard,
      equipe:  equipe,
    });
  }

  console.log(`${coureurs.length} coureurs avec dossard chargés.`);
  _cache     = coureurs;
  _cacheTime = Date.now();
  return _cache;
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

// Debug temporaire — à supprimer après vérification
app.get('/api/debug', async (req, res) => {
  try {
    const payments = await fetchAllPayments();
    const sample = payments.slice(0, 3).map(p => ({
      id:          p.id,
      contact_id:  p.contact_id,
      nom_event:   p.nom_de_levent,
      custom_fields: p.custom_fields,
    }));
    res.json({ count: payments.length, sample });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () =>
  console.log(`Défi Enfance API démarrée sur le port ${PORT}`)
);

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import { load as cheerioLoad } from 'cheerio';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX || '';
const SEARCH_DOMAINS = (process.env.SEARCH_DOMAINS || 'fragrantica.com,parfumo.net,basenotes.com')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// --- Helpers ---
function buildSiteQuery(query) {
  if (!SEARCH_DOMAINS.length) return query;
  const sites = SEARCH_DOMAINS.map(d => `site:${d}`).join(' OR ');
  return `${query} (${sites})`;
}

function parsePrice(text) {
  if (!text) return null;
  const priceRegex = /(\$|€|£)\s?([0-9]+(?:[.,][0-9]{2})?)/;
  const m = text.replace(/\s+/g, ' ').match(priceRegex);
  if (!m) return null;
  return `${m[1]}${m[2]}`.replace(',', '.');
}

async function scrapeBasic(url) {
  try {
    const { data, request } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (!data || typeof data !== 'string') {
      return { url, ok: false };
    }
    const $ = cheerioLoad(data);
    const title = $('meta[property="og:title"]').attr('content') || $('title').text().trim();
    const desc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';

    // price: attempt from page text
    let price = null;
    // Look into common containers for e-com data
    const candidates = [
      $('[itemprop="offers"]').text(),
      $('[itemprop="price"]').text(),
      $('[class*="price"]').first().text(),
      $('[id*="price"]').first().text(),
      $('body').text()
    ].filter(Boolean);
    for (const t of candidates) {
      const p = parsePrice(String(t));
      if (p) { price = p; break; }
    }

    // Try to extract notes if present in the page
    let notes = [];
    const noteSelectors = [
      'div#pyramid div.pyramid__note',
      'div#pyramid div.note',
      'div.notes',
      'div.accords',
      'ul.notes li',
      'div#notes li',
      'div.basenotes',
    ];
    for (const sel of noteSelectors) {
      $(sel).each((_, el) => {
        const t = $(el).text().trim();
        if (t && t.length < 60) notes.push(t);
      });
      if (notes.length) break;
    }

    notes = Array.from(new Set(notes)).slice(0, 20);

    return { url: request?.res?.responseUrl || url, ok: true, title, desc, price, notes };
  } catch (e) {
    return { url, ok: false, error: String(e?.message || e) };
  }
}

async function ollamaNotesFromScene(sceneDescription) {
  const prompt = `Extract 5-8 concise fragrance notes (top/middle/base) that match this scenic description. Return JSON with keys: top, middle, base (arrays of notes, lowercase). Keep common perfume taxonomy words only (e.g., bergamot, lemon, rose, jasmine, vetiver, amber, musk). No commentary.\n\nScene:\n${sceneDescription}`;

  const body = {
    model: OLLAMA_MODEL,
    prompt,
    stream: false,
    options: {
      temperature: 0.2,
      num_predict: 256
    }
  };

  const { data } = await axios.post(`${OLLAMA_BASE_URL}/api/generate`, body, { timeout: 60000 });
  let text = data?.response || '';
  text = text.trim();

  // Try to parse JSON from the model output
  let parsed = { top: [], middle: [], base: [] };
  try {
    // attempt to find JSON block
    const jsonMatch = text.match(/\{[\s\S]*\}$/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      parsed = JSON.parse(text);
    }
  } catch {
    // fallback: naive split by lines
    const lines = text.toLowerCase().split(/\n+/);
    const bucket = (k) => {
      const i = lines.findIndex(l => l.includes(k));
      if (i === -1) return [];
      const rest = lines.slice(i + 1).join(' ').replace(/[^a-z, ]/g, '');
      return rest.split(',').map(s => s.trim()).filter(Boolean).slice(0, 6);
    };
    parsed = {
      top: bucket('top'),
      middle: bucket('middle'),
      base: bucket('base')
    };
  }

  // normalize
  const norm = (arr) => Array.from(new Set((arr || []).map(s => s.toLowerCase().trim()))).filter(Boolean).slice(0, 8);
  return {
    top: norm(parsed.top),
    middle: norm(parsed.middle),
    base: norm(parsed.base)
  };
}

async function googleSearch(query, num = 5) {
  if (!GOOGLE_API_KEY || !GOOGLE_CSE_CX) {
    throw new Error('Missing GOOGLE_API_KEY or GOOGLE_CSE_CX in environment.');
  }
  const q = buildSiteQuery(query);
  const { data } = await axios.get('https://www.googleapis.com/customsearch/v1', {
    params: {
      key: GOOGLE_API_KEY,
      cx: GOOGLE_CSE_CX,
      q,
      num,
      safe: 'active',
      lr: 'lang_en'
    },
    timeout: 20000
  });
  const items = (data.items || []).map(it => ({
    title: it.title,
    link: it.link,
    snippet: it.snippet
  }));
  return items;
}

function buildPerfumeQueryFromNotes(notes) {
  const top = (notes.top || []).slice(0, 3).join(' ');
  const mid = (notes.middle || []).slice(0, 3).join(' ');
  const base = (notes.base || []).slice(0, 3).join(' ');
  let q = `${top} ${mid} ${base} perfume with price`.
    replace(/\s+/g, ' ').trim();
  if (q.length < 10) q = `${(notes.middle || notes.top || notes.base || []).join(' ')} perfume`;
  return q;
}

// --- Routes ---
app.post('/api/extract-notes', async (req, res) => {
  try {
    const { scene } = req.body || {};
    if (!scene || typeof scene !== 'string' || scene.length < 5) {
      return res.status(400).json({ error: 'Provide a scene description (min 5 chars).' });
    }
    const notes = await ollamaNotesFromScene(scene);
    res.json({ notes });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post('/api/search', async (req, res) => {
  try {
    const { notes } = req.body || {};
    if (!notes || typeof notes !== 'object') {
      return res.status(400).json({ error: 'Provide notes {top, middle, base}.' });
    }

    const query = buildPerfumeQueryFromNotes(notes);
    const results = await googleSearch(query, 6);

    // scrape each result quickly
    const scraped = await Promise.all(results.map(r => scrapeBasic(r.link)));

    // assemble suggestions
    const suggestions = results.map((r, i) => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet,
      price: scraped[i]?.price || null,
      sourceTitle: scraped[i]?.title || null,
      notes: scraped[i]?.notes || []
    }));

    res.json({ query, suggestions });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post('/api/find', async (req, res) => {
  try {
    const { scene } = req.body || {};
    if (!scene || typeof scene !== 'string' || scene.length < 5) {
      return res.status(400).json({ error: 'Provide a scene description (min 5 chars).' });
    }
    const notes = await ollamaNotesFromScene(scene);
    const query = buildPerfumeQueryFromNotes(notes);
    const results = await googleSearch(query, 6);
    const scraped = await Promise.all(results.map(r => scrapeBasic(r.link)));

    res.json({ notes, query, suggestions: results.map((r, i) => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet,
      price: scraped[i]?.price || null,
      sourceTitle: scraped[i]?.title || null,
      notes: scraped[i]?.notes || []
    })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Fragrance Finder server listening on http://localhost:${PORT}`);
});

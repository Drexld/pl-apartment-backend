// server.js
// Backend for Polish apartment listing summarizer (Otodom first)

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// DeepL API key
const DEEPL_API_KEY = process.env.DEEPL_API_KEY;

// ---------- Helpers ----------

function stripHtml(html) {
  if (!html) return '';
  const $ = cheerio.load(html);
  return $.text().replace(/\s+/g, ' ').trim();
}

function parsePLNAmount(str) {
  if (!str) return null;
  const match = String(str).match(/[\d\s]+/);
  if (!match) return null;
  const num = parseInt(match[0].replace(/\s/g, ''), 10);
  return Number.isNaN(num) ? null : num;
}

async function translateToEnglish(text) {
  if (!text || !text.trim()) return '';
  if (!DEEPL_API_KEY) {
    // No key configured → return original
    return text;
  }

  const params = new URLSearchParams();
  params.append('auth_key', DEEPL_API_KEY);
  params.append('text', text);
  params.append('target_lang', 'EN');
  params.append('source_lang', 'PL');

  let response;
  try {
    response = await axios.post(
      'https://api-free.deepl.com/v2/translate',
      params,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
  } catch (e) {
    console.warn('DeepL translate failed, returning original text:', e?.response?.data || e.message);
    return text;
  }

  const translated =
    response.data &&
    response.data.translations &&
    response.data.translations[0] &&
    response.data.translations[0].text;

  return translated || text;
}

// Icons + English labels for amenities (used mainly for backend-side description)

// =============================
// Amenity normalization / translation (PL -> EN)
// =============================

const AMENITY_RULES = [
  // Core amenities
  { keys: ['balkon', 'taras'], en: 'balcony / terrace' },
  { keys: ['garaż', 'miejsce parkingowe', 'parking'], en: 'parking / garage' },
  { keys: ['piwnica', 'komórka'], en: 'basement / storage' },
  { keys: ['meble', 'umeblowane'], en: 'furnished' },
  { keys: ['pralka', 'pralko-suszarka'], en: 'washing machine' },
  { keys: ['zmywarka'], en: 'dishwasher' },
  { keys: ['lodówka'], en: 'refrigerator' },
  { keys: ['kuchenka', 'płyta', 'płyta indukcyjna', 'płyta elektryczna'], en: 'stove / hob' },
  { keys: ['piekarnik'], en: 'oven' },
  { keys: ['telewizor', 'tv'], en: 'tv' },
  { keys: ['internet', 'wi-fi', 'wifi'], en: 'internet' },
  { keys: ['telewizja kablowa'], en: 'cable tv' },
  { keys: ['klimatyzacja'], en: 'air conditioning' },

  // Building / security
  { keys: ['monitoring', 'ochrona'], en: 'monitoring / security' },
  { keys: ['domofon', 'wideofon'], en: 'intercom / videophone' },
  { keys: ['drzwi', 'okna antywłamaniowe', 'antywłamaniowe'], en: 'burglar-proof doors / windows' },
  { keys: ['rolety antywłamaniowe'], en: 'anti-burglary roller blinds' },
  { keys: ['teren zamknięty'], en: 'gated area' },

  // Layout / type
  { keys: ['oddzielna kuchnia'], en: 'separate kitchen' },
  { keys: ['dwupoziomowe'], en: 'two-level / duplex' },
  { keys: ['pom. użytkowe', 'pomieszczenie użytkowe'], en: 'utility room' },

  // Rules / availability (these sometimes appear in the amenity list)
  { keys: ['tylko dla niepalących', 'zakaz palenia', 'bez palenia'], en: 'non-smokers only' },
  { keys: ['wynajmę również studentom', 'również studentom'], en: 'students welcome' },
  { keys: ['umowa na 12 miesięcy', '12 miesięcy'], en: '12-month contract' },
];

function normalizeAmenityRaw(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/^[\s•·•\-]+/, '') // leading bullets / whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

function translateAmenity(raw) {
  const cleaned = normalizeAmenityRaw(raw);
  if (!cleaned) return '';

  // If it's already in a nice EN (PL) form, keep it.
  if (/^[A-Za-z].*\(.+\)$/.test(cleaned)) {
    return cleaned;
  }

  const lower = cleaned.toLowerCase();

  // Special: max people patterns
  if (/(max\.?|maks\.?|maksymalnie)\s*2/.test(lower) || /2\s*os(ó|o)b/.test(lower)) {
    return 'max 2 people' + (cleaned.match(/[A-Za-z]/) ? '' : ` (${cleaned})`);
  }

  // Special: English sentence already
  if (/^[ -]+$/.test(cleaned) && /[A-Za-z]/.test(cleaned)) {
    return cleaned;
  }

  for (const rule of AMENITY_RULES) {
    if (rule.keys.some(k => lower.includes(k))) {
      return `${rule.en} (${cleaned})`;
    }
  }

  // Fallback: just return cleaned (no leading bullets). Popup will show a default icon.
  return cleaned;
}

// Risk / confidence based on simple heuristics for expats
function assessRisk(summary) {
  const flags = [];
  let riskScore = 0;

  const rent = summary.rentPLN;
  const admin = summary.adminPLN;
  const deposit = summary.depositPLN;
  const total = summary.totalPLN;
  const ppm2 = summary.pricePerM2;

  // High deposit (>2x rent)
  if (rent && deposit && deposit > 2 * rent) {
    flags.push(
      `High deposit: ${summary.deposit} (more than 2× monthly rent)`
    );
    riskScore += 2;
  }

  // Admin / utilities unusually high vs rent
  if (rent && admin && admin > 0.6 * rent) {
    flags.push(
      `Admin / utilities (${summary.admin}) are high compared to base rent`
    );
    riskScore += 1;
  }

  // Very expensive per m²
  if (ppm2 && ppm2 > 150) {
    flags.push(
      `Price per m² (${ppm2} PLN) is on the expensive side for many areas`
    );
    riskScore += 1;
  }

  // Long wait until available (> 6 months)
  if (summary.availableFrom) {
    const now = new Date();
    const available = new Date(summary.availableFrom);
    if (!Number.isNaN(available.getTime())) {
      const diffMonths =
        (available.getFullYear() - now.getFullYear()) * 12 +
        (available.getMonth() - now.getMonth());
      if (diffMonths > 6) {
        flags.push(
          `Available from ${summary.availableFrom} (long wait before move-in)`
        );
        riskScore += 1;
      }
    }
  }

  // Compute level + confidence
  let level = 'Low';
  let confidence = 0.9;

  if (riskScore <= 1) {
    level = 'Low';
    confidence = 0.9;
  } else if (riskScore <= 3) {
    level = 'Medium';
    confidence = 0.75;
  } else {
    level = 'High';
    confidence = 0.6;
  }

  return {
    level,
    confidence,
    flags
  };
}

// Build insights list for expats
function generateInsights(summary) {
  const insights = [];

  if (summary.pricePerM2) {
    insights.push(
      `Price per m²: ${summary.pricePerM2} PLN (~${Math.round(
        summary.pricePerM2 * 0.23
      )} EUR)`
    );
  }

  if (summary.availableFrom) {
    insights.push(`Available from: ${summary.availableFrom}`);
  }

  if (summary.hasTerraceOrBalcony) {
    insights.push('Includes terrace or balcony');
  }

  if (summary.hasInternet) {
    insights.push('Internet included / available in building');
  }

  return insights;
}

// ---------- Otodom scraper (JSON-LD) ----------

function findOtodomProduct($) {
  let product = null;

  $('script[type="application/ld+json"]').each((_, el) => {
    if (product) return;
    const raw = $(el).contents().text();
    try {
      const json = JSON.parse(raw);
      const candidates = [];

      if (Array.isArray(json)) {
        candidates.push(...json);
      } else if (json['@graph']) {
        candidates.push(...json['@graph']);
      } else {
        candidates.push(json);
      }

      for (const node of candidates) {
        if (!node) continue;
        const t = node['@type'];
        if (
          t === 'Product' ||
          t === 'Apartment' ||
          (Array.isArray(t) && t.includes('Product'))
        ) {
          product = node;
          break;
        }
      }
    } catch (e) {
      // ignore parse errors
    }
  });

  return product;
}

async function parseOtodom($, url) {
  const product = findOtodomProduct($);
  if (!product) {
    throw new Error('Could not find structured data on page (Otodom JSON-LD).');
  }

  const additional = product.additionalProperty || [];
  const getProp = (namePart) => {
    const lower = namePart.toLowerCase();
    const found = additional.find((p) =>
      String(p.name || '').toLowerCase().includes(lower)
    );
    return found ? String(found.value).trim() : null;
  };

  const area = getProp('powierzchnia');
  const rooms = getProp('liczba pokoi') || product.numberOfRooms;
  const availableFrom =
    getProp('dostępne od') || getProp('available from') || null;
  const admin = getProp('czynsz');
  const deposit = getProp('kaucja');

  const infoAdditional = getProp('informacje dodatkowe') || '';
  const equip = getProp('wyposażenie') || '';
  const media = getProp('media') || '';
  const safety = getProp('bezpieczeństwo') || '';
  const security = getProp('zabezpieczenia') || '';

  const amenitiesRaw = (
    infoAdditional +
    ', ' +
    equip +
    ', ' +
    media +
    ', ' +
    safety +
    ', ' +
    security
  )
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  const descriptionPL = stripHtml(product.description || '');

  const addr = product.address || {};
  const location = [
    addr.addressLocality,
    addr.addressRegion,
    addr.streetAddress
  ]
    .filter(Boolean)
    .join(', ');

  // NEW: geo coordinates from JSON-LD
  const geo = product.geo || {};
  const latitude =
    typeof geo.latitude !== 'undefined' && geo.latitude !== null
      ? Number(geo.latitude)
      : null;
  const longitude =
    typeof geo.longitude !== 'undefined' && geo.longitude !== null
      ? Number(geo.longitude)
      : null;

  const rentPLN = product.offers ? Number(product.offers.price) : null;
  const adminPLN = parsePLNAmount(admin);
  const depositPLN = parsePLNAmount(deposit);

  const totalPLN =
    rentPLN && adminPLN ? rentPLN + adminPLN : rentPLN || null;

  const areaNum = area
    ? parseFloat(
        area
          .replace(',', '.')
          .replace(/[^\d.]/g, '')
      )
    : null;

  const pricePerM2 =
    totalPLN && areaNum && areaNum > 0
      ? Math.round(totalPLN / areaNum)
      : null;

  const amenitiesText = amenitiesRaw.join(' ').toLowerCase();
  const hasTerraceOrBalcony =
    amenitiesText.includes('taras') || amenitiesText.includes('balkon');
  const hasInternet = amenitiesText.includes('internet');

  // Translate description PL -> EN
  const descriptionEN = await translateToEnglish(descriptionPL);

  const summary = {
    site: 'otodom.pl',
    url,

    // monetary fields
    rent: rentPLN ? `${rentPLN} PLN` : null,
    rentPLN: rentPLN || null,
    admin,
    adminPLN: adminPLN || null,
    totalPLN: totalPLN || null,
    totalCostDisplay: totalPLN
      ? `${totalPLN} PLN (~${Math.round(totalPLN * 0.23)} EUR)`
      : null,
    deposit,
    depositPLN: depositPLN || null,

    // core metrics
    rooms: rooms ? String(rooms) : null,
    area: area || null,
    availableFrom,
    location,

    // amenities + description
    amenities: amenitiesRaw.map(translateAmenity).filter(Boolean),
    descriptionEN,

    // geo (for distance from base)
    latitude: !Number.isNaN(latitude) ? latitude : null,
    longitude: !Number.isNaN(longitude) ? longitude : null,

    // extras used by insights / risk
    hasTerraceOrBalcony,
    hasInternet,
    pricePerM2
  };

  // Add insights + risk object
  summary.insights = generateInsights(summary);
  summary.risk = assessRisk(summary);

  return summary;
}

// ---------- Route ----------


app.post('/api/summarize', async (req, res) => {
  try {
    // Accept either a URL (server will fetch) OR raw HTML (preferred - avoids 403/bot blocks)
    const url = req.body?.url;
    const rawHtmlFromClient = req.body?.html;

    if (!url && !rawHtmlFromClient) {
      return res.status(400).json({ success: false, error: 'Missing url or html' });
    }

    let rawHtml = rawHtmlFromClient;

    if (!rawHtml) {
      // Fallback: fetch server-side (can be blocked by Otodom)
      const resp = await axios.get(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Accept-Language': 'pl,en;q=0.9',
        },
        timeout: 20000,
      });
      rawHtml = resp.data;
    }

    const summary = extractSummaryFromHtml(rawHtml, url);
    return res.json({ success: true, summary });
  } catch (err) {
    console.error('Error in /api/summarize:', err?.message || err);
    const status = err?.response?.status || 500;
    return res.status(status).json({ success: false, error: err?.message || 'Server error' });
  }
});


app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

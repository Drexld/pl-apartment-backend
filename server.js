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
const DEEPL_API_KEY = process.env.DEEPL_API_KEY || '6b4188e6-d473-4a9d-a9d7-f09763395a33:fx';

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
  if (!DEEPL_API_KEY || DEEPL_API_KEY === '6b4188e6-d473-4a9d-a9d7-f09763395a33:fx') {
    // Fallback: no key configured, just return original
    return text;
  }

  const params = new URLSearchParams();
  params.append('auth_key', DEEPL_API_KEY);
  params.append('text', text);
  params.append('target_lang', 'EN');
  params.append('source_lang', 'PL');

  const response = await axios.post(
    'https://api-free.deepl.com/v2/translate',
    params
  );

  const translated =
    response.data &&
    response.data.translations &&
    response.data.translations[0] &&
    response.data.translations[0].text;

  return translated || text;
}

// Icons + English labels for amenities (used mainly for backend-side description)
const AMENITY_MAP = {
  'taras': { icon: ' ', en: 'terrace' },
  'balkon': { icon: ' ', en: 'balcony' },
  'pom. użytkowe': { icon: ' ', en: 'utility room' },
  'pom. użytkowy': { icon: ' ', en: 'utility room' },
  'meble': { icon: ' ', en: 'furniture' },
  'pralka': { icon: ' ', en: 'washing machine' },
  'zmywarka': { icon: ' ', en: 'dishwasher' },
  'lodówka': { icon: ' ', en: 'refrigerator' },
  'kuchenka': { icon: ' ', en: 'stove' },
  'piekarnik': { icon: ' ', en: 'oven' },
  'telewizor': { icon: ' ', en: 'tv' },
  'klimatyzacja': { icon: ' ', en: 'air conditioning' },
  'rolety antywłamaniowe': { icon: ' ', en: 'anti-burglary roller blinds' },
  'drzwi / okna antywłamaniowe': {
    icon: ' ',
    en: 'burglar-proof doors / windows'
  },
  'domofon / wideofon': { icon: ' ', en: 'intercom / videophone' },
  'system alarmowy': { icon: ' ', en: 'alarm system' },
  'internet': { icon: ' ', en: 'internet' },
  'telewizja kablowa': { icon: ' ', en: 'cable tv' },
  'telefon': { icon: ' ', en: 'phone' },
  'teren zamknięty': { icon: ' ', en: 'gated area' },
  'garaż': { icon: ' ', en: 'garage' },
  'miejsce parkingowe': { icon: ' ', en: 'parking space' },
  'tylko dla niepalących': { icon: ' ', en: 'non-smokers only' }
};

function decorateAmenity(raw) {
  const lower = raw.toLowerCase();
  for (const key of Object.keys(AMENITY_MAP)) {
    if (lower.includes(key)) {
      const { icon, en } = AMENITY_MAP[key];
      return `${icon} ${en} (${raw})`;
    }
  }
  // Default bullet if we don't recognise it
  return `• ${raw}`;
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
    amenities: amenitiesRaw.map(decorateAmenity),
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
    const { url } = req.body;
    if (!url) {
      return res
        .status(400)
        .json({ success: false, error: 'URL is required' });
    }

    const hostname = new URL(url).hostname;
    if (!hostname.includes('otodom.pl')) {
      return res.status(400).json({
        success: false,
        error: 'Right now this works best on Otodom listing pages.'
      });
    }

    const response = await axios.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const $ = cheerio.load(response.data);
    const summary = await parseOtodom($, url);

    res.json({ success: true, summary });
  } catch (error) {
    console.error('Error in /api/summarize:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch or analyze listing',
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

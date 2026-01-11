// server.js
// Backend for Polish apartment listing summarizer (Otodom first)

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

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

// Icons + English labels for amenities
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
  'tylko dla niepalących': { icon: ' ', en: 'non-smokers only' },
  'piwnica': { icon: ' ', en: 'basement' },
  'winda': { icon: ' ', en: 'elevator' },
  'ogród': { icon: ' ', en: 'garden' },
  'ogródek': { icon: ' ', en: 'small garden' },
  'komórka lokatorska': { icon: ' ', en: 'storage room' }
};

function decorateAmenity(amenity) {
  const key = String(amenity || '').toLowerCase().trim();
  const mapped = AMENITY_MAP[key];
  if (!mapped) return amenity;
  return `${mapped.en}`;
}

// Extract Otodom JSON-LD (product) from page
function findOtodomProduct($) {
  const scripts = $('script[type="application/ld+json"]');

  const candidates = [];
  scripts.each((_, el) => {
    try {
      const jsonText = $(el).contents().text();
      if (!jsonText) return;
      const json = JSON.parse(jsonText);

      if (Array.isArray(json)) {
        candidates.push(...json);
      } else if (json['@graph']) {
        candidates.push(...json['@graph']);
      } else {
        candidates.push(json);
      }
    } catch (e) {
      // ignore JSON parse errors
    }
  });

  const product = candidates.find(
    (item) => item['@type'] === 'Product' || item['@type'] === 'Offer'
  );

  if (!product) {
    console.warn('Otodom JSON-LD product not found.');
    return null;
  }

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
    deposit,
    depositPLN: depositPLN || null,
    totalPLN,

    // physical
    rooms: rooms ? Number(rooms) : null,
    area,
    areaM2: areaNum,
    availableFrom,

    // location
    address: location,

    // amenities + description
    amenities: amenitiesRaw.map(decorateAmenity),
    descriptionEN,

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

// Simple insights for expats
function generateInsights(summary) {
  const insights = [];

  if (summary.pricePerM2) {
    insights.push(
      `Estimated price per m²: ${summary.pricePerM2} PLN (rent + admin, approx.).`
    );
  }

  if (!summary.adminPLN) {
    insights.push(
      'Admin / building fee is not clearly listed: always ask how much and what it covers (water, heating, garbage, etc.).'
    );
  }

  if (!summary.depositPLN) {
    insights.push(
      'Deposit amount is not listed. Always confirm how much deposit is required and when it is refunded.'
    );
  }

  if (!summary.availableFrom) {
    insights.push(
      'Availability date is not specified. Ask from when the apartment is actually available.'
    );
  }

  return insights;
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
      'Price per m² seems high compared to typical long-term rentals.'
    );
    riskScore += 2;
  }

  // Very cheap per m² (could be short-term or issues)
  if (ppm2 && ppm2 < 40) {
    flags.push(
      'Price per m² seems low – double-check if it is really long-term rent and if there are hidden costs.'
    );
    riskScore += 2;
  }

  // Missing admin / deposit info already handled in insights, but we can bump risk slightly
  if (!admin) {
    riskScore += 1;
    flags.push('Admin / utilities not specified – clarify before deciding.');
  }
  if (!deposit) {
    riskScore += 1;
    flags.push('Deposit not specified – clarify amount and refund rules.');
  }

  // Short or vague description
  if (!summary.descriptionEN || summary.descriptionEN.length < 200) {
    riskScore += 1;
    flags.push('Description is short or vague – ask more detailed questions.');
  }

  // Missing availability
  if (!summary.availableFrom) {
    riskScore += 1;
    flags.push('Availability date not specified – confirm move-in date.');
  }

  let level = 'Low';
  if (riskScore >= 6) level = 'High';
  else if (riskScore >= 3) level = 'Medium';

  const confidence = Math.max(40, 100 - riskScore * 5);

  return {
    level,
    score: riskScore,
    confidence,
    notes: flags
  };
}

// ---------- Routes ----------

app.post('/api/summarize', async (req, res) => {
  try {
    const { url } = req.body || {};
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

app.post('/api/summarize-html', async (req, res) => {
  try {
    const { html, url = '' } = req.body || {};
    if (!html || typeof html !== 'string' || html.length < 1000) {
      return res.status(400).json({ success: false, error: 'Missing html' });
    }
    const $ = cheerio.load(html);
    const summary = await parseOtodom($, url);
    res.json({ success: true, summary });
  } catch (err) {
    console.error('Error in /api/summarize-html:', err);
    res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

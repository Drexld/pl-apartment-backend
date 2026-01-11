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

// Google Maps API key (for optional commute time)
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

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

// Optional: compute commute durations using Google Distance Matrix.
// This is fully optional and only used when base + listing coordinates
// and GOOGLE_MAPS_API_KEY are available.
async function fetchDurationSeconds(baseLat, baseLng, destLat, destLng, mode) {
  if (!GOOGLE_MAPS_API_KEY) return null;
  if (
    typeof baseLat !== 'number' ||
    typeof baseLng !== 'number' ||
    typeof destLat !== 'number' ||
    typeof destLng !== 'number'
  ) {
    return null;
  }

  try {
    const resp = await axios.get(
      'https://maps.googleapis.com/maps/api/distancematrix/json',
      {
        params: {
          origins: `${baseLat},${baseLng}`,
          destinations: `${destLat},${destLng}`,
          mode,
          departure_time: 'now',
          key: GOOGLE_MAPS_API_KEY
        }
      }
    );

    const data = resp.data;
    if (
      !data ||
      !Array.isArray(data.rows) ||
      !data.rows[0] ||
      !Array.isArray(data.rows[0].elements) ||
      !data.rows[0].elements[0] ||
      data.rows[0].elements[0].status !== 'OK'
    ) {
      return null;
    }

    const duration = data.rows[0].elements[0].duration;
    if (!duration || typeof duration.value !== 'number') {
      return null;
    }
    return duration.value; // seconds
  } catch (err) {
    console.error(`Error calling Distance Matrix (${mode}):`, err.message || err);
    return null;
  }
}

async function computeCommuteDurations(baseLat, baseLng, destLat, destLng) {
  if (!GOOGLE_MAPS_API_KEY) return null;
  if (
    typeof baseLat !== 'number' ||
    typeof baseLng !== 'number' ||
    typeof destLat !== 'number' ||
    typeof destLng !== 'number'
  ) {
    return null;
  }

  const [transitSec, drivingSec, bikeSec] = await Promise.all([
    fetchDurationSeconds(baseLat, baseLng, destLat, destLng, 'transit'),
    fetchDurationSeconds(baseLat, baseLng, destLat, destLng, 'driving'),
    fetchDurationSeconds(baseLat, baseLng, destLat, destLng, 'bicycling')
  ]);

  const toMinutes = (sec) =>
    typeof sec === 'number' ? Math.round(sec / 60) : null;

  return {
    transitMinutes: toMinutes(transitSec),
    drivingMinutes: toMinutes(drivingSec),
    bikeMinutes: toMinutes(bikeSec)
  };
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

    // geo (for distance from base)
    latitude: !Number.isNaN(latitude) ? latitude : null,
    longitude: !Number.isNaN(longitude) ? longitude : null,

    // extras used by insights / risk
    hasTerraceOrBalcony,
    hasInternet,
    pricePerM2
  };

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
  if (deposit && rent && deposit > 2 * rent) {
    riskScore += 20;
    flags.push('Deposit seems high compared to rent (>2x).');
  }

  // No admin fee specified
  if (!admin) {
    riskScore += 15;
    flags.push(
      'Admin / building fee is not clearly listed – always ask for the exact amount.'
    );
  }

  // No deposit listed
  if (!deposit) {
    riskScore += 10;
    flags.push(
      'Deposit is not clearly listed – always confirm how much deposit is required.'
    );
  }

  // Very high price per m2 (rough heuristic)
  if (ppm2 && ppm2 > 150) {
    riskScore += 15;
    flags.push(
      'Price per m² seems quite high compared to typical long-term rentals.'
    );
  }

  // Short or vague description
  if (!summary.descriptionEN || summary.descriptionEN.length < 200) {
    riskScore += 10;
    flags.push('Description is short or vague – read carefully and ask questions.');
  }

  // Missing availability
  if (!summary.availableFrom) {
    riskScore += 5;
    flags.push('Availability date not specified – confirm move-in date.');
  }

  let level = 'Low';
  if (riskScore >= 40) level = 'High';
  else if (riskScore >= 20) level = 'Medium';

  const confidence = Math.max(40, 100 - riskScore);

  return {
    level,
    score: riskScore,
    confidence,
    notes: flags
  };
}

// ---------- Route ----------

app.post('/api/summarize', async (req, res) => {
  try {
    const { url, baseLat, baseLng } = req.body || {};
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

    // Optional commute-time enrichment if base + listing coords + API key exist.
    if (
      typeof baseLat === 'number' &&
      typeof baseLng === 'number' &&
      summary &&
      typeof summary.latitude === 'number' &&
      typeof summary.longitude === 'number'
    ) {
      try {
        const commute = await computeCommuteDurations(
          baseLat,
          baseLng,
          summary.latitude,
          summary.longitude
        );
        if (commute) {
          summary.commuteTransitMinutes = commute.transitMinutes;
          summary.commuteDrivingMinutes = commute.drivingMinutes;
          summary.commuteBikeMinutes = commute.bikeMinutes;
        }
      } catch (err) {
        console.error(
          'Error computing commute durations:',
          err.message || err
        );
      }
    }

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

app.post('/api/summarize-html', async (req, res) => {
  try {
    const { html, url = '', baseLat, baseLng } = req.body || {};
    if (!html || typeof html !== 'string' || html.length < 1000) {
      return res.status(400).json({ success: false, error: 'Missing html' });
    }
    const $ = cheerio.load(html);
    const summary = await parseOtodom($, url);

    // Optional commute-time enrichment if base + listing coords + API key exist.
    if (
      typeof baseLat === 'number' &&
      typeof baseLng === 'number' &&
      summary &&
      typeof summary.latitude === 'number' &&
      typeof summary.longitude === 'number'
    ) {
      try {
        const commute = await computeCommuteDurations(
          baseLat,
          baseLng,
          summary.latitude,
          summary.longitude
        );
        if (commute) {
          summary.commuteTransitMinutes = commute.transitMinutes;
          summary.commuteDrivingMinutes = commute.drivingMinutes;
          summary.commuteBikeMinutes = commute.bikeMinutes;
        }
      } catch (err) {
        console.error(
          'Error computing commute durations (html):',
          err.message || err
        );
      }
    }

    res.json({ success: true, summary });
  } catch (err) {
    console.error('Error in /api/summarize-html:', err);
    res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

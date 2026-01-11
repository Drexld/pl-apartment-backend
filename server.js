// server.js
// Backend for Polish apartment listing summarizer (Otodom)
// With distance calculation and translation support

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

// API Keys from environment
const DEEPL_API_KEY = process.env.DEEPL_API_KEY || '';
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

// ---------- Translation ----------

async function translateToEnglish(text) {
  if (!text || !text.trim()) return '';
  
  // If no DeepL API key, return original
  if (!DEEPL_API_KEY) {
    console.log('No DeepL API key configured, returning original text');
    return text;
  }

  try {
    const params = new URLSearchParams();
    params.append('auth_key', DEEPL_API_KEY);
    params.append('text', text);
    params.append('target_lang', 'EN');
    params.append('source_lang', 'PL');

    const response = await axios.post(
      'https://api-free.deepl.com/v2/translate',
      params,
      { timeout: 10000 }
    );

    const translated =
      response.data?.translations?.[0]?.text;

    return translated || text;
  } catch (error) {
    console.error('DeepL translation error:', error.message);
    return text; // Return original on error
  }
}

// ---------- Distance Calculation ----------

async function calculateDistance(originAddress, destinationAddress) {
  if (!originAddress || !destinationAddress) {
    return null;
  }

  if (!GOOGLE_MAPS_API_KEY) {
    // Fallback: calculate straight-line distance using geocoding approximation
    console.log('No Google Maps API key, using straight-line estimation');
    return await calculateStraightLineDistance(originAddress, destinationAddress);
  }

  try {
    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/distancematrix/json',
      {
        params: {
          origins: originAddress,
          destinations: destinationAddress,
          key: GOOGLE_MAPS_API_KEY,
          mode: 'transit',
          language: 'en',
        },
        timeout: 10000,
      }
    );

    const result = response.data;
    
    if (result.status === 'OK' && result.rows?.[0]?.elements?.[0]?.status === 'OK') {
      const element = result.rows[0].elements[0];
      return {
        distanceKm: Math.round((element.distance.value / 1000) * 10) / 10,
        distanceText: element.distance.text,
        durationMinutes: Math.round(element.duration.value / 60),
        durationText: element.duration.text,
      };
    }
    
    return null;
  } catch (error) {
    console.error('Google Maps distance error:', error.message);
    return null;
  }
}

// Fallback: straight-line distance using Geocoding
async function calculateStraightLineDistance(origin, destination) {
  try {
    // Try to geocode both addresses
    const originCoords = await geocodeAddress(origin);
    const destCoords = await geocodeAddress(destination);

    if (!originCoords || !destCoords) {
      return null;
    }

    // Calculate straight-line distance using Haversine formula
    const km = haversineDistance(
      originCoords.lat, originCoords.lng,
      destCoords.lat, destCoords.lng
    );

    return {
      distanceKm: Math.round(km * 10) / 10,
      distanceText: `${Math.round(km * 10) / 10} km (straight line)`,
      durationMinutes: null,
      durationText: null,
    };
  } catch (error) {
    console.error('Straight-line distance error:', error.message);
    return null;
  }
}

async function geocodeAddress(address) {
  if (!GOOGLE_MAPS_API_KEY) {
    // Without API key, try a simple Poland-specific heuristic
    return null;
  }

  try {
    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/geocode/json',
      {
        params: {
          address: address + ', Poland',
          key: GOOGLE_MAPS_API_KEY,
        },
        timeout: 5000,
      }
    );

    if (response.data.status === 'OK' && response.data.results?.[0]) {
      const location = response.data.results[0].geometry.location;
      return { lat: location.lat, lng: location.lng };
    }
    return null;
  } catch (error) {
    console.error('Geocode error:', error.message);
    return null;
  }
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg) {
  return deg * (Math.PI / 180);
}

// ---------- Amenity Mapping ----------

const AMENITY_MAP = {
  'taras': { icon: '🌿', en: 'terrace' },
  'balkon': { icon: '🌇', en: 'balcony' },
  'pom. użytkowe': { icon: '📦', en: 'utility room' },
  'pom. użytkowy': { icon: '📦', en: 'utility room' },
  'meble': { icon: '🛋️', en: 'furniture' },
  'pralka': { icon: '🧺', en: 'washing machine' },
  'zmywarka': { icon: '🍽️', en: 'dishwasher' },
  'lodówka': { icon: '🧊', en: 'refrigerator' },
  'kuchenka': { icon: '🔥', en: 'stove' },
  'piekarnik': { icon: '🔥', en: 'oven' },
  'telewizor': { icon: '📺', en: 'tv' },
  'klimatyzacja': { icon: '❄️', en: 'air conditioning' },
  'rolety antywłamaniowe': { icon: '🛡️', en: 'anti-burglary blinds' },
  'drzwi / okna antywłamaniowe': { icon: '🛡️', en: 'burglar-proof doors/windows' },
  'domofon / wideofon': { icon: '📞', en: 'intercom / videophone' },
  'system alarmowy': { icon: '🚨', en: 'alarm system' },
  'internet': { icon: '🌐', en: 'internet' },
  'telewizja kablowa': { icon: '📺', en: 'cable tv' },
  'telefon': { icon: '📞', en: 'phone' },
  'teren zamknięty': { icon: '🚪', en: 'gated area' },
  'garaż': { icon: '🚗', en: 'garage' },
  'miejsce parkingowe': { icon: '🅿️', en: 'parking space' },
  'tylko dla niepalących': { icon: '🚭', en: 'non-smokers only' },
  'piwnica': { icon: '📦', en: 'basement' },
  'winda': { icon: '🛗', en: 'elevator' },
  'ogród': { icon: '🌳', en: 'garden' },
  'ogródek': { icon: '🌳', en: 'small garden' },
  'komórka lokatorska': { icon: '📦', en: 'storage room' },
  'monitoring / ochrona': { icon: '📹', en: 'monitoring / security' },
  'monitoring': { icon: '📹', en: 'monitoring' },
  'ochrona': { icon: '👮', en: 'security' },
};

function decorateAmenity(amenity) {
  const key = String(amenity || '').toLowerCase().trim();
  
  for (const [polishKey, value] of Object.entries(AMENITY_MAP)) {
    if (key.includes(polishKey)) {
      return `${value.en} (${amenity})`;
    }
  }
  
  return amenity;
}

// ---------- Otodom JSON-LD extraction ----------

function findOtodomProduct($) {
  function extractProductFromRaw(raw) {
    if (!raw) return null;

    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      const firstBrace = raw.indexOf('{');
      const lastBrace = raw.lastIndexOf('}');
      if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
        return null;
      }
      try {
        json = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }

    const nodes = [];
    if (Array.isArray(json)) {
      nodes.push(...json);
    } else if (json['@graph']) {
      nodes.push(...json['@graph']);
    } else {
      nodes.push(json);
    }

    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const t = node['@type'];
      if (
        t === 'Product' ||
        t === 'Offer' ||
        t === 'SingleFamilyResidence' ||
        (Array.isArray(t) && (t.includes('Product') || t.includes('Offer')))
      ) {
        return node;
      }
    }
    return null;
  }

  let product = null;

  $('script[type="application/ld+json"]').each((_, el) => {
    if (product) return;
    const raw = $(el).contents().text();
    const candidate = extractProductFromRaw(raw);
    if (candidate) product = candidate;
  });

  if (!product) {
    $('script').each((_, el) => {
      if (product) return;
      const raw = $(el).contents().text() || '';
      if (!raw.includes('"@type"')) return;
      const candidate = extractProductFromRaw(raw);
      if (candidate) product = candidate;
    });
  }

  return product;
}

async function parseOtodom($, url, baseLocationText = '') {
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
  const availableFrom = getProp('dostępne od') || getProp('available from') || null;
  const admin = getProp('czynsz');
  const deposit = getProp('kaucja');

  const infoAdditional = getProp('informacje dodatkowe') || '';
  const equip = getProp('wyposażenie') || '';
  const media = getProp('media') || '';
  const safety = getProp('bezpieczeństwo') || '';
  const security = getProp('zabezpieczenia') || '';

  const amenitiesRaw = (infoAdditional + ', ' + equip + ', ' + media + ', ' + safety + ', ' + security)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  const descriptionPL = stripHtml(product.description || '');

  const addr = product.address || {};
  const location = [addr.addressLocality, addr.addressRegion, addr.streetAddress]
    .filter(Boolean)
    .join(', ');

  const rentPLN = product.offers ? Number(product.offers.price) : null;
  const adminPLN = parsePLNAmount(admin);
  const depositPLN = parsePLNAmount(deposit);
  const totalPLN = rentPLN && adminPLN ? rentPLN + adminPLN : rentPLN || null;

  const areaNum = area ? parseFloat(area.replace(',', '.').replace(/[^\d.]/g, '')) : null;
  const pricePerM2 = totalPLN && areaNum && areaNum > 0 ? Math.round(totalPLN / areaNum) : null;

  const amenitiesText = amenitiesRaw.join(' ').toLowerCase();
  const hasTerraceOrBalcony = amenitiesText.includes('taras') || amenitiesText.includes('balkon');
  const hasInternet = amenitiesText.includes('internet');

  // Translate description PL -> EN
  const descriptionEN = await translateToEnglish(descriptionPL);

  // Calculate distance if base location provided
  let distanceInfo = null;
  if (baseLocationText && location) {
    distanceInfo = await calculateDistance(baseLocationText + ', Poland', location + ', Poland');
  }

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

    // distance
    distanceKm: distanceInfo?.distanceKm || null,
    distanceText: distanceInfo?.distanceText || null,
    durationMinutes: distanceInfo?.durationMinutes || null,
    durationText: distanceInfo?.durationText || null,

    // amenities + description
    amenities: amenitiesRaw.map(decorateAmenity),
    descriptionEN,

    // extras used by insights / risk
    hasTerraceOrBalcony,
    hasInternet,
    pricePerM2,
  };

  // Add insights + risk object
  summary.insights = generateInsights(summary);
  summary.risk = assessRisk(summary);

  return summary;
}

// ---------- Insights & Risk ----------

function generateInsights(summary) {
  const insights = [];

  if (summary.pricePerM2) {
    insights.push(`Estimated price per m²: ${summary.pricePerM2} PLN (rent + admin, approx.).`);
  }

  if (!summary.adminPLN) {
    insights.push('Admin / building fee is not clearly listed.');
  }

  if (!summary.depositPLN) {
    insights.push('Deposit amount is not listed.');
  }

  if (!summary.availableFrom) {
    insights.push('Availability date is not specified.');
  }

  return insights;
}

function assessRisk(summary) {
  const flags = [];
  let riskScore = 0;

  const rent = summary.rentPLN;
  const admin = summary.adminPLN;
  const deposit = summary.depositPLN;
  const ppm2 = summary.pricePerM2;

  if (rent && deposit && deposit > 2 * rent) {
    flags.push(`High deposit: more than 2× monthly rent.`);
    riskScore += 2;
  }

  if (rent && admin && admin > 0.6 * rent) {
    flags.push(`Admin / utilities are high compared to base rent.`);
    riskScore += 1;
  }

  if (ppm2 && ppm2 > 150) {
    flags.push('Price per m² seems high.');
    riskScore += 2;
  }

  if (ppm2 && ppm2 < 40) {
    flags.push('Price per m² seems very low – double-check for hidden costs.');
    riskScore += 2;
  }

  if (!admin) {
    riskScore += 1;
    flags.push('Admin / utilities not specified.');
  }
  if (!deposit) {
    riskScore += 1;
    flags.push('Deposit not specified.');
  }

  if (!summary.descriptionEN || summary.descriptionEN.length < 200) {
    riskScore += 1;
    flags.push('Description is short or vague.');
  }

  if (!summary.availableFrom) {
    riskScore += 1;
    flags.push('Availability date not specified.');
  }

  let level = 'Low';
  if (riskScore >= 6) level = 'High';
  else if (riskScore >= 3) level = 'Medium';

  const confidence = Math.max(40, 100 - riskScore * 5);

  return { level, score: riskScore, confidence, notes: flags };
}

// ---------- Routes ----------

app.post('/api/summarize', async (req, res) => {
  try {
    const { url, baseLocationText } = req.body || {};
    if (!url) {
      return res.status(400).json({ success: false, error: 'URL is required' });
    }

    const hostname = new URL(url).hostname;
    if (!hostname.includes('otodom.pl')) {
      return res.status(400).json({
        success: false,
        error: 'Right now this works best on Otodom listing pages.',
      });
    }

    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const $ = cheerio.load(response.data);
    const summary = await parseOtodom($, url, baseLocationText || '');
    res.json({ success: true, summary });
  } catch (error) {
    console.error('Error in /api/summarize:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch or analyze listing',
      details: error.message,
    });
  }
});

app.post('/api/summarize-html', async (req, res) => {
  try {
    const { html, url = '', baseLocationText = '' } = req.body || {};
    if (!html || typeof html !== 'string' || html.length < 1000) {
      return res.status(400).json({ success: false, error: 'Missing html' });
    }
    const $ = cheerio.load(html);
    const summary = await parseOtodom($, url, baseLocationText);
    res.json({ success: true, summary });
  } catch (err) {
    console.error('Error in /api/summarize-html:', err);
    res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`DeepL API: ${DEEPL_API_KEY ? 'Configured' : 'Not configured'}`);
  console.log(`Google Maps API: ${GOOGLE_MAPS_API_KEY ? 'Configured' : 'Not configured'}`);
});

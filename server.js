// server.js
// Backend for Polish apartment listing summarizer (Otodom)
// With multi-modal commute calculation, translation support, and smart description parsing

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

// ---------- Smart Description Parser ----------

function parseDescriptionForHiddenInfo(descriptionPL, descriptionEN) {
  const result = {
    inconsistencies: [],
    importantNotes: [],
    hiddenDeposit: null,
    hiddenUtilities: null,
    contractTerms: null,
    notaryInfo: null,
    registrationAllowed: null,
    advertiserType: null,
  };

  const textPL = (descriptionPL || '').toLowerCase();
  const textEN = (descriptionEN || '').toLowerCase();
  const combined = textPL + ' ' + textEN;

  // DEPOSIT DETECTION
  const depositPatterns = [
    /(?:deposit|kaucja|depozyt)[^0-9]*?(\d[\d\s,.]*)\s*(?:pln|zł|zloty)/gi,
    /(?:refundable|zwrotna)[^0-9]*?(\d[\d\s,.]*)\s*(?:pln|zł)/gi,
    /(\d[\d\s,.]*)\s*(?:pln|zł)[^.]*(?:deposit|kaucja|depozyt)/gi,
  ];

  for (const pattern of depositPatterns) {
    const matches = combined.matchAll(pattern);
    for (const match of matches) {
      const amount = parseInt(match[1].replace(/[\s,.]/g, ''), 10);
      if (amount && amount > 500 && amount < 50000) {
        result.hiddenDeposit = amount;
        break;
      }
    }
    if (result.hiddenDeposit) break;
  }

  // METERED UTILITIES DETECTION
  const utilityPatterns = [
    /(?:for one person|dla jednej osoby|1 person)[^0-9]*?[~≈]?\s*(\d+)/gi,
    /(?:for two|dla dwóch|2 person)[^0-9]*?[~≈]?\s*(\d+)/gi,
    /(?:utilities|media|opłaty)[^0-9]*?[~≈]?\s*(\d+)[\s-]*(\d+)?/gi,
    /[~≈]\s*(\d+)\s*(?:pln|zł)[^.]*(?:person|osob)/gi,
  ];

  let utilityMin = null;
  let utilityMax = null;

  for (const pattern of utilityPatterns) {
    const matches = combined.matchAll(pattern);
    for (const match of matches) {
      const val1 = parseInt(match[1], 10);
      const val2 = match[2] ? parseInt(match[2], 10) : null;
      
      if (val1 && val1 > 20 && val1 < 1000) {
        if (!utilityMin || val1 < utilityMin) utilityMin = val1;
        if (!utilityMax || val1 > utilityMax) utilityMax = val1;
      }
      if (val2 && val2 > 20 && val2 < 1000) {
        if (!utilityMax || val2 > utilityMax) utilityMax = val2;
      }
    }
  }

  if (utilityMin || utilityMax) {
    result.hiddenUtilities = {
      min: utilityMin || utilityMax,
      max: utilityMax || utilityMin,
      avg: Math.round(((utilityMin || utilityMax) + (utilityMax || utilityMin)) / 2),
    };
  }

  // CONTRACT TERMS
  const contractPatterns = [
    /(\d+)[\s-]*(?:month|miesiąc|miesięc)[^.]*(?:contract|umowa|minimum)/gi,
    /(?:minimum|min\.?|at least)[^0-9]*(\d+)[\s-]*(?:month|miesiąc)/gi,
    /(?:contract|umowa)[^.]*(\d+)[\s-]*(?:month|miesiąc)/gi,
  ];

  for (const pattern of contractPatterns) {
    const match = pattern.exec(combined);
    if (match) {
      const months = parseInt(match[1], 10);
      if (months >= 1 && months <= 36) {
        result.contractTerms = { months };
        result.importantNotes.push(months + '-month minimum contract mentioned');
        break;
      }
    }
  }

  // NOTARY REQUIREMENT
  if (combined.includes('notary') || combined.includes('notariusz') || combined.includes('notarial')) {
    result.notaryInfo = { required: true };
    const costMatch = combined.match(/(\d+)\s*%[^.]*(?:notary|notariusz|cost|koszt)/i) ||
                      combined.match(/(?:notary|notariusz)[^.]*(\d+)\s*%/i);
    if (costMatch) {
      result.notaryInfo.ownerPays = parseInt(costMatch[1], 10);
      result.importantNotes.push('Notary contract required (owner covers ' + result.notaryInfo.ownerPays + '%)');
    } else {
      result.importantNotes.push('Notary contract required');
    }
  }

  // REGISTRATION (ZAMELDOWANIE)
  if (combined.includes('zameldowanie') || combined.includes('registration') || combined.includes('meldun')) {
    if (combined.includes('bez zameldowania') || combined.includes('no registration') || 
        combined.includes('without registration') || combined.includes('nie ma możliwości zameld')) {
      result.registrationAllowed = false;
      result.importantNotes.push('Registration (zameldowanie) NOT possible');
    } else if (combined.includes('możliwość zameld') || combined.includes('registration possible') ||
               combined.includes('zameldowanie możliwe')) {
      result.registrationAllowed = true;
      result.importantNotes.push('Registration (zameldowanie) possible');
    }
  }

  // ADVERTISER TYPE DETECTION
  if (combined.includes('biuro') || combined.includes('agency') || combined.includes('pośrednik') ||
      combined.includes('agent') || combined.includes('prowizja') || combined.includes('commission')) {
    result.advertiserType = 'agency';
  } else if (combined.includes('prywat') || combined.includes('private') || combined.includes('owner') ||
             combined.includes('właściciel') || combined.includes('bez prowizji') || 
             combined.includes('no commission') || combined.includes('bezpośrednio')) {
    result.advertiserType = 'private';
  }

  // PET POLICY
  if (combined.includes('no pets') || combined.includes('bez zwierząt') || combined.includes('no animals')) {
    result.importantNotes.push('No pets allowed');
  } else if (combined.includes('pets welcome') || combined.includes('zwierzęta mile') || 
             combined.includes('pets allowed') || combined.includes('akceptujemy zwierzęta')) {
    result.importantNotes.push('Pets allowed');
  }

  // SMOKING POLICY
  if (combined.includes('no smoking') || combined.includes('niepalących') || combined.includes('zakaz palenia')) {
    result.importantNotes.push('Non-smokers only');
  }

  // STUDENTS
  if (combined.includes('no students') || combined.includes('bez studentów')) {
    result.importantNotes.push('Not renting to students');
  } else if (combined.includes('students welcome') || combined.includes('dla studentów') ||
             combined.includes('studenci mile widziani')) {
    result.importantNotes.push('Student-friendly');
  }

  return result;
}

function detectInconsistencies(summary, descriptionAnalysis) {
  const inconsistencies = [];

  if (descriptionAnalysis.hiddenDeposit && summary.depositPLN) {
    const listedDeposit = summary.depositPLN;
    const descDeposit = descriptionAnalysis.hiddenDeposit;
    
    if (Math.abs(descDeposit - listedDeposit) > listedDeposit * 0.2) {
      inconsistencies.push({
        type: 'deposit_mismatch',
        severity: 'high',
        message: 'Deposit mismatch: Listed as ' + listedDeposit + ' PLN but description mentions ' + descDeposit + ' PLN',
        listedValue: listedDeposit,
        descriptionValue: descDeposit,
      });
    }
  }

  if (descriptionAnalysis.hiddenUtilities && (!summary.adminPLN || summary.adminPLN < 10)) {
    const utils = descriptionAnalysis.hiddenUtilities;
    inconsistencies.push({
      type: 'hidden_utilities',
      severity: 'medium',
      message: 'Utilities are metered: ~' + utils.min + '-' + utils.max + ' PLN/month (not included in listed admin fee)',
      estimatedCost: utils,
    });
  }

  if (descriptionAnalysis.registrationAllowed === false) {
    inconsistencies.push({
      type: 'no_registration',
      severity: 'medium',
      message: 'Registration (zameldowanie) not possible - may affect visa/residence permits',
    });
  }

  return inconsistencies;
}

// ---------- Translation ----------

async function translateToEnglish(text) {
  if (!text || !text.trim()) return '';
  
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

    const translated = response.data?.translations?.[0]?.text;
    return translated || text;
  } catch (error) {
    console.error('DeepL translation error:', error.message);
    return text;
  }
}

// ---------- Multi-Modal Commute Calculation ----------

async function calculateCommuteForMode(origin, destination, mode) {
  try {
    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/distancematrix/json',
      {
        params: {
          origins: origin,
          destinations: destination,
          key: GOOGLE_MAPS_API_KEY,
          mode: mode,
          language: 'en',
        },
        timeout: 8000,
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
    console.error('Google Maps ' + mode + ' error:', error.message);
    return null;
  }
}

async function calculateFullCommute(originAddress, destinationAddress) {
  if (!originAddress || !destinationAddress) {
    return null;
  }

  if (!GOOGLE_MAPS_API_KEY) {
    console.log('No Google Maps API key, using straight-line estimation');
    return await calculateStraightLineDistance(originAddress, destinationAddress);
  }

  const [transit, driving, bicycling, walking] = await Promise.all([
    calculateCommuteForMode(originAddress, destinationAddress, 'transit'),
    calculateCommuteForMode(originAddress, destinationAddress, 'driving'),
    calculateCommuteForMode(originAddress, destinationAddress, 'bicycling'),
    calculateCommuteForMode(originAddress, destinationAddress, 'walking'),
  ]);

  const primary = transit || driving || bicycling || walking;
  
  if (!primary) {
    return null;
  }

  return {
    distanceKm: primary.distanceKm,
    distanceText: primary.distanceText,
    transitMinutes: transit?.durationMinutes || null,
    transitText: transit?.durationText || null,
    drivingMinutes: driving?.durationMinutes || null,
    drivingText: driving?.durationText || null,
    bicyclingMinutes: bicycling?.durationMinutes || null,
    bicyclingText: bicycling?.durationText || null,
    walkingMinutes: walking?.durationMinutes || null,
    walkingText: walking?.durationText || null,
    durationMinutes: transit?.durationMinutes || driving?.durationMinutes || null,
    durationText: transit?.durationText || driving?.durationText || null,
  };
}

async function calculateStraightLineDistance(origin, destination) {
  try {
    const originCoords = await geocodeAddress(origin);
    const destCoords = await geocodeAddress(destination);

    if (!originCoords || !destCoords) {
      return null;
    }

    const km = haversineDistance(
      originCoords.lat, originCoords.lng,
      destCoords.lat, destCoords.lng
    );

    const estimatedTransitMin = Math.round(km * 4);
    const estimatedDrivingMin = Math.round(km * 2);
    const estimatedBicyclingMin = Math.round(km * 3);
    const estimatedWalkingMin = Math.round(km * 12);

    return {
      distanceKm: Math.round(km * 10) / 10,
      distanceText: Math.round(km * 10) / 10 + ' km (straight line)',
      transitMinutes: estimatedTransitMin,
      transitText: '~' + estimatedTransitMin + ' min (estimated)',
      drivingMinutes: estimatedDrivingMin,
      drivingText: '~' + estimatedDrivingMin + ' min (estimated)',
      bicyclingMinutes: estimatedBicyclingMin,
      bicyclingText: '~' + estimatedBicyclingMin + ' min (estimated)',
      walkingMinutes: estimatedWalkingMin,
      walkingText: '~' + estimatedWalkingMin + ' min (estimated)',
      durationMinutes: estimatedTransitMin,
      durationText: '~' + estimatedTransitMin + ' min (estimated)',
      isEstimate: true,
    };
  } catch (error) {
    console.error('Straight-line distance error:', error.message);
    return null;
  }
}

async function geocodeAddress(address) {
  if (!GOOGLE_MAPS_API_KEY) {
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
  const R = 6371;
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
  'meble': { icon: '🛋️', en: 'furniture' },
  'pralka': { icon: '🧺', en: 'washing machine' },
  'zmywarka': { icon: '🍽️', en: 'dishwasher' },
  'lodówka': { icon: '🧊', en: 'refrigerator' },
  'klimatyzacja': { icon: '❄️', en: 'air conditioning' },
  'internet': { icon: '🌐', en: 'internet' },
  'teren zamknięty': { icon: '🔒', en: 'gated area' },
  'garaż': { icon: '🚗', en: 'garage' },
  'miejsce parkingowe': { icon: '🅿️', en: 'parking space' },
  'piwnica': { icon: '📦', en: 'basement' },
  'winda': { icon: '🛗', en: 'elevator' },
  'ogród': { icon: '🌳', en: 'garden' },
  'monitoring': { icon: '📹', en: 'monitoring' },
  'ochrona': { icon: '👮', en: 'security' },
};

function decorateAmenity(amenity) {
  const key = String(amenity || '').toLowerCase().trim();
  
  for (const [polishKey, value] of Object.entries(AMENITY_MAP)) {
    if (key.includes(polishKey)) {
      return value.en + ' (' + amenity + ')';
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

async function parseOtodom($, url, baseLocationText) {
  baseLocationText = baseLocationText || '';
  const product = findOtodomProduct($);
  if (!product) {
    throw new Error('Could not find structured data on page (Otodom JSON-LD).');
  }

  const additional = product.additionalProperty || [];
  const getProp = function(namePart) {
    const lower = namePart.toLowerCase();
    const found = additional.find(function(p) {
      return String(p.name || '').toLowerCase().includes(lower);
    });
    return found ? String(found.value).trim() : null;
  };

  const area = getProp('powierzchnia');
  const rooms = getProp('liczba pokoi') || product.numberOfRooms;
  const availableFrom = getProp('dostępne od') || getProp('available from') || null;
  const admin = getProp('czynsz');
  const deposit = getProp('kaucja');
  const advertiserTypeRaw = getProp('typ ogłoszeniodawcy') || getProp('advertiser type') || null;

  const infoAdditional = getProp('informacje dodatkowe') || '';
  const equip = getProp('wyposażenie') || '';
  const media = getProp('media') || '';
  const safety = getProp('bezpieczeństwo') || '';
  const security = getProp('zabezpieczenia') || '';

  const amenitiesRaw = (infoAdditional + ', ' + equip + ', ' + media + ', ' + safety + ', ' + security)
    .split(',')
    .map(function(x) { return x.trim(); })
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

  // Smart description parsing
  const descriptionAnalysis = parseDescriptionForHiddenInfo(descriptionPL, descriptionEN);
  
  // Detect inconsistencies
  const inconsistencies = detectInconsistencies(
    { depositPLN: depositPLN, adminPLN: adminPLN, rentPLN: rentPLN },
    descriptionAnalysis
  );
  descriptionAnalysis.inconsistencies = inconsistencies;

  // Calculate "true" values accounting for hidden info
  const trueDepositPLN = descriptionAnalysis.hiddenDeposit && 
                          descriptionAnalysis.hiddenDeposit > (depositPLN || 0) 
                          ? descriptionAnalysis.hiddenDeposit 
                          : depositPLN;
  
  const trueAdminPLN = descriptionAnalysis.hiddenUtilities 
                        ? descriptionAnalysis.hiddenUtilities.avg 
                        : adminPLN;
  
  const trueTotalPLN = rentPLN ? rentPLN + (trueAdminPLN || 0) : null;

  // Determine advertiser type
  let advertiserType = advertiserTypeRaw ? advertiserTypeRaw.toLowerCase() : null;
  if (!advertiserType && descriptionAnalysis.advertiserType) {
    advertiserType = descriptionAnalysis.advertiserType;
  }

  // Calculate full commute data if base location provided
  let commuteData = null;
  if (baseLocationText && location) {
    commuteData = await calculateFullCommute(baseLocationText + ', Poland', location + ', Poland');
  }

  const summary = {
    site: 'otodom.pl',
    url: url,
    rent: rentPLN ? rentPLN + ' PLN' : null,
    rentPLN: rentPLN || null,
    admin: admin,
    adminPLN: adminPLN || null,
    deposit: deposit,
    depositPLN: depositPLN || null,
    totalPLN: totalPLN,
    trueDepositPLN: trueDepositPLN,
    trueAdminPLN: trueAdminPLN,
    trueTotalPLN: trueTotalPLN,
    hiddenUtilities: descriptionAnalysis.hiddenUtilities,
    advertiserType: advertiserType,
    rooms: rooms ? Number(rooms) : null,
    area: area,
    areaM2: areaNum,
    availableFrom: availableFrom,
    address: location,
    distanceKm: commuteData ? commuteData.distanceKm : null,
    distanceText: commuteData ? commuteData.distanceText : null,
    transitMinutes: commuteData ? commuteData.transitMinutes : null,
    transitText: commuteData ? commuteData.transitText : null,
    drivingMinutes: commuteData ? commuteData.drivingMinutes : null,
    drivingText: commuteData ? commuteData.drivingText : null,
    bicyclingMinutes: commuteData ? commuteData.bicyclingMinutes : null,
    bicyclingText: commuteData ? commuteData.bicyclingText : null,
    walkingMinutes: commuteData ? commuteData.walkingMinutes : null,
    walkingText: commuteData ? commuteData.walkingText : null,
    commuteIsEstimate: commuteData ? commuteData.isEstimate : false,
    durationMinutes: commuteData ? commuteData.durationMinutes : null,
    durationText: commuteData ? commuteData.durationText : null,
    amenities: amenitiesRaw.map(decorateAmenity),
    descriptionEN: descriptionEN,
    descriptionAnalysis: descriptionAnalysis,
    hasTerraceOrBalcony: hasTerraceOrBalcony,
    hasInternet: hasInternet,
    pricePerM2: pricePerM2,
  };

  summary.insights = generateInsights(summary);
  summary.risk = assessRisk(summary, descriptionAnalysis);

  return summary;
}

// ---------- Insights & Risk ----------

function generateInsights(summary) {
  const insights = [];

  if (summary.pricePerM2) {
    insights.push('Estimated price per m²: ' + summary.pricePerM2 + ' PLN (rent + admin, approx.).');
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

function assessRisk(summary, descriptionAnalysis) {
  descriptionAnalysis = descriptionAnalysis || {};
  const flags = [];
  let riskScore = 0;

  const rent = summary.rentPLN;
  const admin = summary.adminPLN;
  const deposit = summary.depositPLN;
  const ppm2 = summary.pricePerM2;

  // Check for inconsistencies from description analysis
  const inconsistencies = descriptionAnalysis.inconsistencies || [];
  for (let i = 0; i < inconsistencies.length; i++) {
    const inc = inconsistencies[i];
    if (inc.severity === 'high') {
      riskScore += 3;
      flags.push('⚠️ ' + inc.message);
    } else if (inc.severity === 'medium') {
      riskScore += 2;
      flags.push(inc.message);
    }
  }

  if (rent && deposit && deposit > 2 * rent) {
    flags.push('High deposit: more than 2× monthly rent.');
    riskScore += 2;
  }

  if (rent && admin && admin > 0.6 * rent) {
    flags.push('Admin / utilities are high compared to base rent.');
    riskScore += 1;
  }

  if (ppm2 && ppm2 > 150) {
    flags.push('Price per m² seems high.');
    riskScore += 2;
  }

  if (ppm2 && ppm2 < 40) {
    flags.push('Price per m² seems very low — double-check for hidden costs.');
    riskScore += 2;
  }

  if (!admin && !descriptionAnalysis.hiddenUtilities) {
    riskScore += 1;
    flags.push('Admin / utilities not specified.');
  }
  
  if (!deposit && !descriptionAnalysis.hiddenDeposit) {
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

  if (descriptionAnalysis.notaryInfo && descriptionAnalysis.notaryInfo.required) {
    riskScore += 1;
    flags.push('Notary contract required (adds complexity).');
  }

  if (descriptionAnalysis.registrationAllowed === false) {
    riskScore += 2;
    flags.push('Registration (zameldowanie) not possible.');
  }

  let level = 'Low';
  if (riskScore >= 6) level = 'High';
  else if (riskScore >= 3) level = 'Medium';

  const confidence = Math.max(40, 100 - riskScore * 5);

  return { level: level, score: riskScore, confidence: confidence, notes: flags };
}

// ---------- Routes ----------

app.post('/api/summarize', async function(req, res) {
  try {
    const url = req.body ? req.body.url : null;
    const baseLocationText = req.body ? req.body.baseLocationText : '';
    
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
    res.json({ success: true, summary: summary });
  } catch (error) {
    console.error('Error in /api/summarize:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch or analyze listing',
      details: error.message,
    });
  }
});

app.post('/api/summarize-html', async function(req, res) {
  try {
    const html = req.body ? req.body.html : null;
    const url = req.body ? req.body.url : '';
    const baseLocationText = req.body ? req.body.baseLocationText : '';
    
    if (!html || typeof html !== 'string' || html.length < 1000) {
      return res.status(400).json({ success: false, error: 'Missing html' });
    }
    const $ = cheerio.load(html);
    const summary = await parseOtodom($, url, baseLocationText);
    res.json({ success: true, summary: summary });
  } catch (err) {
    console.error('Error in /api/summarize-html:', err);
    res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

// Health check
app.get('/health', function(req, res) {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, function() {
  console.log('Server running on http://localhost:' + PORT);
  console.log('DeepL API: ' + (DEEPL_API_KEY ? 'Configured' : 'Not configured'));
  console.log('Google Maps API: ' + (GOOGLE_MAPS_API_KEY ? 'Configured' : 'Not configured'));
});

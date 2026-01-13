// server.js
// Backend for Polish apartment listing summarizer (Otodom)
// With multi-modal commute calculation, translation, and SMART DESCRIPTION PARSING

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

// ---------- SMART DESCRIPTION PARSER ----------
// Extracts hidden costs, inconsistencies, and important terms from description

function parseDescriptionForHiddenInfo(descriptionText, structuredData = {}) {
  const result = {
    hiddenDeposit: null,
    hiddenUtilities: null,
    contractTerms: [],
    notaryInfo: null,
    inconsistencies: [],
    importantNotes: [],
    extractedAmounts: [],
  };

  if (!descriptionText || typeof descriptionText !== 'string') {
    return result;
  }

  const text = descriptionText.toLowerCase();
  const originalText = descriptionText;

  // ===== DEPOSIT DETECTION =====
  // Patterns: "deposit of PLN X", "kaucja X PLN", "refundable deposit", etc.
  const depositPatterns = [
    /(?:deposit|kaucja|kaucji|kaucję)[^0-9]*?(\d[\d\s,.]*)\s*(?:pln|zł|zloty|złotych)?/gi,
    /(?:pln|zł)\s*(\d[\d\s,.]*)\s*(?:deposit|kaucja|kaucji)/gi,
    /(\d[\d\s,.]*)\s*(?:pln|zł|zloty|złotych)\s*(?:is required|deposit|kaucja|kaucji|as deposit)/gi,
    /refundable\s*(?:deposit)?\s*(?:of)?\s*(?:pln)?\s*(\d[\d\s,.]*)/gi,
  ];

  for (const pattern of depositPatterns) {
    const matches = [...originalText.matchAll(pattern)];
    for (const match of matches) {
      const amount = parseInt(match[1].replace(/[\s,.]/g, ''), 10);
      if (amount && amount > 100 && amount < 50000) {
        result.hiddenDeposit = amount;
        result.extractedAmounts.push({ type: 'deposit', amount, context: match[0].trim() });
        break;
      }
    }
    if (result.hiddenDeposit) break;
  }

  // ===== UTILITIES/ADMIN DETECTION =====
  // Patterns: "utilities ~X PLN", "media X zł", "for one person X PLN"
  const utilityPatterns = [
    /(?:utilities?|media|prąd|gaz|electricity|gas)[^0-9]*?[~≈]?\s*(\d[\d\s,.]*)\s*(?:pln|zł)/gi,
    /(?:for one person|dla jednej osoby|for 1 person)[^0-9]*?[~≈]?\s*(\d[\d\s,.]*)\s*(?:pln|zł)/gi,
    /(?:for two people?|dla dwóch osób|for 2 people?)[^0-9]*?[~≈]?\s*(\d[\d\s,.]*)\s*(?:pln|zł)/gi,
    /[~≈]\s*(\d[\d\s,.]*)\s*(?:pln|zł)[^.]*(?:per month|miesięcznie|monthly|utilities)/gi,
    /(?:amount|kwota)[^0-9]*(?:include|includes|should include)[^0-9]*?[~≈]?\s*(\d[\d\s,.]*)/gi,
    /(?:meters?|licznik|według licznika)[^0-9]*?[~≈]?\s*(\d[\d\s,.]*)\s*(?:pln|zł)/gi,
  ];

  const utilityAmounts = [];
  for (const pattern of utilityPatterns) {
    const matches = [...originalText.matchAll(pattern)];
    for (const match of matches) {
      const amount = parseInt(match[1].replace(/[\s,.]/g, ''), 10);
      if (amount && amount > 10 && amount < 2000) {
        utilityAmounts.push(amount);
        result.extractedAmounts.push({ type: 'utility', amount, context: match[0].trim() });
      }
    }
  }

  if (utilityAmounts.length > 0) {
    // Take the average or range
    const minUtil = Math.min(...utilityAmounts);
    const maxUtil = Math.max(...utilityAmounts);
    result.hiddenUtilities = {
      min: minUtil,
      max: maxUtil,
      isMetered: text.includes('meter') || text.includes('licznik') || text.includes('according to'),
    };
  }

  // ===== CONTRACT TERMS =====
  // Patterns: "12-month contract", "minimum X months", "notice period"
  const contractPatterns = [
    { regex: /(\d+)[\s-]*(?:month|miesiąc|miesięc)[^.]*(?:contract|umowa|minimum|min\.?)/gi, type: 'duration' },
    { regex: /(?:contract|umowa)[^.]*(\d+)[\s-]*(?:month|miesiąc|miesięc)/gi, type: 'duration' },
    { regex: /(?:minimum|min\.?)[^.]*(\d+)[\s-]*(?:month|miesiąc)/gi, type: 'minimum' },
    { regex: /(?:notice|wypowiedzenie)[^.]*(\d+)[\s-]*(?:month|miesiąc|week|tydzień)/gi, type: 'notice' },
  ];

  for (const { regex, type } of contractPatterns) {
    const matches = [...originalText.matchAll(regex)];
    for (const match of matches) {
      const months = parseInt(match[1], 10);
      if (months && months > 0 && months <= 36) {
        result.contractTerms.push({ type, months, context: match[0].trim() });
      }
    }
  }

  // ===== NOTARY INFO =====
  if (text.includes('notary') || text.includes('notariusz') || text.includes('notarial')) {
    const notaryMatch = originalText.match(/(?:notary|notariusz|notarial)[^.]*?(\d+)?\s*%?/i);
    result.notaryInfo = {
      mentioned: true,
      percentage: notaryMatch && notaryMatch[1] ? parseInt(notaryMatch[1], 10) : null,
      context: notaryMatch ? notaryMatch[0].trim() : 'Notary mentioned',
    };
    result.importantNotes.push('Contract requires notary signing (additional cost)');
  }

  // ===== INCONSISTENCY DETECTION =====
  // Compare description values with structured data
  const structuredDeposit = structuredData.depositPLN;
  if (result.hiddenDeposit && structuredDeposit) {
    const diff = Math.abs(result.hiddenDeposit - structuredDeposit);
    const percentDiff = (diff / Math.max(result.hiddenDeposit, structuredDeposit)) * 100;
    
    if (percentDiff > 20) {
      result.inconsistencies.push({
        type: 'deposit_mismatch',
        severity: 'high',
        listed: structuredDeposit,
        inDescription: result.hiddenDeposit,
        message: `Deposit mismatch: Listed as ${structuredDeposit} PLN but description says ${result.hiddenDeposit} PLN`,
      });
    }
  }

  // If structured deposit is missing but found in description
  if (result.hiddenDeposit && !structuredDeposit) {
    result.importantNotes.push(`Deposit of ${result.hiddenDeposit} PLN found in description (not in listing fields)`);
  }

  // Check for metered utilities vs flat admin
  const structuredAdmin = structuredData.adminPLN;
  if (result.hiddenUtilities && result.hiddenUtilities.isMetered) {
    if (structuredAdmin && structuredAdmin < 10) {
      result.inconsistencies.push({
        type: 'utility_hidden',
        severity: 'medium',
        message: `Listed admin is ${structuredAdmin} PLN but description mentions metered utilities (~${result.hiddenUtilities.min}-${result.hiddenUtilities.max} PLN)`,
      });
    }
    result.importantNotes.push(`Utilities are metered: ~${result.hiddenUtilities.min}-${result.hiddenUtilities.max} PLN/month based on usage`);
  }

  // ===== IMPORTANT NOTES EXTRACTION =====
  // Look for student restrictions, pet policies, etc.
  if (text.includes('student') || text.includes('studentów')) {
    if (text.includes('also rent to students') || text.includes('również studentom')) {
      result.importantNotes.push('Students welcome');
    } else if (text.includes('no students') || text.includes('bez studentów')) {
      result.importantNotes.push('No students allowed');
    }
  }

  if (text.includes('no pets') || text.includes('bez zwierząt') || text.includes('zakaz zwierząt')) {
    result.importantNotes.push('No pets allowed');
  } else if (text.includes('pets allowed') || text.includes('zwierzęta mile widziane') || text.includes('pets welcome')) {
    result.importantNotes.push('Pets allowed');
  }

  if (text.includes('no smoking') || text.includes('niepalących') || text.includes('zakaz palenia')) {
    result.importantNotes.push('Non-smokers only');
  }

  // Registration/zameldowanie
  if (text.includes('zameldowanie') || text.includes('registration')) {
    if (text.includes('no registration') || text.includes('bez zameldowania') || text.includes('brak możliwości zameldowania')) {
      result.importantNotes.push('Registration (zameldowanie) NOT possible');
      result.inconsistencies.push({
        type: 'no_registration',
        severity: 'medium',
        message: 'Registration not possible - may affect visa/residency',
      });
    } else if (text.includes('registration possible') || text.includes('możliwość zameldowania')) {
      result.importantNotes.push('Registration (zameldowanie) possible');
    }
  }

  // Commission/agency fee hidden in description
  if (text.includes('commission') || text.includes('prowizja') || text.includes('agency fee')) {
    const commissionMatch = originalText.match(/(?:commission|prowizja|agency fee)[^.]*?(\d+)\s*%?/i);
    if (commissionMatch) {
      result.importantNotes.push(`Agency commission: ${commissionMatch[1]}%`);
    } else {
      result.importantNotes.push('Agency commission may apply (check with landlord)');
    }
  }

  return result;
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
    console.error(`Google Maps ${mode} error:`, error.message);
    return null;
  }
}

async function calculateFullCommute(originAddress, destinationAddress) {
  if (!originAddress || !destinationAddress) {
    return null;
  }

  // If no API key, use straight-line fallback
  if (!GOOGLE_MAPS_API_KEY) {
    console.log('No Google Maps API key, using straight-line estimation');
    return await calculateStraightLineDistance(originAddress, destinationAddress);
  }

  // Fetch all transport modes in parallel
  const [transit, driving, bicycling, walking] = await Promise.all([
    calculateCommuteForMode(originAddress, destinationAddress, 'transit'),
    calculateCommuteForMode(originAddress, destinationAddress, 'driving'),
    calculateCommuteForMode(originAddress, destinationAddress, 'bicycling'),
    calculateCommuteForMode(originAddress, destinationAddress, 'walking'),
  ]);

  // Use transit as primary, fallback to driving for distance
  const primary = transit || driving || bicycling || walking;
  
  if (!primary) {
    return null;
  }

  return {
    // Primary distance info
    distanceKm: primary.distanceKm,
    distanceText: primary.distanceText,
    
    // Transit commute
    transitMinutes: transit?.durationMinutes || null,
    transitText: transit?.durationText || null,
    
    // Driving commute
    drivingMinutes: driving?.durationMinutes || null,
    drivingText: driving?.durationText || null,
    
    // Bicycling commute
    bicyclingMinutes: bicycling?.durationMinutes || null,
    bicyclingText: bicycling?.durationText || null,
    
    // Walking commute
    walkingMinutes: walking?.durationMinutes || null,
    walkingText: walking?.durationText || null,
    
    // Legacy fields for backwards compatibility
    durationMinutes: transit?.durationMinutes || driving?.durationMinutes || null,
    durationText: transit?.durationText || driving?.durationText || null,
  };
}

// Fallback: straight-line distance
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

    // Estimate times based on straight-line distance
    const estimatedTransitMin = Math.round(km * 4); // ~15km/h average
    const estimatedDrivingMin = Math.round(km * 2); // ~30km/h average in city
    const estimatedBicyclingMin = Math.round(km * 3); // ~20km/h average
    const estimatedWalkingMin = Math.round(km * 12); // ~5km/h

    return {
      distanceKm: Math.round(km * 10) / 10,
      distanceText: `${Math.round(km * 10) / 10} km (straight line)`,
      transitMinutes: estimatedTransitMin,
      transitText: `~${estimatedTransitMin} min (estimated)`,
      drivingMinutes: estimatedDrivingMin,
      drivingText: `~${estimatedDrivingMin} min (estimated)`,
      bicyclingMinutes: estimatedBicyclingMin,
      bicyclingText: `~${estimatedBicyclingMin} min (estimated)`,
      walkingMinutes: estimatedWalkingMin,
      walkingText: `~${estimatedWalkingMin} min (estimated)`,
      durationMinutes: estimatedTransitMin,
      durationText: `~${estimatedTransitMin} min (estimated)`,
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

  // ===== SMART DESCRIPTION PARSING =====
  const descriptionAnalysis = parseDescriptionForHiddenInfo(descriptionEN, {
    depositPLN,
    adminPLN,
    rentPLN,
  });

  // Calculate full commute data if base location provided
  let commuteData = null;
  if (baseLocationText && location) {
    commuteData = await calculateFullCommute(baseLocationText + ', Poland', location + ', Poland');
  }

  // Calculate TRUE total including hidden utilities
  let trueTotalPLN = totalPLN;
  let trueAdminPLN = adminPLN;
  if (descriptionAnalysis.hiddenUtilities) {
    const avgUtility = Math.round((descriptionAnalysis.hiddenUtilities.min + descriptionAnalysis.hiddenUtilities.max) / 2);
    if (!adminPLN || adminPLN < 10) {
      trueAdminPLN = avgUtility;
      trueTotalPLN = rentPLN ? rentPLN + avgUtility : null;
    }
  }

  // Use description deposit if structured is missing or inconsistent
  let trueDepositPLN = depositPLN;
  if (descriptionAnalysis.hiddenDeposit) {
    if (!depositPLN) {
      trueDepositPLN = descriptionAnalysis.hiddenDeposit;
    } else if (descriptionAnalysis.hiddenDeposit > depositPLN) {
      // Trust the higher amount (usually the real one)
      trueDepositPLN = descriptionAnalysis.hiddenDeposit;
    }
  }

  const summary = {
    site: 'otodom.pl',
    url,

    // monetary fields (original from structured data)
    rent: rentPLN ? `${rentPLN} PLN` : null,
    rentPLN: rentPLN || null,
    admin,
    adminPLN: adminPLN || null,
    deposit,
    depositPLN: depositPLN || null,
    totalPLN,

    // TRUE values (accounting for description info)
    trueAdminPLN,
    trueTotalPLN,
    trueDepositPLN,
    hiddenUtilities: descriptionAnalysis.hiddenUtilities,

    // physical
    rooms: rooms ? Number(rooms) : null,
    area,
    areaM2: areaNum,
    availableFrom,

    // location
    address: location,

    // commute data (full)
    distanceKm: commuteData?.distanceKm || null,
    distanceText: commuteData?.distanceText || null,
    transitMinutes: commuteData?.transitMinutes || null,
    transitText: commuteData?.transitText || null,
    drivingMinutes: commuteData?.drivingMinutes || null,
    drivingText: commuteData?.drivingText || null,
    bicyclingMinutes: commuteData?.bicyclingMinutes || null,
    bicyclingText: commuteData?.bicyclingText || null,
    walkingMinutes: commuteData?.walkingMinutes || null,
    walkingText: commuteData?.walkingText || null,
    commuteIsEstimate: commuteData?.isEstimate || false,
    
    // Legacy fields for backwards compatibility
    durationMinutes: commuteData?.durationMinutes || null,
    durationText: commuteData?.durationText || null,

    // amenities + description
    amenities: amenitiesRaw.map(decorateAmenity),
    descriptionEN,

    // ===== NEW: Description Analysis =====
    descriptionAnalysis: {
      inconsistencies: descriptionAnalysis.inconsistencies,
      importantNotes: descriptionAnalysis.importantNotes,
      contractTerms: descriptionAnalysis.contractTerms,
      notaryInfo: descriptionAnalysis.notaryInfo,
      extractedAmounts: descriptionAnalysis.extractedAmounts,
    },

    // extras used by insights / risk
    hasTerraceOrBalcony,
    hasInternet,
    pricePerM2,
  };

  // Add insights + risk object (enhanced with description analysis)
  summary.insights = generateInsights(summary, descriptionAnalysis);
  summary.risk = assessRisk(summary, descriptionAnalysis);

  return summary;
}

// ---------- Insights & Risk (ENHANCED) ----------

function generateInsights(summary, descriptionAnalysis = {}) {
  const insights = [];

  if (summary.pricePerM2) {
    insights.push(`Estimated price per m²: ${summary.pricePerM2} PLN (rent + admin, approx.).`);
  }

  if (!summary.adminPLN && !descriptionAnalysis.hiddenUtilities) {
    insights.push('Admin / building fee is not clearly listed.');
  }

  if (!summary.depositPLN && !descriptionAnalysis.hiddenDeposit) {
    insights.push('Deposit amount is not listed.');
  }

  if (!summary.availableFrom) {
    insights.push('Availability date is not specified.');
  }

  // Add insights from description analysis
  if (descriptionAnalysis.hiddenUtilities) {
    insights.push(`Utilities are metered: ~${descriptionAnalysis.hiddenUtilities.min}-${descriptionAnalysis.hiddenUtilities.max} PLN/month`);
  }

  if (descriptionAnalysis.contractTerms && descriptionAnalysis.contractTerms.length > 0) {
    const durationTerm = descriptionAnalysis.contractTerms.find(t => t.type === 'duration' || t.type === 'minimum');
    if (durationTerm) {
      insights.push(`Contract: ${durationTerm.months} month minimum`);
    }
  }

  if (descriptionAnalysis.notaryInfo && descriptionAnalysis.notaryInfo.mentioned) {
    insights.push('Notary contract required (additional signing cost)');
  }

  return insights;
}

function assessRisk(summary, descriptionAnalysis = {}) {
  const flags = [];
  let riskScore = 0;

  const rent = summary.rentPLN;
  const admin = summary.adminPLN;
  const deposit = summary.depositPLN;
  const ppm2 = summary.pricePerM2;

  // Original risk checks
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
    flags.push('Admin / utilities not specified in listing fields.');
  }
  if (!deposit) {
    riskScore += 1;
    flags.push('Deposit not specified in listing fields.');
  }

  if (!summary.descriptionEN || summary.descriptionEN.length < 200) {
    riskScore += 1;
    flags.push('Description is short or vague.');
  }

  if (!summary.availableFrom) {
    riskScore += 1;
    flags.push('Availability date not specified.');
  }

  // ===== ENHANCED: Inconsistency-based risk =====
  if (descriptionAnalysis.inconsistencies) {
    for (const inconsistency of descriptionAnalysis.inconsistencies) {
      if (inconsistency.severity === 'high') {
        riskScore += 3;
        flags.push(`⚠️ ${inconsistency.message}`);
      } else if (inconsistency.severity === 'medium') {
        riskScore += 2;
        flags.push(`${inconsistency.message}`);
      }
    }
  }

  // Check for true deposit being much higher
  if (summary.trueDepositPLN && summary.depositPLN && summary.trueDepositPLN > summary.depositPLN * 1.3) {
    riskScore += 2;
    flags.push(`Actual deposit (${summary.trueDepositPLN} PLN) higher than listed (${summary.depositPLN} PLN)`);
  }

  // Hidden utilities warning
  if (descriptionAnalysis.hiddenUtilities && (!admin || admin < 10)) {
    riskScore += 1;
    flags.push(`Hidden utilities: ~${descriptionAnalysis.hiddenUtilities.min}-${descriptionAnalysis.hiddenUtilities.max} PLN/month not in admin fee`);
  }

  // Notary requirement increases complexity
  if (descriptionAnalysis.notaryInfo && descriptionAnalysis.notaryInfo.mentioned) {
    riskScore += 1;
    flags.push('Notary contract required – adds cost and complexity');
  }

  // No registration possible is a red flag for expats
  if (descriptionAnalysis.importantNotes) {
    if (descriptionAnalysis.importantNotes.some(n => n.includes('NOT possible'))) {
      riskScore += 2;
      flags.push('Registration (zameldowanie) not possible – affects visa/residency');
    }
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

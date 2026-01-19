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

// ---------- District Vibe Data (Neighborhood Intel + Expat Density) ----------

const DISTRICT_VIBES = {
  // ===== WARSAW =====
  'śródmieście': { city: 'Warsaw', vibe: 'The beating heart - business by day, cocktails by night. Expect noise, tourists, and premium everything.', expatDensity: 'high', expatNote: 'Very English-friendly. International crowd, easy to navigate without Polish.', priceTier: 'premium' },
  'mokotów': { city: 'Warsaw', vibe: 'The reliable choice - good schools, parks, cafes. Safe but not exciting. Where professionals settle down.', expatDensity: 'high', expatNote: 'Popular with expat families. Many English-speaking services and international schools nearby.', priceTier: 'high' },
  'wilanów': { city: 'Warsaw', vibe: 'New-build paradise with palace views. Quiet, spacious, but you\'ll need a car. Suburban feel in the city.', expatDensity: 'high', expatNote: 'Very popular with expat families. American & British schools nearby. English widely spoken.', priceTier: 'premium' },
  'wola': { city: 'Warsaw', vibe: 'The hot one - startups, new towers, craft beer. Gentrifying fast. Some blocks fancy, others still gritty.', expatDensity: 'medium', expatNote: 'Growing expat scene, especially young professionals. Mix of English-friendly and local spots.', priceTier: 'high' },
  'praga północ': { city: 'Warsaw', vibe: 'The artsy rebel - street art, dive bars, authentic grit. Gentrifying but keeping it real. Some blocks sketchy after dark.', expatDensity: 'low', expatNote: 'Adventurous expats only. Bring Google Translate. Authentic but requires Polish for daily life.', priceTier: 'budget' },
  'praga południe': { city: 'Warsaw', vibe: 'Praga\'s calmer sibling - parks, families, improving fast. Better connected than you\'d think.', expatDensity: 'low', expatNote: 'Few expats, very local feel. Good value but Polish language helpful.', priceTier: 'budget' },
  'żoliborz': { city: 'Warsaw', vibe: 'The intellectual\'s choice - tree-lined streets, professors, and quiet dignity. Old Warsaw charm.', expatDensity: 'medium', expatNote: 'Some expats, especially academics. Charming but more Polish-speaking than central areas.', priceTier: 'high' },
  'ursynów': { city: 'Warsaw', vibe: 'Student central meets family suburbia. Metro-connected but feels like a satellite town. Practical, not pretty.', expatDensity: 'low', expatNote: 'University area with some international students. Basic English in shops, but mostly Polish.', priceTier: 'mid' },
  'bielany': { city: 'Warsaw', vibe: 'Green and peaceful - Kampinos forest nearby, university vibes. Good for nature lovers who still want metro.', expatDensity: 'low', expatNote: 'Few expats. Very local, Polish needed for most interactions.', priceTier: 'mid' },
  'bemowo': { city: 'Warsaw', vibe: 'New developments on old airfield. Good value, good transport, zero personality. Pure functionality.', expatDensity: 'low', expatNote: 'Rare expats. Very local, Polish essential.', priceTier: 'mid' },
  'ochota': { city: 'Warsaw', vibe: 'Central without the price tag - student area near universities. Good transport, mixed architecture.', expatDensity: 'medium', expatNote: 'Some international students. Basic English in main areas.', priceTier: 'mid' },
  'targówek': { city: 'Warsaw', vibe: 'Working-class roots, slowly changing. Good metro now. Real Warsaw, no Instagram filter.', expatDensity: 'low', expatNote: 'Very few expats. Polish language essential. Authentic local experience.', priceTier: 'budget' },
  'białołęka': { city: 'Warsaw', vibe: 'Edge of the city - new estates, young families, traffic jams. Affordable but you pay in commute time.', expatDensity: 'low', expatNote: 'Almost no expats. Very local, car helpful, Polish essential.', priceTier: 'budget' },
  // ===== KRAKOW =====
  'stare miasto': { city: 'Krakow', vibe: 'Postcard perfect but tourist chaos. Beautiful but noisy. Living in a museum has its drawbacks.', expatDensity: 'high', expatNote: 'Very English-friendly but touristy. Easy for newcomers, hard for peace and quiet.', priceTier: 'premium' },
  'kazimierz': { city: 'Krakow', vibe: 'The cool kid - Jewish heritage, hipster cafes, weekend crowds. Artsy, expensive, Instagram-ready.', expatDensity: 'high', expatNote: 'Expat hotspot. English everywhere. International vibe but premium prices.', priceTier: 'premium' },
  'podgórze': { city: 'Krakow', vibe: 'Kazimierz overflow - still cool, slightly cheaper. Zabłocie tech hub nearby brings young professionals.', expatDensity: 'medium', expatNote: 'Growing expat scene. Good English in new developments, more local elsewhere.', priceTier: 'high' },
  'krowodrza': { city: 'Krakow', vibe: 'Green and university-adjacent. Jordan Park, student vibes, real neighborhoods. Good balance.', expatDensity: 'medium', expatNote: 'Mixed - some expats near university. Decent English, local feel.', priceTier: 'mid' },
  'nowa huta': { city: 'Krakow', vibe: 'Socialist realism architecture tour. Fascinating history, cheap rent, looong commute to center.', expatDensity: 'low', expatNote: 'Adventure territory. Very local, Polish essential, but incredible value.', priceTier: 'budget' },
  // ===== WROCŁAW =====
  'krzyki': { city: 'Wroclaw', vibe: 'Big and varied - from fancy villas to communist blocks. Check the exact street carefully.', expatDensity: 'medium', expatNote: 'Mixed expat presence. Depends heavily on exact location.', priceTier: 'mid' },
  'fabryczna': { city: 'Wroclaw', vibe: 'West side story - new developments, business parks, improving fast.', expatDensity: 'medium', expatNote: 'Tech companies bringing expats. New areas more English-friendly.', priceTier: 'mid' },
  // ===== GDAŃSK =====
  'wrzeszcz': { city: 'Gdansk', vibe: 'The real Gdańsk - university, cafes, real neighborhoods. Best balance of price and life.', expatDensity: 'medium', expatNote: 'Growing expat scene. Good mix of local and international.', priceTier: 'mid' },
  'oliwa': { city: 'Gdansk', vibe: 'Park district - cathedral, zoo, green space. Quiet, established, further from action.', expatDensity: 'medium', expatNote: 'Some expat families. Quieter, more residential English.', priceTier: 'high' },
  // ===== POZNAŃ =====
  'jeżyce': { city: 'Poznan', vibe: 'The Brooklyn of Poznań - hipster cafes, vintage shops, young creative crowd.', expatDensity: 'medium', expatNote: 'Trendy expat spot. Good English in cafes.', priceTier: 'high' },
  'grunwald': { city: 'Poznan', vibe: 'Massive and varied - trade fair area, mix of old and new. Check exact location.', expatDensity: 'medium', expatNote: 'Business expats during fairs. Mixed otherwise.', priceTier: 'mid' },
};

function getDistrictVibe(address) {
  if (!address) return null;
  const addressLower = address.toLowerCase();
  for (const [districtKey, vibeData] of Object.entries(DISTRICT_VIBES)) {
    if (addressLower.includes(districtKey)) {
      return { district: districtKey.charAt(0).toUpperCase() + districtKey.slice(1), ...vibeData };
    }
  }
  const variations = { 'srodmiescie': 'śródmieście', 'mokotow': 'mokotów', 'wilanow': 'wilanów', 'zoliborz': 'żoliborz', 'ursynow': 'ursynów', 'bialoleka': 'białołęka', 'targowek': 'targówek', 'praga polnoc': 'praga północ', 'praga poludnie': 'praga południe', 'jezyce': 'jeżyce' };
  for (const [variation, proper] of Object.entries(variations)) {
    if (addressLower.includes(variation) && DISTRICT_VIBES[proper]) {
      return { district: proper.charAt(0).toUpperCase() + proper.slice(1), ...DISTRICT_VIBES[proper] };
    }
  }
  return null;
}

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

  // METERED UTILITIES DETECTION - ONLY extract if EXPLICITLY stated as "per person" utility costs
  // Be very strict - only match clear "utilities ~X PLN per person" patterns
  const utilityPatterns = [
    /(?:media|utilities|opłaty licznikowe)[^0-9]{0,20}(?:ok\.?|około|approx\.?|~|≈)\s*(\d+)(?:\s*-\s*(\d+))?\s*(?:pln|zł)[^0-9]{0,20}(?:osob|person|miesięc|month)/gi,
    /(?:for one person|dla jednej osoby|na 1 osobę)[^0-9]{0,15}(?:ok\.?|około|~|≈)?\s*(\d+)\s*(?:pln|zł)/gi,
    /(?:for two|dla dwóch|na 2 osob)[^0-9]{0,15}(?:ok\.?|około|~|≈)?\s*(\d+)\s*(?:pln|zł)/gi,
  ];

  let utilityMin = null;
  let utilityMax = null;

  for (const pattern of utilityPatterns) {
    const matches = combined.matchAll(pattern);
    for (const match of matches) {
      const val1 = parseInt(match[1], 10);
      const val2 = match[2] ? parseInt(match[2], 10) : null;
      
      // Only accept values that are clearly utility costs (50-500 PLN range for per-person utilities)
      if (val1 && val1 >= 50 && val1 <= 500) {
        if (!utilityMin || val1 < utilityMin) utilityMin = val1;
        if (!utilityMax || val1 > utilityMax) utilityMax = val1;
      }
      if (val2 && val2 >= 50 && val2 <= 500) {
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

  // ADDITIONAL FEES DETECTION (internet, TV, parking, etc.)
  // Be VERY careful not to pick up random numbers like bus lines, distances, m2, etc.
  result.additionalFees = [];
  
  // Helper: Check if number appears in a "bad" context (bus, distance, m2, floor, etc.)
  const isNumberInBadContext = (text, matchIndex, matchLength) => {
    const before = text.substring(Math.max(0, matchIndex - 50), matchIndex).toLowerCase();
    const after = text.substring(matchIndex + matchLength, matchIndex + matchLength + 50).toLowerCase();
    const context = before + after;
    
    // Bad contexts to exclude
    const badPatterns = [
      /lini[ae]|line|bus|autobus|tramwaj|tram|metro/,
      /\d+\s*m[²2\s]|metr|square/,  // Square meters
      /floor|piętro|piętr/,
      /km|kilom|odległ|distance|od\s+/,
      /rok|year|lat\s/,
      /osób|person|people|mieszk/,  // Number of people
      /numer|number|nr\s/,
      /id[:\s]/,
      /telefon|phone|tel[:\.\s]/,
    ];
    
    return badPatterns.some(p => p.test(context));
  };
  
  // Internet fee - must be explicitly labeled
  const internetMatch = combined.match(/internet[^0-9]{0,30}?(\d{2,3})\s*(?:pln|zł)/i) ||
                        combined.match(/(\d{2,3})\s*(?:pln|zł)[^.]{0,20}internet/i);
  if (internetMatch) {
    const amount = parseInt(internetMatch[1], 10);
    const matchIndex = combined.indexOf(internetMatch[0]);
    if (amount >= 40 && amount <= 200 && !isNumberInBadContext(combined, matchIndex, internetMatch[0].length)) {
      result.additionalFees.push({ type: 'internet', amount, label: 'Internet' });
    }
  }

  // TV/Cable fee - must be explicitly labeled
  const tvMatch = combined.match(/(?:tv|telewizj|cable|kablów)[^0-9]{0,20}?(\d{2,3})\s*(?:pln|zł)/i) ||
                  combined.match(/(\d{2,3})\s*(?:pln|zł)[^.]{0,15}(?:tv|telewizj|cable)/i);
  if (tvMatch && !result.additionalFees.some(f => f.type === 'internet')) {
    const amount = parseInt(tvMatch[1], 10);
    const matchIndex = combined.indexOf(tvMatch[0]);
    if (amount >= 30 && amount <= 150 && !isNumberInBadContext(combined, matchIndex, tvMatch[0].length)) {
      result.additionalFees.push({ type: 'tv', amount, label: 'TV/Cable' });
    }
  }

  // Combined Internet + TV pattern (like "internet + TV – 120 PLN")
  const comboMatch = combined.match(/internet[^0-9]{0,10}(?:\+|and|oraz|i)[^0-9]{0,10}(?:tv|telewizj|upc|cable)[^0-9]{0,15}?(\d{2,3})\s*(?:pln|zł)/i);
  if (comboMatch) {
    const amount = parseInt(comboMatch[1], 10);
    if (amount >= 60 && amount <= 250) {
      // Remove individual internet/tv if we found combo
      result.additionalFees = result.additionalFees.filter(f => f.type !== 'internet' && f.type !== 'tv');
      result.additionalFees.push({ type: 'internet_tv', amount, label: 'Internet + TV' });
    }
  }

  // Parking fee - must be explicitly about parking cost
  const parkingMatch = combined.match(/(?:parking|garaż|garage|miejsce postojowe|miejsce garażowe)[^0-9]{0,25}?(\d{2,3})\s*(?:pln|zł)/i) ||
                       combined.match(/(\d{2,3})\s*(?:pln|zł)[^.]{0,20}(?:parking|garaż|garage|postojow)/i);
  if (parkingMatch) {
    const amount = parseInt(parkingMatch[1], 10);
    const matchIndex = combined.indexOf(parkingMatch[0]);
    if (amount >= 100 && amount <= 500 && !isNumberInBadContext(combined, matchIndex, parkingMatch[0].length)) {
      result.additionalFees.push({ type: 'parking', amount, label: 'Parking' });
    }
  }

  // METERED/CONSUMPTION-BASED FEES FLAG
  result.hasMeteredFees = false;
  result.meteredFeeTypes = [];
  
  const meteredPatterns = [
    { pattern: /(?:meter|licznik|według zużycia|wg zużycia|according to consumption|based on consumption|faktyczne zużycie)/gi, type: 'general' },
    { pattern: /(?:electricity|prąd|elektryczn)[^.]*(?:meter|licznik|zużyci|consumption)/gi, type: 'electricity' },
    { pattern: /(?:gas|gaz)[^.]*(?:meter|licznik|zużyci|consumption)/gi, type: 'gas' },
    { pattern: /(?:water|woda|wod)[^.]*(?:meter|licznik|zużyci|consumption)/gi, type: 'water' },
    { pattern: /(?:meter fees|opłaty licznikowe|media według)/gi, type: 'general' },
  ];
  
  for (const { pattern, type } of meteredPatterns) {
    if (pattern.test(combined)) {
      result.hasMeteredFees = true;
      if (type !== 'general' && !result.meteredFeeTypes.includes(type)) {
        result.meteredFeeTypes.push(type);
      }
    }
  }

  // If we detected metered fees but didn't catch specific types, mark as general utilities
  if (result.hasMeteredFees && result.meteredFeeTypes.length === 0) {
    // Check for specific mentions even without meter keywords
    if (combined.includes('elektryczn') || combined.includes('electricity') || combined.includes('prąd')) {
      result.meteredFeeTypes.push('electricity');
    }
    if (combined.includes('gaz') || combined.includes('gas')) {
      result.meteredFeeTypes.push('gas');
    }
  }

  // Calculate total additional fixed fees
  result.totalAdditionalFees = result.additionalFees.reduce((sum, f) => sum + f.amount, 0);

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

  // Note: Additional fees and metered utilities are now shown in the Description Extras card
  // We no longer show them as inconsistencies/warnings

  return inconsistencies;
}

// ---------- Listing Intelligence (Age, Updates, Negotiation) ----------

function extractListingIntelligence($, html) {
  const result = {
    listingId: null,
    dateAdded: null,
    dateUpdated: null,
    daysOnMarket: null,
    wasUpdated: false,
    priceHistory: [],
    negotiationPotential: null,
    negotiationTips: [],
  };

  const bodyText = html || '';
  const lowerText = bodyText.toLowerCase();

  // Extract listing ID from URL or page
  // Otodom IDs are usually like "ID4zELg" at end of URL or "ID: 67603514" in page
  const idPatterns = [
    /id[:\s]*(\d{6,10})/i,
    /oferta[\/\-].*?-id([a-z0-9]+)/i,
    /"offerId"[:\s]*"?(\d+)"?/i,
    /"id"[:\s]*"?(\d+)"?.*?"__typename"[:\s]*"?Ad/i,
  ];
  
  for (const pattern of idPatterns) {
    const match = bodyText.match(pattern);
    if (match) {
      result.listingId = match[1];
      break;
    }
  }

  // Extract dates - Otodom typically shows "Dodano: DD.MM.YYYY" and "Aktualizacja: DD.MM.YYYY"
  // Also look for JSON data with dateCreated, dateModified
  
  // Pattern 1: Polish format in visible text
  const addedPatterns = [
    /dodano[:\s]*(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/i,
    /added[:\s]*(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/i,
    /data dodania[:\s]*(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/i,
    /"dateCreated"[:\s]*"(\d{4})-(\d{2})-(\d{2})/i,
    /"createdAt"[:\s]*"(\d{4})-(\d{2})-(\d{2})/i,
  ];

  const updatedPatterns = [
    /aktualiz[a-z]*[:\s]*(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/i,
    /updated[:\s]*(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/i,
    /ostatnia aktualiz[a-z]*[:\s]*(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/i,
    /"dateModified"[:\s]*"(\d{4})-(\d{2})-(\d{2})/i,
    /"modifiedAt"[:\s]*"(\d{4})-(\d{2})-(\d{2})/i,
  ];

  // Try to find added date
  for (const pattern of addedPatterns) {
    const match = bodyText.match(pattern);
    if (match) {
      // Check if it's ISO format (YYYY-MM-DD) or Polish format (DD.MM.YYYY)
      let dateStr;
      if (match[1].length === 4) {
        // ISO format: YYYY-MM-DD
        dateStr = `${match[1]}-${match[2]}-${match[3]}`;
      } else {
        // Polish format: DD.MM.YYYY - convert to ISO
        const year = match[3].length === 2 ? '20' + match[3] : match[3];
        dateStr = `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
      }
      
      const parsed = new Date(dateStr);
      if (!isNaN(parsed.getTime())) {
        result.dateAdded = dateStr;
        break;
      }
    }
  }

  // Try to find updated date
  for (const pattern of updatedPatterns) {
    const match = bodyText.match(pattern);
    if (match) {
      let dateStr;
      if (match[1].length === 4) {
        dateStr = `${match[1]}-${match[2]}-${match[3]}`;
      } else {
        const year = match[3].length === 2 ? '20' + match[3] : match[3];
        dateStr = `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
      }
      
      const parsed = new Date(dateStr);
      if (!isNaN(parsed.getTime())) {
        result.dateUpdated = dateStr;
        result.wasUpdated = true;
        break;
      }
    }
  }

  // Calculate days on market
  if (result.dateAdded) {
    const addedDate = new Date(result.dateAdded);
    const now = new Date();
    const diffTime = now.getTime() - addedDate.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    result.daysOnMarket = diffDays >= 0 ? diffDays : null;
  }

  // Look for price changes in the page data
  // Otodom sometimes has "Historia cen" or price history in JSON
  const priceHistoryPatterns = [
    /"priceHistory"[:\s]*\[(.*?)\]/i,
    /"previousPrice"[:\s]*(\d+)/i,
    /cena poprzednia[:\s]*(\d[\d\s]*)/i,
    /obniżka[:\s]*(\d+)/i,
    /price drop|obniżono|reduced/i,
  ];

  // Check for price drop indicators
  if (/obniżka|obniżono|reduced|price drop|przecena/i.test(bodyText)) {
    result.priceDropped = true;
    
    // Try to extract previous price
    const prevPriceMatch = bodyText.match(/(?:poprzednia cena|previous price|było)[:\s]*(\d[\d\s]*)\s*(?:pln|zł)/i);
    if (prevPriceMatch) {
      result.previousPrice = parseInt(prevPriceMatch[1].replace(/\s/g, ''), 10);
    }
  }

  // Calculate negotiation potential based on days on market
  if (result.daysOnMarket !== null) {
    if (result.daysOnMarket <= 7) {
      result.negotiationPotential = 'low';
      result.negotiationTips.push('Fresh listing - landlord unlikely to negotiate yet');
    } else if (result.daysOnMarket <= 21) {
      result.negotiationPotential = 'low';
      result.negotiationTips.push('Relatively new listing - limited negotiation room');
    } else if (result.daysOnMarket <= 45) {
      result.negotiationPotential = 'medium';
      result.negotiationTips.push('Listed for ' + result.daysOnMarket + ' days - some room for negotiation');
      result.negotiationTips.push('Try offering 5-10% below asking price');
    } else if (result.daysOnMarket <= 90) {
      result.negotiationPotential = 'high';
      result.negotiationTips.push('On market for ' + result.daysOnMarket + ' days - landlord may be eager');
      result.negotiationTips.push('Good chance to negotiate 10-15% off');
      result.negotiationTips.push('Ask why it hasn\'t rented - there may be issues');
    } else {
      result.negotiationPotential = 'very-high';
      result.negotiationTips.push('Listed for ' + result.daysOnMarket + '+ days - significant leverage');
      result.negotiationTips.push('Landlord is likely frustrated - negotiate hard');
      result.negotiationTips.push('Consider offering 15-20% below asking');
      result.negotiationTips.push('Be cautious: ask why it\'s been available so long');
    }

    // Add tip if listing was recently updated
    if (result.wasUpdated && result.dateUpdated !== result.dateAdded) {
      result.negotiationTips.push('Listing was updated - landlord is actively trying to rent');
    }

    // Add tip if price dropped
    if (result.priceDropped) {
      result.negotiationTips.push('Price was already reduced - more drops possible');
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

// ---------- Nearby Places Discovery ----------

async function discoverNearbyPlaces(address) {
  if (!GOOGLE_MAPS_API_KEY || !address) {
    return null;
  }

  try {
    // First geocode the address to get coordinates
    const coords = await geocodeAddress(address);
    if (!coords) {
      console.log('Could not geocode address for nearby places');
      return null;
    }

    const lat = coords.lat;
    const lng = coords.lng;

    // Define all place categories we want to search
    // Organized by lifestyle needs for expats
    const categories = [
      // Daily Essentials
      { type: 'supermarket', label: 'Supermarket', icon: '🛒', radius: 800, category: 'essentials' },
      { type: 'convenience_store', label: 'Convenience Store', icon: '🏪', radius: 500, category: 'essentials' },
      { type: 'pharmacy', label: 'Pharmacy', icon: '💊', radius: 800, category: 'essentials' },
      { type: 'bakery', label: 'Bakery', icon: '🥐', radius: 600, category: 'essentials' },
      
      // Transit & Mobility
      { type: 'subway_station', label: 'Metro', icon: '🚇', radius: 1000, category: 'transit' },
      { type: 'transit_station', label: 'Tram/Bus Stop', icon: '🚋', radius: 500, category: 'transit' },
      { type: 'train_station', label: 'Train Station', icon: '🚆', radius: 2000, category: 'transit' },
      
      // Health & Fitness
      { type: 'gym', label: 'Gym', icon: '🏋️', radius: 1000, category: 'health' },
      { type: 'doctor', label: 'Doctor/Clinic', icon: '👨‍⚕️', radius: 1500, category: 'health' },
      { type: 'hospital', label: 'Hospital', icon: '🏥', radius: 3000, category: 'health' },
      { type: 'dentist', label: 'Dentist', icon: '🦷', radius: 1500, category: 'health' },
      
      // Food & Dining
      { type: 'restaurant', label: 'Restaurant', icon: '🍽️', radius: 600, category: 'dining' },
      { type: 'cafe', label: 'Café', icon: '☕', radius: 500, category: 'dining' },
      { type: 'bar', label: 'Bar/Pub', icon: '🍺', radius: 800, category: 'nightlife' },
      { type: 'night_club', label: 'Nightclub', icon: '🎉', radius: 1500, category: 'nightlife' },
      
      // Recreation & Lifestyle
      { type: 'park', label: 'Park', icon: '🌳', radius: 800, category: 'recreation' },
      { type: 'shopping_mall', label: 'Shopping Mall', icon: '🛍️', radius: 2000, category: 'shopping' },
      { type: 'movie_theater', label: 'Cinema', icon: '🎬', radius: 2000, category: 'entertainment' },
      
      // Family & Kids
      { type: 'school', label: 'School', icon: '🏫', radius: 1000, category: 'family' },
      { type: 'playground', label: 'Playground', icon: '🛝', radius: 600, category: 'family' },
      
      // Services
      { type: 'bank', label: 'Bank', icon: '🏦', radius: 1000, category: 'services' },
      { type: 'atm', label: 'ATM', icon: '💳', radius: 500, category: 'services' },
      { type: 'post_office', label: 'Post Office', icon: '📮', radius: 1500, category: 'services' },
      { type: 'laundry', label: 'Laundry', icon: '🧺', radius: 800, category: 'services' },
      
      // Pets
      { type: 'veterinary_care', label: 'Vet', icon: '🐾', radius: 2000, category: 'pets' },
      { type: 'pet_store', label: 'Pet Store', icon: '🐕', radius: 1500, category: 'pets' },
    ];

    // Search for places in parallel (batch to avoid rate limits)
    const batchSize = 5;
    const results = {};
    
    for (let i = 0; i < categories.length; i += batchSize) {
      const batch = categories.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(function(cat) {
          return searchNearbyPlace(lat, lng, cat.type, cat.radius, cat.label, cat.icon, cat.category);
        })
      );
      
      batchResults.forEach(function(result) {
        if (result) {
          results[result.type] = result;
        }
      });
      
      // Small delay between batches to be nice to the API
      if (i + batchSize < categories.length) {
        await new Promise(function(resolve) { setTimeout(resolve, 100); });
      }
    }

    // Organize results by category for the frontend
    const organized = {
      essentials: [],
      transit: [],
      health: [],
      dining: [],
      nightlife: [],
      recreation: [],
      shopping: [],
      entertainment: [],
      family: [],
      services: [],
      pets: [],
    };

    // Sort results into categories
    Object.values(results).forEach(function(place) {
      if (place && organized[place.category]) {
        organized[place.category].push(place);
      }
    });

    // Sort each category by distance
    Object.keys(organized).forEach(function(cat) {
      organized[cat].sort(function(a, b) {
        return (a.distanceMeters || 9999) - (b.distanceMeters || 9999);
      });
    });

    // Calculate overall walkability score (0-100)
    const walkabilityScore = calculateWalkabilityScore(organized);

    return {
      coordinates: { lat: lat, lng: lng },
      places: organized,
      walkabilityScore: walkabilityScore,
      summary: generateNearbySummary(organized),
    };

  } catch (error) {
    console.error('Nearby places discovery error:', error.message);
    return null;
  }
}

async function searchNearbyPlace(lat, lng, placeType, radius, label, icon, category) {
  try {
    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/place/nearbysearch/json',
      {
        params: {
          location: lat + ',' + lng,
          radius: radius,
          type: placeType,
          key: GOOGLE_MAPS_API_KEY,
        },
        timeout: 5000,
      }
    );

    if (response.data.status === 'OK' && response.data.results && response.data.results.length > 0) {
      // Get the closest one
      const closest = response.data.results[0];
      const placeLat = closest.geometry.location.lat;
      const placeLng = closest.geometry.location.lng;
      
      // Calculate distance
      const distanceKm = haversineDistance(lat, lng, placeLat, placeLng);
      const distanceMeters = Math.round(distanceKm * 1000);
      const walkingMinutes = Math.round(distanceMeters / 80); // ~80m per minute walking
      
      return {
        type: placeType,
        category: category,
        label: label,
        icon: icon,
        name: closest.name,
        distanceMeters: distanceMeters,
        distanceText: distanceMeters < 1000 ? distanceMeters + 'm' : (distanceKm.toFixed(1) + 'km'),
        walkingMinutes: walkingMinutes,
        walkingText: walkingMinutes + ' min walk',
        rating: closest.rating || null,
        totalRatings: closest.user_ratings_total || 0,
        isOpen: closest.opening_hours ? closest.opening_hours.open_now : null,
        vicinity: closest.vicinity || null,
        found: true,
      };
    }
    
    // No results found
    return {
      type: placeType,
      category: category,
      label: label,
      icon: icon,
      name: null,
      found: false,
      distanceMeters: null,
      message: 'None within ' + radius + 'm',
    };

  } catch (error) {
    console.error('Place search error for ' + placeType + ':', error.message);
    return null;
  }
}

function calculateWalkabilityScore(organized) {
  let score = 0;
  let maxScore = 0;

  // Essential services (heavily weighted)
  const essentials = organized.essentials || [];
  maxScore += 25;
  if (essentials.some(function(p) { return p.found && p.distanceMeters < 500; })) score += 25;
  else if (essentials.some(function(p) { return p.found && p.distanceMeters < 800; })) score += 15;
  else if (essentials.some(function(p) { return p.found; })) score += 5;

  // Transit (heavily weighted)
  const transit = organized.transit || [];
  maxScore += 25;
  if (transit.some(function(p) { return p.found && p.type === 'subway_station' && p.distanceMeters < 800; })) score += 25;
  else if (transit.some(function(p) { return p.found && p.distanceMeters < 400; })) score += 20;
  else if (transit.some(function(p) { return p.found && p.distanceMeters < 800; })) score += 10;
  else if (transit.some(function(p) { return p.found; })) score += 5;

  // Health
  const health = organized.health || [];
  maxScore += 15;
  if (health.some(function(p) { return p.found && p.type === 'pharmacy' && p.distanceMeters < 500; })) score += 10;
  if (health.some(function(p) { return p.found && p.type === 'gym' && p.distanceMeters < 1000; })) score += 5;

  // Dining & Lifestyle
  const dining = organized.dining || [];
  maxScore += 15;
  if (dining.filter(function(p) { return p.found && p.distanceMeters < 500; }).length >= 2) score += 15;
  else if (dining.some(function(p) { return p.found && p.distanceMeters < 500; })) score += 8;

  // Recreation
  const recreation = organized.recreation || [];
  maxScore += 10;
  if (recreation.some(function(p) { return p.found && p.type === 'park' && p.distanceMeters < 600; })) score += 10;
  else if (recreation.some(function(p) { return p.found; })) score += 5;

  // Services
  const services = organized.services || [];
  maxScore += 10;
  if (services.some(function(p) { return p.found && p.type === 'atm' && p.distanceMeters < 500; })) score += 5;
  if (services.some(function(p) { return p.found && p.type === 'bank' && p.distanceMeters < 1000; })) score += 5;

  return Math.round((score / maxScore) * 100);
}

function generateNearbySummary(organized) {
  const highlights = [];
  const concerns = [];

  // Check essentials
  const hasGrocery = (organized.essentials || []).some(function(p) { 
    return p.found && p.distanceMeters < 500; 
  });
  if (hasGrocery) highlights.push('Grocery store within 5 min walk');
  else concerns.push('No grocery store within easy walking distance');

  // Check transit
  const hasMetro = (organized.transit || []).some(function(p) { 
    return p.found && p.type === 'subway_station' && p.distanceMeters < 1000; 
  });
  const hasBus = (organized.transit || []).some(function(p) { 
    return p.found && p.type === 'transit_station' && p.distanceMeters < 500; 
  });
  
  if (hasMetro) highlights.push('Metro station nearby');
  if (hasBus) highlights.push('Bus/tram stop within 5 min');
  if (!hasMetro && !hasBus) concerns.push('Limited public transit access');

  // Check park
  const hasPark = (organized.recreation || []).some(function(p) { 
    return p.found && p.type === 'park' && p.distanceMeters < 800; 
  });
  if (hasPark) highlights.push('Park nearby for walks & relaxation');

  // Check nightlife
  const hasNightlife = (organized.nightlife || []).some(function(p) { 
    return p.found && p.distanceMeters < 1000; 
  });
  if (hasNightlife) highlights.push('Bars & nightlife within walking distance');

  // Check pharmacy
  const hasPharmacy = (organized.health || []).some(function(p) { 
    return p.found && p.type === 'pharmacy' && p.distanceMeters < 800; 
  });
  if (!hasPharmacy) concerns.push('Pharmacy not within easy reach');

  // Check gym
  const hasGym = (organized.health || []).some(function(p) { 
    return p.found && p.type === 'gym' && p.distanceMeters < 1000; 
  });
  if (hasGym) highlights.push('Gym accessible nearby');

  return {
    highlights: highlights,
    concerns: concerns,
  };
}

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

async function parseOtodom($, url, baseLocationText, rawHtml) {
  baseLocationText = baseLocationText || '';
  rawHtml = rawHtml || '';
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
  
  // Extract listing intelligence (age, updates, negotiation potential)
  const listingIntel = extractListingIntelligence($, rawHtml);
  
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
  
  // CRITICAL: Never override admin from Otodom structured data
  // Only use hiddenUtilities if Otodom has NO admin value at all
  const trueAdminPLN = adminPLN || null;  // Always trust Otodom's admin value
  
  // Additional fees from description (internet, TV, parking) - informational only
  const additionalFeesTotal = descriptionAnalysis.totalAdditionalFees || 0;
  
  // Total = rent + admin (from Otodom) - DO NOT add description fees to total
  // Description fees are informational only, shown separately
  const trueTotalPLN = rentPLN ? rentPLN + (adminPLN || 0) : null;

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

  // Discover nearby places for the listing location
  let nearbyPlaces = null;
  if (location) {
    nearbyPlaces = await discoverNearbyPlaces(location + ', Poland');
  }

  // Get district vibe information
  const districtVibe = getDistrictVibe(location);

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
    additionalFees: descriptionAnalysis.additionalFees || [],
    additionalFeesTotal: additionalFeesTotal,
    hasMeteredFees: descriptionAnalysis.hasMeteredFees || false,
    meteredFeeTypes: descriptionAnalysis.meteredFeeTypes || [],
    advertiserType: advertiserType,
    rooms: rooms ? Number(rooms) : null,
    area: area,
    areaM2: areaNum,
    availableFrom: availableFrom,
    address: location,
    districtVibe: districtVibe,
    nearbyPlaces: nearbyPlaces,
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
    listingIntel: listingIntel,
    hasTerraceOrBalcony: hasTerraceOrBalcony,
    hasInternet: hasInternet,
    pricePerM2: pricePerM2,
  };

  summary.insights = generateInsights(summary);
  summary.risk = assessRisk(summary, descriptionAnalysis);
  summary.trustBreakdown = generateTrustBreakdown(summary, descriptionAnalysis);

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

// ---------- Trust Score Breakdown ----------

function generateTrustBreakdown(summary, descriptionAnalysis) {
  descriptionAnalysis = descriptionAnalysis || {};
  const checks = [];
  let passedCount = 0;
  let totalCount = 0;
  
  totalCount++;
  const hasClearPricing = summary.rentPLN && summary.adminPLN;
  checks.push({ category: 'pricing', label: 'Clear pricing', passed: hasClearPricing, detail: hasClearPricing ? 'Rent and admin fees clearly stated' : (summary.rentPLN ? 'Admin/utilities not specified' : 'Price information incomplete') });
  if (hasClearPricing) passedCount++;
  
  totalCount++;
  const hasDeposit = summary.depositPLN || descriptionAnalysis.hiddenDeposit;
  checks.push({ category: 'pricing', label: 'Deposit specified', passed: !!hasDeposit, detail: hasDeposit ? 'Deposit amount is known' : 'No deposit information found' });
  if (hasDeposit) passedCount++;
  
  totalCount++;
  const inconsistencies = descriptionAnalysis.inconsistencies || [];
  const hasPriceContradiction = inconsistencies.some(function(i) { return i.type === 'deposit_mismatch'; });
  checks.push({ category: 'consistency', label: 'Prices match', passed: !hasPriceContradiction, detail: !hasPriceContradiction ? 'Listed prices match description' : 'Deposit mismatch between listing and description' });
  if (!hasPriceContradiction) passedCount++;
  
  totalCount++;
  const descLength = (summary.descriptionEN || '').length;
  const hasGoodDescription = descLength >= 200;
  checks.push({ category: 'detail', label: 'Detailed description', passed: hasGoodDescription, detail: hasGoodDescription ? 'Comprehensive listing description' : 'Description is short or vague' });
  if (hasGoodDescription) passedCount++;
  
  totalCount++;
  checks.push({ category: 'detail', label: 'Availability date', passed: !!summary.availableFrom, detail: summary.availableFrom ? 'Move-in date specified' : 'No availability date given' });
  if (summary.availableFrom) passedCount++;
  
  totalCount++;
  const rent = summary.rentPLN;
  const deposit = summary.trueDepositPLN || summary.depositPLN;
  const depositReasonable = !deposit || !rent || deposit <= (2 * rent);
  checks.push({ category: 'pricing', label: 'Reasonable deposit', passed: depositReasonable, detail: depositReasonable ? (deposit ? 'Deposit within normal range' : 'N/A') : 'Deposit exceeds 2x monthly rent' });
  if (depositReasonable) passedCount++;
  
  totalCount++;
  const ppm2 = summary.pricePerM2;
  const ppm2Reasonable = !ppm2 || (ppm2 >= 40 && ppm2 <= 150);
  checks.push({ category: 'pricing', label: 'Price per m² check', passed: ppm2Reasonable, detail: ppm2Reasonable ? (ppm2 ? ppm2 + ' PLN/m² is within typical range' : 'Cannot calculate') : (ppm2 + ' PLN/m² is ' + (ppm2 < 40 ? 'unusually low - verify details' : 'on the higher end')) });
  if (ppm2Reasonable) passedCount++;
  
  if (descriptionAnalysis.registrationAllowed !== null && descriptionAnalysis.registrationAllowed !== undefined) {
    totalCount++;
    checks.push({ category: 'legal', label: 'Registration allowed', passed: descriptionAnalysis.registrationAllowed === true, detail: descriptionAnalysis.registrationAllowed ? 'Zameldowanie possible' : 'No zameldowanie - may affect visa' });
    if (descriptionAnalysis.registrationAllowed) passedCount++;
  }
  
  const trustPercentage = Math.round((passedCount / totalCount) * 100);
  let trustLevel = 'high';
  if (trustPercentage < 50) trustLevel = 'low';
  else if (trustPercentage < 75) trustLevel = 'medium';
  
  return { checks: checks, passed: passedCount, total: totalCount, percentage: trustPercentage, level: trustLevel };
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
    const summary = await parseOtodom($, url, baseLocationText || '', response.data);
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
    const summary = await parseOtodom($, url, baseLocationText, html);
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

// Curated packs, 4 Difficulty Tiers (Easy, Medium, Hardcore, Boss Mode),
// 456-title verified hybrid challenge generator, and live Wikimedia Daily Feed support.
// Every Wikipedia title is verified against the Wikimedia API.
import enPool from './pools/en-pool.json' with { type: 'json' };

export const BANNED_HUBS = new Set([
  'united states',
  'united kingdom',
  'europe',
  'world war ii',
  'world war i',
  'english language',
  'earth',
  'human',
  'india',
  'china',
  'france',
  'germany',
  'japan',
  'geography',
  'history',
  '20th century',
  '21st century'
]);

export const DIFFICULTY_TIERS = {
  easy: {
    id: 'easy',
    name: 'Easy',
    badge: 'mint',
    par: 3,
    tagline: 'Par 3 · Clear bridges · 2 Hints · Previews On',
    rules: {
      previews: true,
      banHubs: false,
      lockInfobox: false,
      maxHints: 2,
      backCost: 1
    }
  },
  medium: {
    id: 'medium',
    name: 'Medium',
    badge: 'periwinkle',
    par: 4,
    tagline: 'Par 4 · Cross-domain jumps · 2 Hints · Previews On',
    rules: {
      previews: true,
      banHubs: false,
      lockInfobox: false,
      maxHints: 2,
      backCost: 1
    }
  },
  hardcore: {
    id: 'hardcore',
    name: 'Hardcore',
    badge: 'marigold',
    par: 5,
    tagline: 'Par 5 · Mega-Hubs Banned · 1 Hint Max',
    rules: {
      previews: true,
      banHubs: true,
      lockInfobox: false,
      maxHints: 1,
      backCost: 1
    }
  },
  boss: {
    id: 'boss',
    name: 'Boss Mode',
    badge: 'coral',
    par: 6,
    tagline: 'Par 6 · Blind (No Previews) · Prose Only (Infobox Locked) · No Hubs · 0 Hints · Back +2',
    rules: {
      previews: false,
      banHubs: true,
      lockInfobox: true,
      maxHints: 0,
      backCost: 2
    }
  }
};

// Cross-domain verified topic buckets for dynamic tiered challenge generation
export const TOPIC_BUCKETS = {
  history: ['Genghis Khan', 'Cleopatra', 'Napoleon', 'Roman Empire', 'French Revolution', 'Achaemenid Empire', 'Samurai', 'Silk Road'],
  scifi_pop: ['C-3PO', 'General Grievous', 'Spider-Man', 'Batman', 'Harry Potter', 'Barbie', 'Shrek', 'Taylor Swift', 'The Beatles'],
  science_space: ['Black hole', 'Quantum mechanics', 'Photosynthesis', 'DNA', 'Periodic table', 'Albert Einstein', 'Marie Curie', 'Nikola Tesla', 'Charles Darwin'],
  food: ['Pizza', 'Coffee', 'Biryani', 'Chocolate', 'Banana', 'Samosa', 'Medieval cuisine'],
  india: ['Virat Kohli', 'Shah Rukh Khan', 'Sachin Tendulkar', 'Chandrayaan-3', 'Vadodara', 'ISRO', 'A. R. Rahman', 'Srinivasa Ramanujan', 'Bengaluru', 'Taj Mahal', 'Mahatma Gandhi'],
  games_anime: ['Minecraft', 'Pikachu', 'Naruto', 'Hayao Miyazaki', 'Pokémon', 'Dragon Ball', 'Super Mario', 'The Legend of Zelda', 'One Piece', 'Chess'],
  myth_world: ['Zeus', 'Odin', 'Ramayana', 'Thor', 'Atlantis', 'Vampire', 'Medusa', 'Anubis', 'Mount Everest', 'Antarctica']
};

// 456 verified English Wikipedia titles across 12 semantic buckets (iconic + deep tiers)
export const POOL_BUCKETS = enPool.buckets || {};

const DISTANT_BUCKET_PAIRS = [
  ['history', 'games_anime'],
  ['history', 'science_tech'],
  ['food_drink', 'space_nature'],
  ['food_drink', 'science_tech'],
  ['india_asia', 'film_tv_pop'],
  ['india_asia', 'space_nature'],
  ['india_asia', 'games_anime'],
  ['sports', 'literature_myth'],
  ['sports', 'science_tech'],
  ['music_art', 'space_nature'],
  ['everyday_inventions', 'literature_myth'],
  ['landmarks_places', 'games_anime'],
  ['film_tv_pop', 'everyday_inventions'],
  ['food_drink', 'literature_myth']
];

let liveTrendingTitles = [];
const liveDailyOverrides = new Map(); // YYYY-MM-DD -> { start, target, par, tier, source }
const recentGeneratedPairs = []; // ring buffer (max 24) to avoid back-to-back repeats

export function setLiveTrendingPool(titles = []) {
  if (!Array.isArray(titles)) return;
  liveTrendingTitles = titles.filter((t) => typeof t === 'string' && t.trim().length >= 3);
}

export function setLiveDailyOverride(dateStr, data) {
  if (!dateStr || !data?.start || !data?.target) return;
  liveDailyOverrides.set(dateStr, {
    start: data.start,
    target: data.target,
    par: data.par || 4,
    tier: data.tier || 'medium',
    source: data.source || 'wikimedia-featured'
  });
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generates a cross-domain challenge tailored to the selected difficulty tier
 * from the 456-title verified pool (+ live Wikimedia trending topics for Easy/Medium).
 * Guarantees Start and Target come from completely different semantic domains.
 */
export function generateTieredChallenge(tierId = 'medium') {
  const tier = DIFFICULTY_TIERS[tierId] || DIFFICULTY_TIERS.medium;
  const bucketKeys = Object.keys(POOL_BUCKETS);

  // Small chance (18%) of picking a hand-crafted pack pair matching this tier
  const curatedPool = PACKS.filter((p) => p.lang === 'en').flatMap((p) =>
    p.pairs.filter((pair) => (pair[3] || 'medium') === tier.id)
  );
  if (curatedPool.length > 0 && Math.random() < 0.18) {
    const [start, target, par] = pickRandom(curatedPool);
    return {
      start,
      target,
      par: par || tier.par,
      lang: 'en',
      tier: tier.id,
      rules: { ...tier.rules }
    };
  }

  for (let attempt = 0; attempt < 12; attempt++) {
    let b1;
    let b2;
    if (tier.id === 'hardcore' || tier.id === 'boss') {
      const pair = pickRandom(DISTANT_BUCKET_PAIRS);
      [b1, b2] = Math.random() < 0.5 ? pair : [pair[1], pair[0]];
    } else {
      b1 = pickRandom(bucketKeys);
      b2 = pickRandom(bucketKeys);
      while (b2 === b1) b2 = pickRandom(bucketKeys);
    }

    const bucket1 = POOL_BUCKETS[b1];
    const bucket2 = POOL_BUCKETS[b2];
    if (!bucket1 || !bucket2) continue;

    let start;
    let target;

    if (tier.id === 'easy') {
      // Easy: iconic -> iconic (with 25% sprinkle of today's live trending Wikipedia topics)
      const useTrending = liveTrendingTitles.length >= 4 && Math.random() < 0.25;
      start = useTrending ? pickRandom(liveTrendingTitles) : pickRandom(bucket1.iconic);
      target = pickRandom(bucket2.iconic);
    } else if (tier.id === 'medium') {
      // Medium: iconic <-> (iconic or deep), with occasional live trending topic
      const useTrending = liveTrendingTitles.length >= 4 && Math.random() < 0.2;
      start = useTrending ? pickRandom(liveTrendingTitles) : pickRandom(bucket1.iconic);
      target = Math.random() < 0.45 ? pickRandom(bucket2.deep) : pickRandom(bucket2.iconic);
    } else if (tier.id === 'hardcore') {
      // Hardcore: iconic <-> deep across distant domains
      const flip = Math.random() < 0.5;
      start = flip ? pickRandom(bucket1.deep) : pickRandom(bucket1.iconic);
      target = flip ? pickRandom(bucket2.iconic) : pickRandom(bucket2.deep);
    } else {
      // Boss Mode: deep -> deep across distant domains
      start = pickRandom(bucket1.deep);
      target = pickRandom(bucket2.deep);
    }

    if (!start || !target || start.toLowerCase() === target.toLowerCase()) continue;
    const sig = `${start.toLowerCase()}|${target.toLowerCase()}`;
    if (recentGeneratedPairs.includes(sig) && attempt < 10) continue;

    recentGeneratedPairs.push(sig);
    if (recentGeneratedPairs.length > 24) recentGeneratedPairs.shift();

    return {
      start,
      target,
      par: tier.par,
      lang: 'en',
      tier: tier.id,
      rules: { ...tier.rules }
    };
  }

  // Ultimate fallback
  return {
    start: 'Genghis Khan',
    target: 'C-3PO',
    par: tier.par,
    lang: 'en',
    tier: tier.id,
    rules: { ...tier.rules }
  };
}

// Each pair is [start, target, par, tierId]
export const PACKS = [
  {
    id: 'pop',
    name: 'Pop Culture',
    subtitle: 'Cinema, icons & internet lore',
    accent: 'marigold',
    lang: 'en',
    icon: 'pop',
    pairs: [
      ['Spider-Man', 'Albert Einstein', 3, 'easy'],
      ['Taylor Swift', 'Roman Empire', 4, 'medium'],
      ['Genghis Khan', 'C-3PO', 4, 'medium'],
      ['Genghis Khan', 'General Grievous', 4, 'medium'],
      ['Pizza', 'Black hole', 4, 'medium'],
      ['Minecraft', 'Napoleon', 4, 'medium'],
      ['Harry Potter', 'Photosynthesis', 5, 'hardcore'],
      ['Pikachu', 'Mount Everest', 5, 'hardcore'],
      ['Batman', 'French Revolution', 5, 'hardcore'],
      ['The Beatles', 'Antarctica', 5, 'hardcore'],
      ['Barbie', 'Quantum mechanics', 6, 'boss'],
      ['Shrek', 'Renaissance', 6, 'boss']
    ]
  },
  {
    id: 'science',
    name: 'Science & History',
    subtitle: 'Discoveries, empires & cosmos',
    accent: 'coral',
    lang: 'en',
    icon: 'science',
    pairs: [
      ['Moon', 'Pizza', 3, 'easy'],
      ['Nikola Tesla', 'Olympic Games', 3, 'easy'],
      ['Black hole', 'Coffee', 4, 'medium'],
      ['DNA', 'Cleopatra', 4, 'medium'],
      ['Roman Empire', 'Banana', 4, 'medium'],
      ['Dinosaur', 'Internet', 4, 'medium'],
      ['Charles Darwin', 'Guitar', 5, 'hardcore'],
      ['Marie Curie', 'Chocolate', 5, 'hardcore'],
      ['Periodic table', 'Samurai', 6, 'boss'],
      ['Silk Road', 'Smartphone', 6, 'boss']
    ]
  },
  {
    id: 'india',
    name: 'India & Culture',
    subtitle: 'Cricket, cinema, science & heritage',
    accent: 'mint',
    lang: 'en',
    icon: 'india',
    pairs: [
      ['Virat Kohli', 'Olympic Games', 3, 'easy'],
      ['A. R. Rahman', 'Academy Awards', 3, 'easy'],
      ['Srinivasa Ramanujan', 'Albert Einstein', 3, 'easy'],
      ['ISRO', 'Cleopatra', 4, 'medium'],
      ['Shah Rukh Khan', 'Eiffel Tower', 4, 'medium'],
      ['Sachin Tendulkar', 'Mount Everest', 4, 'medium'],
      ['Chandrayaan-3', 'Ancient Greece', 4, 'medium'],
      ['Bengaluru', 'Quantum mechanics', 5, 'hardcore'],
      ['Biryani', 'Achaemenid Empire', 5, 'hardcore'],
      ['Vadodara', 'General Grievous', 6, 'boss'],
      ['Samosa', 'Black hole', 6, 'boss']
    ]
  },
  {
    id: 'anime',
    name: 'Anime & Games',
    subtitle: 'Bosses, studios & worlds',
    accent: 'periwinkle',
    lang: 'en',
    icon: 'anime',
    pairs: [
      ['Pokémon', 'Mount Everest', 3, 'easy'],
      ['Chess', 'Artificial intelligence', 3, 'easy'],
      ['Dragon Ball', 'Buddhism', 4, 'medium'],
      ['One Piece', 'Piracy', 4, 'medium'],
      ['Naruto', 'Hiroshima', 4, 'medium'],
      ['Hayao Miyazaki', 'French Revolution', 5, 'hardcore'],
      ['Super Mario', 'Leonardo da Vinci', 5, 'hardcore'],
      ['The Legend of Zelda', 'Medieval cuisine', 6, 'boss']
    ]
  },
  {
    id: 'myth',
    name: 'Mythology',
    subtitle: 'Gods, epics & folklore',
    accent: 'lilac',
    lang: 'en',
    icon: 'myth',
    pairs: [
      ['Zeus', 'Marvel Comics', 3, 'easy'],
      ['Odin', 'Wednesday', 3, 'easy'],
      ['Ramayana', 'Indonesia', 4, 'medium'],
      ['Atlantis', 'Plato', 4, 'medium'],
      ['Vampire', 'Romania', 4, 'medium'],
      ['Medusa', 'Versace', 5, 'hardcore'],
      ['Thor', 'Electricity', 5, 'hardcore'],
      ['Anubis', 'Quantum mechanics', 6, 'boss']
    ]
  },
  {
    id: 'hi',
    name: 'हिन्दी विकिपीडिया',
    subtitle: 'Play in Hindi Wikipedia',
    accent: 'marigold',
    lang: 'hi',
    icon: 'hi',
    pairs: [
      ['क्रिकेट', 'चन्द्रमा', 4, 'medium'],
      ['महात्मा गांधी', 'समोसा', 5, 'hardcore'],
      ['ताजमहल', 'अल्बर्ट आइंस्टीन', 5, 'hardcore'],
      ['भारत', 'मंगल ग्रह', 4, 'medium']
    ]
  },
  {
    id: 'gu',
    name: 'ગુજરાતી વિકિપીડિયા',
    subtitle: 'Play in Gujarati Wikipedia',
    accent: 'mint',
    lang: 'gu',
    icon: 'gu',
    pairs: [
      ['મહાત્મા ગાંધી', 'ચંદ્ર', 4, 'medium'],
      ['ક્રિકેટ', 'અમદાવાદ', 3, 'easy'],
      ['ભારત', 'સૂર્યમંડળ', 4, 'medium'],
      ['વડોદરા', 'મુંબઈ', 3, 'easy']
    ]
  }
];

// Fixed Epoch so Daily #1 is stable forever and archive dates never shift.
const EPOCH_UTC_MS = Date.UTC(2026, 6, 2, 0, 0, 0); // 2026-11-20 -> Day #142

// Fixed ordered Daily list (English, curated high-fun cross-domain pairs).
export const DAILY_POOL = [
  ['Genghis Khan', 'C-3PO', 4, 'medium'],
  ['Pizza', 'Black hole', 4, 'medium'],
  ['Minecraft', 'Napoleon', 4, 'medium'],
  ['Harry Potter', 'Photosynthesis', 5, 'hardcore'],
  ['ISRO', 'Cleopatra', 4, 'medium'],
  ['Black hole', 'Coffee', 4, 'medium'],
  ['Taylor Swift', 'Roman Empire', 4, 'medium'],
  ['DNA', 'Cleopatra', 4, 'medium'],
  ['Barbie', 'Quantum mechanics', 6, 'boss'],
  ['Spider-Man', 'Albert Einstein', 3, 'easy'],
  ['Roman Empire', 'Banana', 4, 'medium'],
  ['Chandrayaan-3', 'Ancient Greece', 4, 'medium'],
  ['Batman', 'French Revolution', 5, 'hardcore'],
  ['Marie Curie', 'Chocolate', 5, 'hardcore'],
  ['Zeus', 'Marvel Comics', 3, 'easy'],
  ['Shrek', 'Renaissance', 6, 'boss'],
  ['Periodic table', 'Samurai', 6, 'boss'],
  ['The Beatles', 'Antarctica', 5, 'hardcore'],
  ['Dinosaur', 'Internet', 4, 'medium'],
  ['Odin', 'Wednesday', 3, 'easy'],
  ['Super Mario', 'Leonardo da Vinci', 5, 'hardcore'],
  ['Nikola Tesla', 'Olympic Games', 3, 'easy'],
  ['Pikachu', 'Mount Everest', 5, 'hardcore'],
  ['Charles Darwin', 'Guitar', 5, 'hardcore'],
  ['Silk Road', 'Smartphone', 6, 'boss'],
  ['Naruto', 'Hiroshima', 4, 'medium'],
  ['Ramayana', 'Indonesia', 4, 'medium'],
  ['Moon', 'Pizza', 3, 'easy'],
  ['Vadodara', 'General Grievous', 6, 'boss'],
  ['Genghis Khan', 'General Grievous', 4, 'medium'],
  ['Medusa', 'Versace', 5, 'hardcore'],
  ['Biryani', 'Achaemenid Empire', 5, 'hardcore'],
  ['Dragon Ball', 'Buddhism', 4, 'medium'],
  ['Thor', 'Electricity', 5, 'hardcore'],
  ['Shah Rukh Khan', 'Eiffel Tower', 4, 'medium'],
  ['The Legend of Zelda', 'Medieval cuisine', 6, 'boss']
];

export function formatUtcDate(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getDayNumberForDate(utcDateStr) {
  const [y, m, d] = utcDateStr.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d, 0, 0, 0);
  return Math.floor((ms - EPOCH_UTC_MS) / 86400000) + 1;
}

export function getDailyForDate(utcDateStr = formatUtcDate()) {
  const dayNum = getDayNumberForDate(utcDateStr);
  const live = liveDailyOverrides.get(utcDateStr);
  if (live) {
    return {
      date: utcDateStr,
      dayNum: Math.max(1, dayNum),
      start: live.start,
      target: live.target,
      par: live.par,
      tier: live.tier,
      lang: 'en',
      source: live.source,
      pairKey: makePairKey(live.start, live.target, 'en')
    };
  }
  const offset = dayNum - 142;
  const idx = ((offset % DAILY_POOL.length) + DAILY_POOL.length) % DAILY_POOL.length;
  const [start, target, par, tier = 'medium'] = DAILY_POOL[idx];
  return {
    date: utcDateStr,
    dayNum: Math.max(1, dayNum),
    start,
    target,
    par,
    tier,
    lang: 'en',
    source: 'curated',
    pairKey: makePairKey(start, target, 'en')
  };
}

export function getRecentDays(count = 7) {
  const now = new Date();
  const days = [];
  for (let i = 0; i < count; i++) {
    const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const dateStr = formatUtcDate(dt);
    const label =
      i === 0
        ? 'Today'
        : dt.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
    days.push({
      ...getDailyForDate(dateStr),
      label,
      isToday: i === 0
    });
  }
  return days;
}

export function makePairKey(start, target, lang = 'en') {
  return `${start.trim()}|${target.trim()}|${lang}`;
}

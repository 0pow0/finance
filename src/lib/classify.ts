// Spending category guesses for bank transactions. Runs entirely on the phone.
//
// In order:
//   1. Your own past choices for the same store (exact name, then the store's brand word).
//   2. A dictionary of well-known merchants (Weee!, H Mart, Costco, Shell, ...).
//   3. Generic keywords ("grocery", "pizza", "parking", ...).
//   4. Other.
// Choosing "Other" yourself is not learned: it's the fallback, not a real choice.

import type { Ledger, Transaction } from './ledger';

export const FALLBACK = 'Expenses:Misc';

/** Lowercase words only: "TST* WEEE! INC #12 SAN JOSE CA" -> "tst weee inc 12 san jose ca". */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Compile phrases into one word-boundary regex over normalized text.
 * A trailing "*" matches any word ending ("mcdonald*" matches "mcdonalds").
 */
function phrases(list: string[]): RegExp {
  const parts = list.map((p) => {
    const star = p.endsWith('*');
    const words = normalize(star ? p.slice(0, -1) : p).split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return words.join(' ') + (star ? '[a-z0-9]*' : '');
  });
  return new RegExp(`(?:^| )(?:${parts.join('|')})(?= |$)`);
}

const G = 'Expenses:Food:Groceries';
const D = 'Expenses:Food:Dining';
const C = 'Expenses:Food:Coffee';
const GAS = 'Expenses:Transport:Gas';
const PARK = 'Expenses:Transport:Parking-Tolls';
const RIDE = 'Expenses:Transport:Rideshare';
const UTIL = 'Expenses:Home:Utilities';
const HOME = 'Expenses:Home:Supplies';
const SHOP = 'Expenses:Shopping:General';
const CLOTH = 'Expenses:Shopping:Clothing';
const HEALTH = 'Expenses:Health';
const FUN = 'Expenses:Entertainment';
const SUBS = 'Expenses:Subscriptions';
const TRAVEL = 'Expenses:Travel';
const CARE = 'Expenses:Personal-Care';
const FEES = 'Expenses:Fees-Interest';
const GIFTS = 'Expenses:Gifts';

/** Well-known merchants. First match wins, so specific entries come before broad ones. */
const MERCHANTS: Array<[RegExp, string]> = [
  // Specific overrides first.
  [phrases(['costco gas', 'sams club gas', 'safeway fuel', 'kroger fuel', 'fred meyer fuel', 'arco ampm', 'ampm']), GAS],
  [phrases(['uber eats', 'ubereats', 'doordash', 'dd doordash', 'grubhub', 'postmates', 'seamless', 'caviar', 'chowbus', 'hungrypanda', 'hungry panda', 'fantuan', 'ezcater',
    '85c', '85 c bakery', '85 degrees', 'paris baguette', 'tous les jours']), D],
  [phrases(['amazon fresh', 'amzn fresh', 'whole foods', 'wholefds', 'wfm']), G],
  [phrases(['apple com bill', 'itunes com bill', 'google storage', 'google one', 'youtube premium', 'youtubepremium', 'amazon prime', 'prime video', 'amzn prime', 'kindle unltd', 'audible']), SUBS],
  [phrases(['metropcs', 'metro pcs', 'metro by t mobile']), UTIL],
  [phrases(['delta dental', 'united healthcare', 'unitedhealthcare', 'kaiser', 'sutter health', 'stanford health', 'one medical', 'labcorp', 'quest diagnostics']), HEALTH],
  [phrases(['interest charge*', 'purchase interest', 'annual fee', 'annual membership fee', 'late fee', 'foreign transaction fee', 'returned payment fee', 'cash advance fee']), FEES],

  // Groceries, including Asian and international markets.
  [phrases([
    'weee', 'sayweee', 'sayweee com', 'h mart', 'hmart', '99 ranch', 'ranch 99', 'tawa', 'mitsuwa', 'marukai', 'tokyo central', 'nijiya',
    'uwajimaya', 'seafood city', 'island pacific', 'lotte plaza', 'zion market', 'galleria market', 'patel brothers', 'patel bros',
    'apna bazar', 'india cash and carry', 'great wall supermarket', 'hong kong supermarket', 'jons', 'h e b', 'heb', 'yamibuy', 'hmart com',
    'mekong', 'shun fat', 'sf supermarket', 'marina foods', 'nob hill', 'lucky supermarket*', 'lucky store*', 'raleys', 'bel air',
    'foodmaxx', 'save mart', 'grocery outlet', 'smart and final', 'winco', 'food 4 less', 'stater bros', 'gelsons', 'bristol farms',
    'erewhon', 'mollie stone*', 'draegers', 'berkeley bowl', 'rainbow grocery', 'trader joe*', 'safeway', 'kroger', 'ralphs', 'vons',
    'albertsons', 'pavilions', 'fred meyer', 'qfc', 'king soopers', 'smiths', 'frys food', 'harris teeter', 'food lion', 'giant eagle',
    'giant food', 'stop and shop', 'shoprite', 'wegmans', 'publix', 'meijer', 'hy vee', 'hyvee', 'aldi', 'lidl', 'sprouts', 'costco',
    'costco whse', 'sams club', 'bjs wholesale', 'instacart', 'shipt', 'thrive market', 'misfits market', 'imperfect foods', 'hellofresh',
    'blue apron', 'freshdirect', 'gopuff', 'grocery*', 'supermarket*', 'super market', 'food market', 'asian market', 'farmers market',
    'fish market', 'meat market', 'seafood market', 'produce', 'carniceria', 'mercado',
  ]), G],

  // Coffee, tea and boba.
  [phrases([
    'starbucks', 'dunkin*', 'peets', 'peet s', 'blue bottle', 'philz', 'dutch bros', 'tim hortons', 'coffee bean', 'verve', 'ritual coffee',
    'sightglass', 'intelligentsia', 'la colombe', 'coffee*', 'cafe', 'caffe', 'espresso', 'boba', 'bubble tea', 'kung fu tea', 'gong cha',
    'sharetea', 'tiger sugar', 'chatime', 'happy lemon', 'tastea', 'boba guys', '7 leaves', 'yi fang', 'molly tea', 'heytea', 'chagee',
    'tp tea', 'teaspoon', 'quickly', 'tea station', 'one zo', 'xing fu tang', 'machi machi', 'presotea', 'tea', 'teas', 'teahouse', 'tea house',
  ]), C],

  // Restaurants and fast food.
  [phrases([
    'mcdonald*', 'burger king', 'wendys', 'in n out', 'five guys', 'shake shack', 'chick fil a', 'chickfila', 'taco bell', 'chipotle',
    'subway', 'jersey mikes', 'jimmy johns', 'panera', 'panda express', 'popeyes', 'kfc', 'wingstop', 'raising canes', 'jack in the box',
    'carls jr', 'sonic drive', 'dominos', 'pizza hut', 'papa johns', 'little caesars', 'mod pizza', 'blaze pizza', 'round table',
    'olive garden', 'cheesecake factory', 'applebees', 'chilis', 'ihop', 'dennys', 'red robin', 'buffalo wild', 'pf changs', 'benihana',
    'din tai fung', 'haidilao', 'hai di lao', 'kura sushi', 'kura revolving', 'sweetgreen', 'cava', 'noodles and co', 'qdoba',
    'el pollo loco', 'habit burger', 'portillos', 'potbelly', 'dairy queen', 'baskin*', 'cold stone', 'krispy kreme',
    '85c', '85 c bakery', '85 degrees', 'paris baguette', 'tous les jours', 'sees candies', 'nothing bundt', 'crumbl', 'insomnia cookies',
    'restaurant*', 'restaurante', 'ristorante', 'pizza*', 'pizzeria', 'burger*', 'taqueria', 'tacos', 'taco', 'sushi', 'ramen', 'pho',
    'noodle*', 'dumpling*', 'dim sum', 'hot pot', 'hotpot', 'bbq', 'barbecue', 'grill', 'bistro', 'diner', 'kitchen', 'eatery', 'cantina',
    'steakhouse', 'brewing', 'brewery', 'pub', 'tavern', 'bar and grill', 'wings', 'bakery', 'patisserie', 'creamery', 'gelato',
    'ice cream', 'donut*', 'doughnut*', 'bagel*', 'deli', 'thai', 'curry', 'kabob', 'kebab', 'shawarma', 'poke', 'izakaya', 'yakitori',
    'teriyaki', 'tst',
  ]), D],

  // Gas and EV charging.
  [phrases([
    'shell', 'chevron', 'exxon*', 'mobil', 'bp', 'arco', 'valero', '76 gas', 'phillips 66', 'conoco', 'sunoco', 'speedway', 'wawa',
    'sheetz', 'circle k', 'marathon petro*', 'citgo', 'texaco', 'sinclair', 'quiktrip', 'racetrac', 'loves travel', 'pilot travel',
    'flying j', 'kum and go', 'caseys', 'gas station', 'fuel*', 'petrol*', 'gasoline', 'tesla supercharger', 'chargepoint', 'electrify america',
    'evgo', 'blink charging',
  ]), GAS],

  // Parking, tolls, car.
  [phrases([
    'parking', 'park mobile', 'parkmobile', 'paybyphone', 'spothero', 'laz parking', 'sp plus', 'impark', 'ace parking', 'toll*',
    'fastrak', 'ez pass', 'ezpass', 'e zpass', 'sunpass', 'txtag', 'peach pass', 'bay area toll', 'golden gate bridge', 'dmv', 'car wash',
    'jiffy lube', 'valvoline', 'midas', 'firestone', 'discount tire', 'pep boys', 'autozone', 'oreilly auto', 'napa auto',
  ]), PARK],

  // Rideshare, transit, scooters.
  [phrases([
    'uber', 'lyft', 'waymo', 'clipper', 'bart', 'caltrain', 'muni', 'sfmta', 'vta', 'ac transit', 'metro', 'mta', 'nyct',
    'njt', 'nj transit', 'septa', 'mbta', 'wmata', 'amtrak', 'greyhound', 'lime', 'bird app', 'citi bike', 'bay wheels', 'transit',
  ]), RIDE],

  // Streaming, apps and memberships.
  [phrases([
    'netflix', 'spotify', 'hulu', 'disney plus', 'disneyplus', 'hbo max', 'max com', 'paramount', 'peacock', 'youtube tv', 'sling',
    'apple music', 'icloud', 'dropbox', 'microsoft 365', 'msft', 'adobe', 'chatgpt', 'openai', 'claude ai', 'anthropic', 'patreon',
    'nytimes', 'new york times', 'wsj', 'washington post', 'medium com', 'substack', 'duolingo', 'headspace', 'calm com', 'peloton',
    'classpass', 'planet fitness', '24 hour fitness', 'la fitness', 'equinox', 'crunch fitness', 'orangetheory', 'gym', 'fitness',
    'subscription', 'membership', 'siriusxm', 'nintendo online', 'playstation plus', 'xbox game pass', 'crunchyroll', 'tencent video',
    'iqiyi', 'bilibili',
  ]), SUBS],

  // Utilities, phone and internet.
  [phrases([
    'pg and e', 'pge', 'pgande', 'pacific gas', 'socalgas', 'so cal gas', 'socal edison', 'sdge', 'con ed', 'coned', 'duke energy',
    'dominion energy', 'national grid', 'eversource', 'xcel energy', 'electric*', 'water', 'water district', 'water dept', 'sewer', 'trash', 'recology',
    'waste management', 'republic services', 'comcast', 'xfinity', 'verizon', 'at and t', 'att', 't mobile', 'tmobile', 'mint mobile',
    'visible', 'google fi', 'cricket', 'spectrum', 'cox comm*', 'sonic net', 'frontier comm*', 'starlink', 'internet', 'utility', 'utilities',
  ]), UTIL],

  // Health and pharmacy.
  [phrases([
    'cvs', 'walgreens', 'rite aid', 'pharmacy', 'pharm', 'dental', 'dentist', 'orthodont*', 'doctor', 'medical', 'clinic', 'hospital',
    'urgent care', 'health', 'optometr*', 'vision', 'eye care', 'lenscrafters', 'warby parker', 'physical therapy', 'chiropract*',
    'pediatric*', 'dermatolog*', 'goodrx', 'hims', 'vet', 'veterinary', 'animal hospital', 'banfield', 'vca',
  ]), HEALTH],

  // Household and home improvement.
  [phrases([
    'home depot', 'lowes', 'ikea', 'ace hardware', 'true value', 'orchard supply', 'menards', 'harbor freight', 'bed bath', 'container store',
    'wayfair', 'crate and barrel', 'williams sonoma', 'pottery barn', 'west elm', 'cb2', 'homegoods', 'home goods', 'pier 1', 'daiso',
    'muji', 'hardware', 'nursery', 'garden center', 'petco', 'petsmart', 'chewy', 'pet food', 'cleaners', 'dry clean*', 'laundromat', 'laundry',
    'storage', 'public storage', 'u haul', 'uhaul', 'locksmith',
  ]), HOME],

  // Clothing.
  [phrases([
    'nordstrom*', 'macys', 'gap', 'old navy', 'banana republic', 'uniqlo', 'zara', 'h and m', 'hm com', 'nike', 'adidas', 'lululemon',
    'athleta', 'tj maxx', 'tjmaxx', 'marshalls', 'ross stores', 'ross dress', 'burlington', 'kohls', 'jcpenney', 'forever 21', 'shein',
    'abercrombie', 'hollister', 'american eagle', 'aerie', 'j crew', 'madewell', 'everlane', 'patagonia', 'north face', 'rei', 'columbia',
    'foot locker', 'famous footwear', 'dsw', 'skechers', 'vans', 'converse', 'new balance', 'allbirds', 'coach', 'michael kors', 'kate spade',
    'levis', 'carters', 'childrens place', 'gymboree', 'janie and jack',
  ]), CLOTH],

  // Personal care.
  [phrases([
    'sephora', 'ulta', 'salon', 'barber*', 'hair', 'nails', 'nail spa', 'spa', 'massage', 'waxing', 'european wax', 'cosmetic*',
    'beauty', 'bath and body', 'lush', 'sally beauty',
  ]), CARE],

  // Travel.
  [phrases([
    'airline*', 'airways', 'united airlines', 'united', 'delta air*', 'delta', 'american air*', 'aa com', 'southwest', 'jetblue',
    'alaska air*', 'spirit air*', 'frontier air*', 'hawaiian air*', 'air canada', 'eva air', 'china airlines', 'cathay',
    'korean air', 'singapore air*', 'hotel*', 'motel', 'resort', 'marriott', 'hilton', 'hyatt', 'ihg', 'holiday inn', 'sheraton',
    'westin', 'airbnb', 'vrbo', 'expedia', 'booking com', 'hotels com', 'priceline', 'agoda', 'trip com', 'kayak', 'hertz', 'avis',
    'enterprise rent*', 'budget rent*', 'national car', 'alamo', 'sixt', 'turo', 'tsa precheck', 'global entry', 'clear me', 'airport',
  ]), TRAVEL],

  // Entertainment.
  [phrases([
    'amc', 'regal', 'cinemark', 'cinema*', 'movie*', 'theater', 'theatre', 'fandango', 'ticketmaster', 'stubhub', 'seatgeek', 'eventbrite',
    'live nation', 'disneyland', 'disney world', 'universal studios', 'six flags', 'museum', 'zoo', 'aquarium', 'bowling', 'golf',
    'steam', 'steamgames', 'playstation', 'xbox', 'nintendo', 'epic games', 'roblox', 'twitch', 'concert', 'karaoke', 'arcade',
  ]), FUN],

  // Gifts and giving.
  [phrases(['gofundme', 'donation', 'donate', 'charity', 'red cross', 'unicef', 'wikimedia', 'florist', 'flowers', '1 800 flowers', 'ftd', 'hallmark', 'gift card*']), GIFTS],

  // General shopping last, since these names are broad.
  [phrases([
    'amazon', 'amzn', 'amazon mktp*', 'amazon com', 'target', 'walmart', 'wal mart', 'wm supercenter', 'best buy', 'apple store', 'apple com',
    'ebay', 'etsy', 'temu', 'aliexpress', 'wish com', 'costco com', 'dollar tree', 'dollar general', 'five below', 'big lots', 'tuesday morning',
    'michaels', 'joann', 'hobby lobby', 'staples', 'office depot', 'barnes and noble', 'books', 'bookstore', 'paypal', 'shopify', 'walmart com',
    'target com', 'micro center', 'b and h photo', 'newegg', 'gamestop', 'toys r us', 'lego', 'usps', 'ups store', 'fedex', 'post office',
  ]), SHOP],
];

/** Fallback keywords for stores not in the dictionary. */
const KEYWORDS: Array<[RegExp, string]> = [
  [phrases(['market', 'mart', 'foods', 'food center', 'produce', 'butcher', 'tofu', 'bakery cafe']), G],
  [phrases(['cafe*', 'tea', 'roaster*']), C],
  [phrases(['bar', 'house', 'garden restaurant', 'house of', 'wok', 'palace', 'cuisine', 'kitchen*', 'grill*', 'eats']), D],
];

/** Words too generic to identify a store on their own. */
const GENERIC = new Set([
  'the', 'sq', 'tst', 'py', 'sp', 'dd', 'pp', 'paypal', 'apl', 'pos', 'debit', 'purchase', 'card', 'online', 'store', 'shop', 'market',
  'cafe', 'restaurant', 'kitchen', 'grill', 'coffee', 'tea', 'golden', 'new', 'big', 'little', 'happy', 'lucky', 'great',
  'super', 'royal', 'best', 'first', 'city', 'house', 'san', 'los', 'las', 'el', 'la', 'le', 'de', 'and', 'of', 'bay', 'north', 'south',
  'east', 'west', 'american', 'united', 'national', 'pacific', 'amazon', 'google', 'apple', 'uber',
]);

/** The words that identify a store: "Weee! Inc" -> ["weee", "inc"]. */
function storeWords(payee: string): string[] {
  return normalize(payee).split(' ').filter((w) => w.length >= 2 && !/^\d+$/.test(w));
}

export function payeeKey(p: string): string {
  return storeWords(p).slice(0, 3).join(' ');
}

/** The first distinctive word of a store name, if it has one: "Weee! Inc" -> "weee". */
function brandWord(payee: string): string | undefined {
  const w = storeWords(payee).find((x) => !GENERIC.has(x));
  return w && w.length >= 4 ? w : undefined;
}

const expenseOf = (t: Transaction) => t.postings.find((p) => p.account.startsWith('Expenses:'))?.account;

/** What you've chosen before for this store, from reviewed transactions. */
export interface History {
  byKey: Map<string, { account: string; date: string }>;
  byBrand: Map<string, Set<string>>;
}

export function learnHistory(ledger: Ledger): History {
  const byKey = new Map<string, { account: string; date: string }>();
  const byBrand = new Map<string, Set<string>>();
  for (const t of ledger.transactions) {
    if (t.flag !== '*') continue;
    const account = expenseOf(t);
    if (!account || account === FALLBACK) continue;
    const key = payeeKey(t.payee);
    if (key) {
      const prev = byKey.get(key);
      if (!prev || t.date >= prev.date) byKey.set(key, { account, date: t.date });
    }
    const brand = brandWord(t.payee);
    if (brand) {
      if (!byBrand.has(brand)) byBrand.set(brand, new Set());
      byBrand.get(brand)!.add(account);
    }
  }
  return { byKey, byBrand };
}

/** Category from the merchant dictionary and keywords alone (no history). */
export function dictionaryCategory(payee: string, raw: string): string | undefined {
  const texts = [normalize(payee), normalize(raw)].filter(Boolean);
  for (const [re, account] of MERCHANTS) if (texts.some((t) => re.test(t))) return account;
  for (const [re, account] of KEYWORDS) if (texts.some((t) => re.test(t))) return account;
  return undefined;
}

/** Best category guess for a bank transaction. */
export function classify(ledger: Ledger, payee: string, raw: string, history: History = learnHistory(ledger)): string {
  const usable = (a: string | undefined): a is string => !!a && ledger.accounts.some((x) => x.name === a && !x.closed);
  const exact = history.byKey.get(payeeKey(payee))?.account;
  if (usable(exact)) return exact;
  const brand = brandWord(payee);
  const fromBrand = brand ? history.byBrand.get(brand) : undefined;
  if (fromBrand?.size === 1) {
    const [only] = fromBrand;
    if (usable(only)) return only;
  }
  const guess = dictionaryCategory(payee, raw);
  if (usable(guess)) return guess;
  return FALLBACK;
}

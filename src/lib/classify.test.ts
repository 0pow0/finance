import { describe, expect, it } from 'vitest';
import { classify } from './classify';
import { applyCategoryToSimilar, applyImport, cleanPayee, recategorize, type ImportPayload } from './importer';
import { approveTransactions, newLedger } from './ledger';

const L = newLedger('2026-10-01');
const guess = (raw: string) => classify(L, cleanPayee(raw), raw);

describe('classify', () => {
  const cases: Array<[string, string]> = [
    ['WEEE! INC', 'Expenses:Food:Groceries'],
    ['SAYWEEE.COM 510-555-1234 CA', 'Expenses:Food:Groceries'],
    ['H MART SAN JOSE', 'Expenses:Food:Groceries'],
    ['99 RANCH #1776 CUPERTINO CA', 'Expenses:Food:Groceries'],
    ['MITSUWA MARKETPLACE SAN JOSE CA', 'Expenses:Food:Groceries'],
    ['COSTCO WHSE #0423 SUNNYVALE CA', 'Expenses:Food:Groceries'],
    ['COSTCO GAS #0423 SUNNYVALE CA', 'Expenses:Transport:Gas'],
    ['AMAZON FRESH*AB12C', 'Expenses:Food:Groceries'],
    ['AMZN Mktp US*2K4PL0', 'Expenses:Shopping:General'],
    ['Amazon Prime*1A2B3', 'Expenses:Subscriptions'],
    ['UBER *EATS PENDING', 'Expenses:Food:Dining'],
    ['UBER *TRIP HELP.UBER.COM', 'Expenses:Transport:Rideshare'],
    ['DD *DOORDASH KUNGFUTEA', 'Expenses:Food:Dining'],
    ['KUNG FU TEA SAN JOSE CA', 'Expenses:Food:Coffee'],
    ['TST* TPUMPS SAN MATEO', 'Expenses:Food:Dining'],
    ['SQ *SIGHTGLASS COFFEE', 'Expenses:Food:Coffee'],
    ['DIN TAI FUNG SANTA CLARA', 'Expenses:Food:Dining'],
    ['HAIDILAO HOT POT CUPERTINO', 'Expenses:Food:Dining'],
    ['PHO HOA RESTAURANT', 'Expenses:Food:Dining'],
    ['85C BAKERY CAFE', 'Expenses:Food:Dining'],
    ['CHEVRON 0091234', 'Expenses:Transport:Gas'],
    ['FASTRAK CSC', 'Expenses:Transport:Parking-Tolls'],
    ['CLIPPER SYSTEMS', 'Expenses:Transport:Rideshare'],
    ['PGANDE WEB ONLINE', 'Expenses:Home:Utilities'],
    ['PG&E/EZ-PAY', 'Expenses:Home:Utilities'],
    ['COMCAST CALIFORNIA', 'Expenses:Home:Utilities'],
    ['NETFLIX.COM', 'Expenses:Subscriptions'],
    ['APPLE.COM/BILL', 'Expenses:Subscriptions'],
    ['CVS/PHARMACY #09876', 'Expenses:Health'],
    ['DELTA DENTAL OF CA', 'Expenses:Health'],
    ['DELTA AIR LINES ATLANTA', 'Expenses:Travel'],
    ['UNITED 0162345678901', 'Expenses:Travel'],
    ['MARRIOTT SAN FRANCISCO', 'Expenses:Travel'],
    ['THE HOME DEPOT #1234', 'Expenses:Home:Supplies'],
    ['IKEA EAST PALO ALTO', 'Expenses:Home:Supplies'],
    ['DAISO SAN JOSE', 'Expenses:Home:Supplies'],
    ['UNIQLO USA LLC', 'Expenses:Shopping:Clothing'],
    ['TJ MAXX #123', 'Expenses:Shopping:Clothing'],
    ['SEPHORA.COM', 'Expenses:Personal-Care'],
    ['AMC 1234 ONLINE', 'Expenses:Entertainment'],
    ['TARGET 00012345', 'Expenses:Shopping:General'],
    ['PURCHASE INTEREST CHARGE', 'Expenses:Fees-Interest'],
    ['MYSTERY SHOP LLC', 'Expenses:Misc'],
  ];
  for (const [raw, want] of cases) it(raw, () => expect(guess(raw)).toBe(want));

  it('does not match words inside other words', () => {
    expect(guess('BARNES AND NOBLE')).toBe('Expenses:Shopping:General');
    expect(guess('STEAMBOAT RESORT')).toBe('Expenses:Travel');
  });
});

const unix = (d: string) => Date.parse(`${d}T18:00:00Z`) / 1000;
const payload = (txns: ImportPayload['transactions'], fetchedAt = '2026-10-08T11:00:00Z'): ImportPayload => ({
  v: 1, fetchedAt, accounts: [{ id: 'c', name: 'Sapphire', org: 'Chase Bank', currency: 'USD' }], transactions: txns,
});
const cat = (t: { postings: Array<{ account: string }> }) => t.postings.find((p) => p.account.startsWith('Expenses:'))!.account;

describe('learning from your choices', () => {
  it('uses your category for the same store, even with a different suffix', () => {
    let { ledger } = applyImport(L, payload([{ id: '1', account: 'c', posted: unix('2026-10-02'), amount: '-20', description: 'GOLDEN DRAGON SUSHI BAR' }]));
    const t = ledger.transactions[0];
    expect(cat(t)).toBe('Expenses:Food:Dining');
    // You decide it's takeout for home: treat as groceries.
    const edited = { ...t, flag: '*' as const, postings: t.postings.map((p) => (p.account.startsWith('Expenses:') ? { ...p, account: 'Expenses:Food:Groceries' } : p)) };
    ledger = { ...ledger, transactions: [edited] };
    ledger = applyImport(ledger, payload([{ id: '2', account: 'c', posted: unix('2026-10-05'), amount: '-30', description: 'GOLDEN DRAGON SUSHI BAR #2' }])).ledger;
    expect(cat(ledger.transactions.find((x) => x.externalId === 'simplefin:c:2')!)).toBe('Expenses:Food:Groceries');
  });

  it('choosing Other is not learned, and reviewed purchases left in Other get a better guess', () => {
    let { ledger } = applyImport(L, payload([{ id: '1', account: 'c', posted: unix('2026-10-02'), amount: '-20', description: 'WEEE INC' }]));
    // Simulate an old guess of Other that was approved.
    ledger = approveTransactions({ ...ledger, transactions: ledger.transactions.map((t) => ({ ...t, postings: t.postings.map((p) => (p.account.startsWith('Expenses:') ? { ...p, account: 'Expenses:Misc' } : p)) })) });
    const fixed = recategorize(ledger);
    expect(cat(fixed.transactions[0])).toBe('Expenses:Food:Groceries');
    expect(fixed.transactions[0].flag).toBe('*');
    // Reviewed purchases with a real category are left alone.
    expect(recategorize(fixed)).toBe(fixed);
  });

  it('changing one purchase updates the same store’s other unreviewed purchases', () => {
    const { ledger } = applyImport(L, payload([
      { id: '1', account: 'c', posted: unix('2026-10-02'), amount: '-20', description: 'ZZ NOODLE HOUSE' },
      { id: '2', account: 'c', posted: unix('2026-10-04'), amount: '-25', description: 'ZZ NOODLE HOUSE' },
      { id: '3', account: 'c', posted: unix('2026-10-04'), amount: '-9', description: 'SHELL OIL 123' },
    ]));
    const t = ledger.transactions[0];
    const edited = { ...t, flag: '*' as const, postings: t.postings.map((p) => (p.account.startsWith('Expenses:') ? { ...p, account: 'Expenses:Gifts' } : p)) };
    const res = applyCategoryToSimilar({ ...ledger, transactions: [edited, ...ledger.transactions.slice(1)] }, edited);
    expect(res.changed).toBe(1);
    expect(res.ledger.transactions.map(cat)).toEqual(['Expenses:Gifts', 'Expenses:Gifts', 'Expenses:Transport:Gas']);
  });
});

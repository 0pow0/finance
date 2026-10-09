// What you owe on each card, and whether it matches what the bank reports (like Beancount's
// `balance` check). A mismatch means a transaction is missing, duplicated, or has a wrong amount.

import {
  ADJUSTMENT_ACCOUNT, isCard, newId, upsertTransaction,
  type Account, type Ledger, type Transaction,
} from './ledger';
import type { Cents } from './money';

export type CheckStatus = 'match' | 'pending' | 'mismatch';

export interface CardBalance {
  account: Account;
  /** What the ledger says you owe today (positive = owed). */
  owed: Cents;
  bank?: {
    /** What the bank says you owe (positive = owed). */
    owed: Cents;
    asOf: string;
    /** What the ledger said you owed at the end of asOf. */
    ledgerOwed: Cents;
    /** bank - ledger, as owed amounts. Positive = the bank says you owe more. */
    difference: Cents;
    pending: Cents;
    status: CheckStatus;
  };
}

function balanceOn(ledger: Ledger, account: string, through?: string): Cents {
  let sum = 0;
  for (const t of ledger.transactions) {
    if (through && t.date > through) continue;
    for (const p of t.postings) if (p.account === account) sum += p.amount;
  }
  return sum;
}

export function cardBalances(ledger: Ledger): CardBalance[] {
  return ledger.accounts
    .filter((a) => isCard(a.name) && !a.deleted && (!a.closed || ledger.bankBalances?.[a.name]))
    .map((account) => {
      const owed = -balanceOn(ledger, account.name) || 0;
      const bb = ledger.bankBalances?.[account.name];
      if (!bb) return { account, owed };
      const ledgerOwed = -balanceOn(ledger, account.name, bb.asOf) || 0;
      const bankOwed = -bb.amount || 0;
      const difference = bankOwed - ledgerOwed;
      const pendingOwed = -bb.pending || 0;
      const status: CheckStatus = difference === 0 ? 'match' : pendingOwed !== 0 && difference === pendingOwed ? 'pending' : 'mismatch';
      return { account, owed, bank: { owed: bankOwed, asOf: bb.asOf, ledgerOwed, difference, pending: pendingOwed, status } };
    })
    // Only cards that have something to show: a balance owed or a bank-reported balance.
    .filter((c) => c.owed !== 0 || c.bank);
}

/** Book the difference so the card matches the bank (shown as "Balance adjustment"). */
export function adjustToBank(ledger: Ledger, card: CardBalance): Ledger {
  if (!card.bank || card.bank.difference === 0) return ledger;
  const amount = -card.bank.difference; // ledger sign: owing more is negative
  const t: Transaction = {
    id: newId(),
    date: card.bank.asOf,
    flag: '*',
    payee: 'Balance adjustment',
    narration: 'Matched to the balance reported by the bank',
    postings: [
      { account: card.account.name, amount },
      { account: ADJUSTMENT_ACCOUNT, amount: -amount },
    ],
    tags: [],
    source: 'manual',
  };
  return upsertTransaction(ledger, t);
}

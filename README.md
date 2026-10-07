# Household Ledger

A private, encrypted web app for tracking our family's credit card spending and budgets.
Data is stored in the [Beancount](https://beancount.github.io/) format, so it can always be
exported and checked with standard tools.

**This repository contains only the app's code. Never commit financial data here.**
(`.gitignore` blocks `.beancount`, `.csv` and backup files as a safety net.)

## What works today

- Add purchases and refunds (amount, where, category, card, date, note)
- Remembers the category and card you last used for each payee
- Monthly budgets per category, **rollover** (leftover/overspending carries to next month) or **fixed**
- Home dashboard: spent this month, what's left in each budget, unbudgeted spending
- Activity list with search and card filters
- Encrypted backup download and restore; set up a second phone from the household key
- Export to / import from a Beancount file
- Works offline and installs to the iPhone Home Screen

- Encrypted sync between both phones through a private GitHub repo (merges edits from both phones)
- Daily automatic Chase & Amex import (SimpleFIN + scheduled job), auto-categorized, with a review
  inbox and "Approve all". Setup: [docs/SYNC-SETUP.md](docs/SYNC-SETUP.md)

## Coming next

1. Apple Pay capture through an iOS Shortcut
2. Face ID unlock (passkey)

## How the security works

| | |
|---|---|
| Household key | Random 256-bit AES-GCM key, created on the phone. Encrypts the ledger and all backups. |
| On each phone | Stored in IndexedDB, wrapped by a key derived from that phone's passphrase (PBKDF2-SHA256, 600k iterations). |
| Backups | Encrypted with the household key only — no passphrase-derived material — so a leaked backup can't be brute-forced via the passphrase. |
| Recovery | The household key is shown once as a 55-character code (with typo checksum) to print and keep safe. |
| The web page | Only serves code. A strict Content Security Policy allows no third-party scripts and no network access except `api.github.com` (for future sync). |
| Auto-lock | After 1–60 minutes idle (default 5); the key is dropped from memory. |
| Sync | The ledger is pushed to a private repo encrypted with the household key. Each phone's GitHub token is stored encrypted on that phone only. |
| Bank import | The daily job (`importer/`) encrypts new transactions to the household's import *public* key; only the phones hold the private key. |

If every phone **and** the printed household key are lost, the data cannot be recovered.

## Using it on iPhone

1. Open the site in **Safari** → Share → **Add to Home Screen**. Always open it from the icon:
   Safari can clear website storage that isn't installed to the Home Screen.
2. Tap **Start a new household ledger**, choose a passphrase, and print/save the household key.
3. On the second phone: **Set up a second phone / restore**, enter the household key, and pick a
   backup file from the first phone (Settings → Download encrypted backup, e.g. via AirDrop).
4. Until sync is added, download an encrypted backup weekly.

## Development

```sh
npm install
npm run dev        # local dev server
npm test           # unit tests (set BEAN_CHECK=/path/to/bean-check to also validate against Beancount)
npm run build      # production build in dist/
```

Pushing to `main` runs the tests and deploys to GitHub Pages
(repo **Settings → Pages → Source: GitHub Actions**).

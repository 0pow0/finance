# Setting up sync and the daily bank import

About 15 minutes, once. Never paste tokens into chats or notes apps; only into GitHub's settings
and the app.

## 1. Create the private data repo (1 min)

GitHub → **+** → **New repository**
- Name: `finance-data`
- **Private** ✅
- Tick **Add a README file**
- **Create repository**

Then tell Claude it exists. Claude adds the daily-import job to it (`importer/` and
`.github/workflows/import.yml`).

## 2. A GitHub token for each phone (3 min per phone)

GitHub → your picture → **Settings** → **Developer settings** → **Personal access tokens** →
**Fine-grained tokens** → **Generate new token**
- Name: e.g. `Ledger – Alex's iPhone`
- Expiration: up to 1 year (put a reminder in your calendar to renew)
- Repository access: **Only select repositories** → `finance-data`
- Permissions → Repository permissions → **Contents: Read and write**
- **Generate token** and copy it (starts with `github_pat_`)

This token can only touch `finance-data`, and everything in it is encrypted.

## 3. Turn on sync on each phone (1 min per phone)

App → **Settings → Sync between phones → Set up sync**
- Data repo: `0pow0/finance-data`
- GitHub token: paste
- Name for this phone: e.g. `Alex's iPhone`
- **Connect** → it should say **Synced just now**

Do the first phone, then the second. The second phone merges its entries with the first, so
nothing is lost. If the second phone says it has a *different household key*, it was set up as a
separate ledger: on that phone, Export Beancount file (to keep its entries), Erase this phone's
ledger, choose **Set up a second phone / restore** with the first phone's household key, then
Import Beancount file only if it had entries the first phone doesn't.

## 4. Connect SimpleFIN (5 min)

1. Go to **beta-bridge.simplefin.org**, create an account (about $15/year), and link **Chase** and
   **American Express**.
2. In SimpleFIN Bridge, create a **setup token** for a new app connection and copy it.
3. GitHub → `finance-data` → **Settings** → **Secrets and variables** → **Actions** →
   **New repository secret**
   - Name: `SIMPLEFIN_SETUP_TOKEN`
   - Secret: paste the setup token
4. `finance-data` → **Actions** → **Daily bank import** → **Run workflow**. It should finish green
   and say how many transactions it fetched (never what they are).
5. Open the app → it syncs → **"N new bank transactions to review"**. Check the categories, fix
   any, then **Approve**.

From then on it runs every morning around 7am Eastern. New transactions arrive the next time
either phone opens the app.

## How it stays private

- `finance-data` holds only encrypted files; GitHub can't read them.
- The daily job has the household's **public** import key: it can encrypt new transactions for
  your phones but can't decrypt them or read the ledger.
- The SimpleFIN access is stored encrypted, unlockable only with the repo secret.
- The job's log shows counts only, never amounts, merchants, or tokens.
- SimpleFIN and its bank-data provider do see your card transactions; that's unavoidable for
  automatic import.

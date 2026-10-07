# Household ledger — encrypted data

This private repo is the sync point for the Household Ledger app. **Everything here is encrypted.**

| Path | What it is |
|---|---|
| `ledger.enc.json` | The household ledger, encrypted with the household key (AES-256-GCM). Written by the phones. |
| `inbox/*.json` | New bank transactions from the daily import, encrypted to the phones' import public key. The phones merge and delete them. |
| `config/import-public-key.json` | Public key the daily import encrypts to. Not secret. Written by the app. |
| `config/simplefin-access.enc.json` | SimpleFIN access, encrypted with the `SIMPLEFIN_SETUP_TOKEN` secret. |
| `importer/` | The daily import job (no dependencies). |

The import job can add encrypted transactions but cannot read the ledger or any import: only the
phones hold the keys.

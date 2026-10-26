# PocketWise

PocketWise is a local-first personal finance tracker. The browser UI is plain HTML, CSS, and JavaScript; an Express REST API validates and scopes every financial record to the authenticated user; SQLite stores accounts, transactions, budgets, savings goals, recurring rules, and sessions.

## Requirements

- Windows 10 or 11
- Node.js 22 LTS or 24 (64-bit) and npm
- Visual Studio Code

`better-sqlite3` is a native Node addon. Node 22/24 x64 normally have prebuilt Windows binaries. If your installation does not have a matching prebuild, install Visual Studio Build Tools with **Desktop development with C++** and a Windows 10/11 SDK, then run `npm install` again.

## Run locally

From the project folder in the VS Code terminal:

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Set `SESSION_SECRET` in `.env` to a long, random value before using any non-test environment. The app initializes its SQLite schema automatically at first start and is served at `http://localhost:3000`.

For a random secret in PowerShell, use:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Then paste that value into `.env`. The local database is `data/pocketwise.sqlite` by default; use `DATABASE_PATH` to place it elsewhere. Database files are ignored by Git.

## Features

- Registration, login, logout, password hashing, rate-limited auth, HTTP-only SameSite session cookies, and SQLite-backed sessions.
- Dashboard metrics, month selector, recent activity, category spend chart, and income/expense chart backed by SQLite data.
- Transaction create/read/update/delete, search, type/category/date filters, sorting, notes, and payment methods.
- Monthly category budgets with actual spend, remaining balance, and over-budget indicators.
- Savings goals with target, saved amount, remaining amount, and completion percent.
- Daily, weekly, monthly, and yearly recurring rules. Due occurrences are generated on API access and uniquely keyed by rule/date to prevent duplicates; catch-up is capped at 1,000 occurrences per rule per request.
- Six-month cash-flow visualization and date-range CSV export.
- Indian Rupee formatting and DD-MM-YYYY display.

## API overview

All financial endpoints require a signed-in session. JSON request bodies use `Content-Type: application/json`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/auth/register` | Create account `{name,email,password}` |
| POST | `/api/auth/login` | Sign in `{email,password}` |
| POST | `/api/auth/logout` | End session |
| GET | `/api/auth/me` | Current account |
| GET/POST | `/api/transactions` | List or create transactions |
| PUT/DELETE | `/api/transactions/:id` | Update or remove a manual transaction |
| GET/POST | `/api/budgets` | List or create monthly budgets |
| PUT/DELETE | `/api/budgets/:id` | Update or remove a budget |
| GET/POST | `/api/goals` | List or create savings goals |
| PUT/DELETE | `/api/goals/:id` | Update or remove a goal |
| GET/POST | `/api/recurring` | List or create recurring rules |
| PUT/DELETE | `/api/recurring/:id` | Update or remove a recurring rule |
| GET | `/api/analytics/summary?month=YYYY-MM` | Monthly totals and spending categories |
| GET | `/api/analytics/categories?month=YYYY-MM` | Category spending breakdown |
| GET | `/api/analytics/monthly-trends` | Six-month income, expense, and net-savings data |
| GET | `/api/reports/export.csv?from=YYYY-MM-DD&to=YYYY-MM-DD` | Date-filtered CSV |
| GET | `/api/meta` | Category and payment-method options |

Example using PowerShell's `Invoke-RestMethod` after creating an account in the UI:

```powershell
Invoke-RestMethod -Method Post http://localhost:3000/api/transactions `
  -ContentType 'application/json' `
  -Body '{"title":"Groceries","amount":1250,"type":"expense","category":"Groceries","paymentMethod":"UPI","date":"2026-10-26","notes":"Weekly shop"}' `
  -WebSession $session
```

## Tests

```powershell
npm test
```

The API test suite uses a temporary SQLite database and checks auth, validation, transaction CRUD, user isolation, budget totals, goal arithmetic, and CSV output.

## Notes and security

This is intended for local use and development. Before internet-facing deployment, configure TLS and a strong environment-provided `SESSION_SECRET`, review rate limits and cookie policy behind your proxy, add CSRF protections for cookie-authenticated state-changing requests, configure backups/retention, and run dependency/security audits. Do not expose the local SQLite file or development server publicly. Express error responses avoid returning database details. Amounts are stored as integer paise.

Chart.js and the font family are loaded from public CDNs, so the charts and custom type require internet access; the core tracker remains usable without those assets, but visualizations may not render. Recurring transactions are materialized when a signed-in user accesses transactions or creates a rule rather than by a separate always-on scheduler.

## Troubleshooting

- **PowerShell says scripts are disabled:** invoke npm as `npm.cmd install`, `npm.cmd run dev`, or `npm.cmd test`.
- **`better-sqlite3` build fails:** use Node 20/22 x64 LTS for its available prebuild, or install the C++ workload and Windows SDK described above.
- **Port 3000 is occupied:** set another `PORT` value in `.env` and open that port.
- **Charts are blank:** check the browser's network access to `cdn.jsdelivr.net`; the rest of the UI uses backend data independently.
- **Session invalid after changing the secret:** sign in again; active sessions are invalidated by design.

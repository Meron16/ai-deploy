# AI Deploy VS Code Extension

Deploy **backend**, **frontend**, and **fullstack** Node projects from VS Code with automatic error recovery.

## Features

- Detects React, Vite, Next.js, Nuxt, Express, NestJS, and monorepos (`frontend/` + `backend/`)
- **Backend deploys to Fly.io (free)** — no Railway paid plan required
- Frontend deploys to **Vercel** (free)
- Runs commands in the **AI Deploy** terminal
- Syncs `.env` to Fly / Vercel
- Self-healing retries + local Docker test command

## Commands

- **AI Deploy Project** — full deploy
- **AI Deploy: Test Locally (Docker)** — verify packaging without a cloud host

## Requirements

```powershell
npm i -g vercel
flyctl auth login
vercel login
```

On Windows the command is **`flyctl`**, not `fly`.  
Create a free Fly.io account first: https://fly.io

Your `.env` must already have `DATABASE_URL` (Neon, Supabase, school DB, etc.). Railway Postgres is not required.

## Environment variables

```env
DATABASE_URL=postgresql://...
JWT_SECRET=your-secret
PORT=3000
```

## Deploy targets

| Project | Primary | Fallback |
|---------|---------|----------|
| Backend / NestJS / Express | Fly.io (needs card) | **Cloudflare tunnel** (no card) |
| Frontend | Vercel | Fly.io |
| Fullstack monorepo | Backend → Fly.io, Frontend → Vercel | — |

## Development

```powershell
npm install
npm run build
```

Press **F5**, open your app folder, run **AI Deploy Project**.

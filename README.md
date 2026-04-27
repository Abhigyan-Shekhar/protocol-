# Hackathon PS Selection Portal

## Local run

```bash
node server.js
```

Open `http://127.0.0.1:3000`.

## Team flow

- `Register New Team` creates a fresh team record.
- `Enter Existing Team` checks the database for the submitted team name and only allows entry if that team already exists.
- Teams can go back to the lookup screen and re-enter by team name.

## Environment variables

- `PORT` default `3000`
- `HOST` default `127.0.0.1`
- `DATABASE_PATH` default `./data.sqlite`
- `ADMIN_KEY` default `admin-secret`
- `LOCKDOWN_MODE` set to `true` to freeze selections
- `ALLOW_ORIGIN` default `*`

## Render deploy

This repo includes [render.yaml](/Users/abhigyanshekhar/Desktop/Protocol%20Hackathon/render.yaml) for a Docker-based Render web service with a persistent disk mounted at `/data`.

Important:

- Render web services must bind to `0.0.0.0` and use the provided `PORT`.
- SQLite must live on persistent storage, so the app uses `DATABASE_PATH=/data/data.sqlite` on Render.
- Render health checks now use `GET /healthz`.
- Set `ADMIN_KEY` in Render before going live.

### Deploy steps

1. Push this repo to GitHub.
2. In Render, create a new Blueprint and select this repository.
3. Keep the persistent disk mount at `/data` so SQLite survives redeploys.
4. Set the secret `ADMIN_KEY` in Render before the first production use.
5. Deploy the Blueprint. Render will build from `Dockerfile` and use `render.yaml`.

## Docker deploy

Build:

```bash
docker build -t hackathon-portal .
```

Run with a persistent SQLite volume:

```bash
docker run -p 3000:3000 \
  -e HOST=0.0.0.0 \
  -e DATABASE_PATH=/data/data.sqlite \
  -v $(pwd)/portal-data:/data \
  hackathon-portal
```

This image is suitable for container hosts such as Render, Railway, Fly.io, or any VPS/container service, as long as the SQLite file is mounted on persistent storage.

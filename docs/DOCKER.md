# Docker

This project can run in Docker with authentication enabled and with settings
persisted in a Docker volume.

## Admin Token Model

For Docker deployments, provide the admin token from outside the container.
Do not rely on auto-generating it inside an ephemeral container.

```bash
export TYO_MQ_ADMIN_TOKEN="$(openssl rand -hex 32)"
```

The token is passed to the server as an environment variable:

```yaml
TYO_MQ_ADMIN_TOKEN: "${TYO_MQ_ADMIN_TOKEN:?Set TYO_MQ_ADMIN_TOKEN before running docker compose}"
```

The manager uses this token locally to sign management commands. The raw admin
token is not sent in management command payloads.

## Docker Compose

Start the server:

```bash
export TYO_MQ_ADMIN_TOKEN="$(openssl rand -hex 32)"
docker compose up -d tyo-mq
```

Run the interactive manager:

```bash
docker compose run --rm manager
```

The manager connects to the server over the Compose network:

```env
TYO_MQ_HOST=tyo-mq
TYO_MQ_PORT=17352
TYO_MQ_PROTOCOL=http
```

## Persistent Settings

`docker-compose.yaml` mounts a named volume:

```yaml
volumes:
  - tyo-mq-state:/data
```

The server uses:

```env
TYO_MQ_SETTINGS_FILE=/data/tyo-mq.settings.json
TYO_MQ_ENV_FILE=/data/.env
```

Realm/auth setting changes sent by `manager.js` are applied by the server and
persisted to `/data/tyo-mq.settings.json`.

## Authentication Defaults

Compose enables auth by default:

```env
TYO_MQ_AUTH_ENABLED=true
TYO_MQ_AUTO_ADMIN_TOKEN=false
```

`TYO_MQ_AUTO_ADMIN_TOKEN=false` is intentional for Docker. The admin token
should be provided by the deployment environment.

## Manager Capabilities

Run:

```bash
docker compose run --rm manager
```

The interactive manager can:

- show auth settings
- enable/disable global auth
- add a realm
- rename a realm
- enable/disable auth per realm
- verify the admin token
- show the next pending authorization request
- approve/reject pending authorization requests

All manager actions are sent to the server as signed socket commands.

## Client Authorization Flow

A client can submit an authorization request:

```bash
docker compose run --rm tyo-mq npm run auth:request -- \
  --realm tyolab \
  --role consumer \
  --client-id tyolab-agent-01 \
  --client-name "Tyolab Agent 01"
```

Then a manager can approve it:

```bash
docker compose run --rm manager
```

Or use the non-interactive manager command:

```bash
docker compose run --rm tyo-mq npm run auth:manager -- next
docker compose run --rm tyo-mq npm run auth:manager -- approve <request_id> --role consumer
```

For non-interactive commands, make sure the container can reach the service:

```bash
docker compose run --rm \
  -e TYO_MQ_HOST=tyo-mq \
  -e TYO_MQ_ADMIN_TOKEN="$TYO_MQ_ADMIN_TOKEN" \
  tyo-mq npm run auth:manager -- next
```

## Direct Docker Run

Without Compose:

```bash
docker volume create tyo-mq-state

docker run --rm \
  -p 17352:17352 \
  -e TYO_MQ_AUTH_ENABLED=true \
  -e TYO_MQ_AUTO_ADMIN_TOKEN=false \
  -e TYO_MQ_ADMIN_TOKEN="$TYO_MQ_ADMIN_TOKEN" \
  -e TYO_MQ_SETTINGS_FILE=/data/tyo-mq.settings.json \
  -e TYO_MQ_ENV_FILE=/data/.env \
  -v tyo-mq-state:/data \
  tyo-mq:local
```

Run the manager in another container on the same Docker network, or run it on
the host with:

```bash
TYO_MQ_HOST=localhost \
TYO_MQ_PORT=17352 \
TYO_MQ_ADMIN_TOKEN="$TYO_MQ_ADMIN_TOKEN" \
npm run manager
```

## Notes

- If `/data` is not persisted, settings changes will be lost when the container
  is removed.
- If `TYO_MQ_ADMIN_TOKEN` is changed, existing signed manager calls using the
  old token will fail.
- Authorization requests are still in-memory for the current server process.
  Persisting requests is a later phase.

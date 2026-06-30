# Deploying ZenZip

Reference deployment artifacts (P16.1 / P16.2). A ZenZip service is a single
Node process that embeds the engine — there is no broker, cron box, or worker
fleet to run alongside it.

| File | What |
| --- | --- |
| `Dockerfile` | Multi-stage image; runs on Alpine via musl prebuilds, non-root, `HEALTHCHECK` on `/healthz`. |
| `.dockerignore` | Keeps build context lean. |
| `kubernetes.yaml` | StatefulSet + Service with `/healthz` liveness + `/readyz` readiness probes and a drain `preStop`. |
| `helm/` | Minimal Helm chart (same, parameterized: image, replicas, persistence, Postgres, encryption secret). |

## Single-node (embedded SQLite)

Keep `replicas: 1` (SQLite is single-writer) and mount a volume at the data dir
so state survives restarts:

```sh
docker build -f deploy/Dockerfile -t my-zenzip-app .
docker run -p 3000:3000 -p 4100:4100 -v zenzip-data:/data my-zenzip-app

helm install my-app deploy/helm --set image.repository=my-zenzip-app
```

## Multi-node (Postgres)

Point the app at Postgres and scale out — the engine handles cross-node job
claims and scheduler election itself, no volume needed:

```sh
helm install my-app deploy/helm \
  --set replicas=3 \
  --set persistence.enabled=false \
  --set postgres.enabled=true \
  --set postgres.urlSecret=zenzip-db
```

## Secrets

Payload encryption (P7.15) reads `ZENZIP_ENCRYPTION_KEY` from a Secret — pass
`--set encryption.secretName=zenzip-secrets` (key `encryptionKey`). Never inline
the key in manifests or images.

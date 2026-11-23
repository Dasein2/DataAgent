# RainYun single-host v1.0 deployment

This profile is for the existing 2-vCPU / 4-GB host. It does not change Caddy, ports 80/443,
its existing application on port 3001, or any other managed asset. It is **not** a public-HTTPS
configuration: until a domain is approved, use an SSH tunnel.

## Isolation and limits

- Compose project `data-agent-v1`, image `data-agent:v1.0-<revision>`, volume `data-agent-v1_data`.
- Dedicated checkout `/opt/data-agent-v1`; secrets in `.env.prod` (0600, not committed).
- Runtime limit: 1536 MiB RAM including tmpfs, no extra swap, 1.25 CPUs, 256 processes.
- Non-root, read-only root filesystem, no Linux capabilities, no Docker socket mount.
- Host networking with an application listener restricted to `127.0.0.1:8787` (no published port).
  This trades network-namespace isolation for leaving the host firewall and forwarding unchanged.
  Do not use this profile for untrusted container images. Its build network is also `host`.
- Docker daemon configured on this previously Docker-free host with `bridge: "none"`,
  `iptables: false`, `ip6tables: false`, `ip-forward: false`, `ip-masq: false`.
  This configuration is host-specific; do not apply it to a host already running Docker workloads.
- Build inside the dedicated `data-agent-build.slice` with `MemoryMax=1536M`,
  `MemorySwapMax=0`, and `CPUQuota=75%`. Use the legacy Docker builder with
  `--cgroup-parent=data-agent-build.slice` so its RUN containers share that aggregate limit.
  Do not run an unconstrained parallel build.

Resource limits reduce interference; they cannot guarantee zero latency impact on a shared host.

## Start / inspect

```bash
cd /opt/data-agent-v1
# .env.prod contains NODE_ENV=production, account auth, a stable profile secret, and budgets.
# DATA_AGENT_REVISION is the checked-out short Git revision.
# Initial build / later rebuild, after the documented slice has been installed:
REV=$(git rev-parse --short HEAD)
sudo systemd-run --wait --collect --unit=data-agent-v1-build-$(date +%s) \
  --property=CPUQuota=75% --property=MemoryMax=1536M --property=MemorySwapMax=0 \
  --property=Nice=10 --setenv=DOCKER_BUILDKIT=0 \
  --working-directory=/opt/data-agent-v1 \
  /usr/bin/docker build --network=host --cgroup-parent=data-agent-build.slice \
  --memory=1536m --memory-swap=1536m --cpu-period=100000 --cpu-quota=75000 \
  --label=org.opencontainers.image.revision=$(git rev-parse HEAD) \
  -t data-agent:v1.0-$REV .
# Set DATA_AGENT_REVISION=$REV in .env.prod before starting the matching image.
docker compose --env-file .env.prod -p data-agent-v1 -f deploy/rainyun/compose.yml up -d --no-build
docker compose --env-file .env.prod -p data-agent-v1 -f deploy/rainyun/compose.yml ps
curl -fsS http://127.0.0.1:8787/healthz
# 503 is expected here until an actual model key has been configured:
curl -i http://127.0.0.1:8787/readyz
```

## Access without changing existing services

From your computer, forward a local port using an SSH client / the opskat desktop SSH UI:

```bash
ssh -N -L 8787:127.0.0.1:8787 root@198.44.178.65
```

Open **http://localhost:8787/** (not the public server IP). Secure cookies are preserved;
modern browsers treat localhost as a trustworthy origin. If your browser rejects the cookie,
use a properly configured HTTPS endpoint rather than disabling cookie security. The admin
bootstrap password is in `/opt/data-agent-v1-ops/bootstrap-admin.txt` (root-only, outside the
checkout and Docker build context); change it after
first login and remove that file. No production database or personal model credentials are
copied automatically. Configure the intended model channel through the authenticated console.

For public access, first choose a domain and point its DNS here; then separately approve a
Caddy site addition and graceful reload. Only after that set `DATA_AGENT_TRUST_PROXY=1`.
Never expose port 8787 to the internet.

## Backup / upgrade / rollback

Stop **only** this Compose project before a filesystem backup of SQLite and its data. Never run
`docker system prune`, `docker compose down -v`, global service restarts, or a host reboot.
Keep the profile encryption key together with the encrypted backup, outside the repository.
A running-volume tar is not a transaction-consistent SQLite backup.

Private/loopback database targets are disabled by default (`DATA_AGENT_ALLOW_PRIVATE_NETWORK=false`)
to protect the other host services. Enable this only after reviewing the intended database target.
Model editing is enabled for the administrator so the first channel can be configured; ordinary
accounts cannot edit global channels.

Before an upgrade, save `.env.prod`, back up `data-agent-v1_data`, record the existing image ID,
and read schema changes. Build the new commit under limits, update `DATA_AGENT_REVISION`, then
recreate only `data-agent`. Rollback requires the recorded image and, if schema/data changed,
the matching backup; backward compatibility is **not** guaranteed merely because code builds.

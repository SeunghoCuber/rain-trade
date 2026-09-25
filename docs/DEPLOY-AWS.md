# Deploying the Recorder on AWS

This runs the recorder, hourly Parquet compaction and the daily health report on one EC2 instance, so recording doesn't depend on a laptop being awake. The same box will later run the live paper trader (Phase 11).

## 1. Choose the instance

| Item | Recommendation | Why |
|---|---|---|
| Instance | **t4g.small** (2 vCPU Graviton, 2 GB RAM), Ubuntu 24.04 LTS **arm64** | The recorder uses little CPU. Compaction peaks at about 3 s of CPU per hour of data. 2 GB leaves headroom for DuckDB. |
| Disk | **gp3, 40 GB** | Raw gz is about 0.5 GB/day and Parquet about 0.35 GB/day, so 3 weeks is about 18 GB. The current hour sits uncompressed (up to ~300 MB) until it rotates. |
| Cost | about $12/month for compute plus $3/month for disk (on-demand) | A 1-year savings plan cuts compute by about 35%. |

### Region

Pick the region with the lowest Polymarket CLOB latency among the ones you're willing to use. Launch a throwaway `t4g.nano` in each candidate region, for example `us-east-1`, `eu-west-2` (London) and `eu-west-1` (Ireland). Then run:

```sh
node ops/probe-venues.ts 30
```

Compare `clob REST` round-trip time and `clob WS` lag. Baseline from a Mac in Los Angeles: CLOB REST about 193 ms, CLOB WS lag about 76 ms.

Other things the probe shows:
- **Binance:** `api.binance.com` is geo-blocked (HTTP 451) from US IPs, including AWS US regions. The config already uses Binance's market-data mirror (`data-stream.binance.vision`), which works everywhere, so this doesn't block any region.
- **Chainlink:** RTDS lag is about 1.5 s everywhere, because it is delayed upstream.
- **Jurisdiction:** paper trading only reads public market data. If you later place real orders, the server's region must be one where you may legally trade on Polymarket. Decide that before choosing a region for live trading.

## 2. Launch

- **AMI:** Ubuntu Server 24.04 LTS (arm64).
- **Key pair:** your SSH key.
- **Security group:** inbound **SSH (22) from your IP only**. Nothing else needs to be open, since the recorder only makes outbound connections. For the dashboard later, use an SSH tunnel instead of opening a port.
- **Storage:** 40 GB gp3.

## 3. Set up the box

```sh
ssh ubuntu@<ip>

# Node 24 + git
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo corepack enable

# clock: recvTs comes from the system clock, so confirm chrony is synced
# (Ubuntu on EC2 uses the Amazon Time Sync Service by default)
chronyc tracking | grep -E "Reference ID|System time|Leap status"   # expect "Leap status : Normal"

# code (private repo: use `gh auth login` or a read-only deploy key)
git clone <your-repo-url> ~/rain-trade
cd ~/rain-trade
pnpm install --frozen-lockfile
pnpm check                  # typecheck + lint + tests, including DuckDB on arm64
node ops/probe-venues.ts 20 # sanity check from the final region
```

Optional: to get feed-down alerts on your phone, set `recorder.alertWebhookUrl` in `config/default.yaml`. It works with a Slack incoming webhook or `https://ntfy.sh/<your-topic>`.

## 4. Install the services

```sh
ops/install-systemd.sh
```

This installs and starts three units, all running as your user from `~/rain-trade`:

| Unit | What | When |
|---|---|---|
| `raintrade-recorder.service` | the recorder | always; restarts 5 s after any exit and starts at boot |
| `raintrade-compact.timer` | `pnpm data:compact` (closed raw hours → Parquet) | hourly at :07 UTC |
| `raintrade-health.timer` | `pnpm data:health` (yesterday + today → `data/health/`) | daily at 01:15 UTC |

Remove them with `ops/install-systemd.sh uninstall`.

## 5. Day-to-day

```sh
systemctl status raintrade-recorder          # running? uptime?
tail -f data/recorder.log                    # live log
cat data/status.json                         # per-feed health, refreshed every 10 s
pnpm recorder:stats                          # today's per-market table (from raw, includes the open hour)
pnpm data:sql                                # row counts per view
pnpm data:sql "SELECT count(*) FILTER (NOT excluded) AS usable, count(*) AS total FROM markets"
journalctl -u raintrade-recorder --since today   # restarts, crashes
```

### Updating the code

```sh
cd ~/rain-trade && git pull && pnpm install --frozen-lockfile && pnpm check
sudo systemctl restart raintrade-recorder
```

A restart costs a few seconds of data. The health report marks the affected market `GAP`, so restart between windows if you can: just after :00, :15, :30 or :45 plus about 5 s.

## 6. Getting data onto your laptop

For analysis and the dashboard, copy the Parquet files (small) rather than the raw files:

```sh
rsync -avz --exclude '_tmp' ubuntu@<ip>:rain-trade/data/parquet/ ./data/parquet/
rsync -avz ubuntu@<ip>:rain-trade/data/health/ ./data/health/
pnpm data:sql
```

To back up the raw data (the source of truth) as well, sync it to S3 daily. This costs about $0.35/month for 3 weeks of data:

```sh
aws s3 sync ~/rain-trade/data/raw s3://<bucket>/raintrade/raw --exclude '*.ndjson'   # closed hours only
```

## 7. Moving off the Mac

1. Start the server recorder and confirm `data/status.json` shows all feeds connected.
2. Stop the Mac recorder with `Ctrl-C`, or `ops/install-recorder.sh uninstall` if you installed the launchd agent.
3. The Mac's data is still valid. To analyze it together with the server's, copy both into one `data/` directory. **Keep only one copy of any hour both machines recorded**, because both write files with the same names (`raw/<date>/<HH>.ndjson.gz`).

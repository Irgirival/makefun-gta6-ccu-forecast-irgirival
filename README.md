# GTA VI Twitch CCU Forecast — regime-analog forecaster

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Entry for make.fun's **gta6-twitch-ccu-forecast-01**: forecast, hour by hour,
how many people watch Grand Theft Auto VI live on Twitch over the 24 UTC
hours of its release day (2026-11-19), from everything recorded up to the end
of its first hour, as five quantiles an hour (5%, 25%, 50%, 75%, 95%).
Scored by mean pinball loss on the log scale; the prize needs a loss strictly
below the best house entry.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` (Node 22, standard library only) reads every `*.in` case in the
input directory (`$MAKEFUN_INPUT_DIR`, else `/input`) and writes one
`/output/<id>.out` per case: `{"hours": [{"hour": 2, "q": [q05, q25, q50,
q75, q95]}, ...]}` for hours 2..24. Deterministic: two runs on the same case
write the same bytes. No network, no model calls, ~0.1 s per case.

## Method — regime / analog (not a fitted global model)

The case ships 38–42 past big launches' hourly Twitch curves
(`comparables`, SullyGnome hourly averages, 14 days before to 3 days after
each release day). The forecaster treats those launches as analogs:

1. **Shape.** Each analog is reduced to its release-day shape,
   `log(V[h] / V[1])` for h = 2..24, plus four features knowable at the
   checkpoint: hour-1 scale `log V1`, launch multiplier vs its quiet
   pre-release baseline `log(V1 / baseline)`, viewers-per-channel at hour 1,
   and the pre-release ramp in the last day. The target launch gets the same
   four features from its own history and its hour-1 print.
2. **Regime.** Each launch's unlock is parsed from its unlock description
   (`comparables[].unlock`, target's `notes`) into one of four regimes:
   `early` (paid early access ran before release day — hour 1 is already hot,
   the day stays flat, peak/hour-1 ~1.0–1.9x), `rolling` (midnight-local
   rolling unlock — hour 1 holds only regions past midnight, the curve rises
   as the US unlocks, peak/hour-1 ~1.7–12x), `front` (one global unlock at or
   before 00:00Z — hour 1 IS the peak), `delayed` (one global unlock during
   the day — hour 1 is pre-unlock and tiny, the curve explodes at the unlock
   hour). A different regime is down-weighted hard; a delayed mismatch
   hardest. Weak-tier launches (free-to-play, slow-burn) are down-weighted.
   GTA VI is `rolling`: console-only, midnight local, no early access.
3. **Forecast.** Per hour, the kernel-weighted median of the analogs'
   log-ratios (Gaussian kernel on feature distance, hour-1 scale weighted
   most), lightly smoothed across neighbouring hours. The spread per hour is
   the kernel-weighted dispersion of the analogs' log-ratios, floored and
   scaled by a calibrated factor. Quantiles are log-normal around the median.
   Fallback when no usable analog exists: the house persistence baseline.
   Output is always valid.

All constants live in `calibration.json`; the tuning behind them is in
`CALIBRATION.md`.

## Calibration & backtest (leave-one-out)

Tuned by leave-one-out backtest over the 38 comparable launches in the kit's
practice cases: each launch forecast from its hour-1 print using the other 37
as analogs, scored by the contest's pinball loss on the log scale.

| model | mean loss (37 launches) | big launches (hour-1 ≥ 50k) | small launches | beats house |
|---|---|---|---|---|
| house persistence baseline | 0.9297 | 0.2509 | 1.7282 | — |
| **this forecaster** | **0.4525** | **0.2049** | **0.7438** | **30 / 37** |

Typical miss 132%, 90% coverage 0.783. The practice cases themselves score
the same shape: rising curves peaking at hours 19–20 (US prime time), peak /
hour-1 ≈ 2.2–2.6x for the console rolling launches. Full per-launch table,
tuning grid and regime table: `CALIBRATION.md`.

## Live anchors (Twitch public GQL, 2026-11-18 ~13:20 UTC)

Probed with `curl` against `POST https://gql.twitch.tv/gql`
(Client-Id `kimne78kx3ncx6brgo4mv6wki5h1ko`, the public web client id):

| category | viewers | channels |
|---|---|---|
| Grand Theft Auto VI (1867279146) | 2,452,216 | 11,781 |
| Grand Theft Auto V (32982) | 54,404 | 1,832 |
| ELDEN RING (512953) | 3,562 | 191 |
| Red Dead Redemption II (493959) | 1,146 | 119 |
| God of War Ragnarök (102007682) | 38 | 37 |
| Marvel's Spider-Man 2 (1967084783) | 117 | 20 |
| Cyberpunk 2077 (65876) | 1,954 | 162 |
| Hogwarts Legacy (1095275650) | 164 | 39 |

Two notes: the GQL endpoint serves **live** counts only — there is no
historical endpoint, so launch history comes from the case's comparables
(SullyGnome-sourced, as the kit documents), not from GQL. And the GTA VI
category was already at 2.45M viewers the day before release (vs 1,240 in
the house probe on 2026-11-17): pre-release hype is enormous and volatile,
which is why the forecaster keys off the hour-1 print and the unlock regime
rather than the pre-release level.

## Files

- `main.ts` — the forecaster (entrypoint)
- `calibration.json` — tuned constants (kernel weights/scales, regime
  penalties, spread factor, prior strength, smoothing)
- `CALIBRATION.md` — method, tuning, backtest detail
- `LICENSE` — MIT (`SPDX-License-Identifier: MIT`)

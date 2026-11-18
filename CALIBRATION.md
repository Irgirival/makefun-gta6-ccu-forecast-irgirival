# Calibration — regime-analog forecaster

How the constants in `calibration.json` were chosen, and what the backtest
says. Nothing here is fitted to the four practice targets: their answers are
not in the kit (the kit ships no `reference/`), so the tuning target is
leave-one-out (LOO) over the 38 comparable launches, whose full release-day
curves ARE in the case files.

## The forecaster in one paragraph

For a case, every comparable with a usable release day (hour-1 print plus at
least 12 of hours 1..24) becomes an analog with a shape
`log(V[h]/V[1])` and four checkpoint-known features. The target gets the same
four features. Analogs are weighted by a Gaussian kernel on feature distance,
times a regime factor and a tier factor. Per hour, the forecast median is the
kernel-weighted median of the analogs' log-ratios, smoothed across
neighbouring hours; the spread is the kernel-weighted dispersion of the
analogs' log-ratios at that hour, scaled and floored. Quantiles are
log-normal around the median. Fallback: house persistence baseline.

## Features (all in log space, computed identically for target and analogs)

| feature | definition | scale | weight |
|---|---|---|---|
| `logV1` | log of the hour-1 print | 1.5 | **3.0** |
| `logM` | log(hour-1 / quiet pre-release baseline); baseline = median hourly viewers in [day−7, day−1) | 2.0 | 1.0 |
| `logVpc` | log(hour-1 viewers / hour-1 channels) | 0.7 | 0.5 |
| `logRamp` | log(median last 6 h before the day / median the day before that) | 1.0 | 1.0 |

Hour-1 scale dominates: launches whose first hour was the same size shape
the day the same way. Raising its weight from 1.0 → 2.0 → 3.0 was the single
biggest tuning win (LOO all 0.608 → 0.517 → 0.476). The quiet-baseline
multiplier is noisy for tiny categories (a baseline of 1–10 viewers makes
`logM` explode), which is why its weight stays at 1.0.

## Regimes (parsed from unlock text)

`parseRegime` reads a comparable's `unlock` text, or the target's `notes`:

1. `early` — `/early access/i`, excluding "no early access" and "campaign
   early access" (a campaign early access does not flatten the day; BO6/MWIII
   are `rolling`, not `early`).
2. `front` — a global/simultaneous unlock whose UTC instant is at or before
   the end of hour 1 (e.g. a PC global unlock the night before).
3. `rolling` — midnight-local / rolling unlock.
4. `delayed` — a global/simultaneous unlock during the release day.
5. Default `rolling`.

Parsed regimes vs the launches' actual peak / hour-1 ratios:

| regime | launches (peak / hour-1) |
|---|---|
| `front` | ELDEN RING 1.0, Cyberpunk 2077 1.3 |
| `early` | Hogwarts Legacy 1.3, Starfield 1.1, Diablo IV 1.3, Assassin's Creed Shadows 1.0, DOOM: The Dark Ages 1.6, Death Stranding 2 1.7, Forza Horizon 5 1.9, 007 First Light 1.5 |
| `delayed` | Black Myth: Wukong 92.0, Hollow Knight: Silksong 2120.6, Battlefield 6 228.2 |
| `rolling` | Resident Evil Requiem 12.1, Ghost of Yōtei 3.6, Monster Hunter Wilds 2.6, Call of Duty: Black Ops 6 2.7, Modern Warfare III 1.7, Black Ops 7 1.9, Modern Warfare 4 2.4, Forza Horizon 6 5.3, Marathon 121.4, Saros 5.6, Zelda: Tears of the Kingdom 2.7, Baldur's Gate 3 134.3, Borderlands 4 1.7, Kingdom Come: Deliverance II 1104.7, Elden Ring Nightreign 1.0, Clair Obscur: Expedition 33 11.1, FINAL FANTASY VII REBIRTH 2.2, The Last of Us Part II 1.3, Ghost of Tsushima 2.3, Halo Infinite 8.7, Stellar Blade 3.4, ARC Raiders 259.8, Marvel Rivals 1.6, HELLDIVERS 2 346.8 |

All four practice targets parse as `rolling` (Wolverine, Red Dead Redemption
2, God of War Ragnarök, Spider-Man 2 — all console-only midnight-local
launches), and GTA VI is `rolling` too (console-only, midnight local, no
early access). The regime gate matters: without it the flat `early`/`front`
analogs drag a rising launch's median down, and the `delayed` analogs drag
everything up.

Regime mismatch multiplies an analog's weight by 0.15 (0.05 when either side
is `delayed`); weak-tier analogs (free-to-play, slow-burn) by 0.3.

## Tuning history (LOO, 37 targets, mean pinball loss; house = 0.9297)

| config | all | big (hour-1 ≥ 50k) | small | beats house |
|---|---|---|---|---|
| kernel only, prior 3, spread 1.0 | 0.6078 | 0.2789 | 0.9946 | 23/37 |
| prior 0.5, spread 0.7 | 0.5269 | 0.2616 | 0.8390 | 24/37 |
| + regime gate, prior 0.25, spread 0.9 | 0.5531 | 0.2262 | 0.9378 | 28/37 |
| + logV1 weight 2.0 | 0.5170 | 0.2165 | 0.8704 | 30/37 |
| + logV1 weight 3.0 | 0.4762 | 0.2121 | 0.7869 | 30/37 |
| + prior 0, spread 0.8 (**final**) | **0.4525** | **0.2049** | **0.7438** | **30/37** |

Prior strength was monotone-worse from 0 upward (0 < 0.15 < 0.25 < 0.5 < 1 <
3), so the final uses no shrinkage to the all-regime global median — the
kernel-weighted median stands on its own. Spread 0.8 beats 0.7/0.9/1.0 on the
full set; 3-hour median smoothing kept (neutral on LOO, removes jagged
medians). Median/mean blend kept at pure median (blending toward the mean
helped small launches slightly but hurt big ones).

Final `calibration.json`: logV1 weight 3.0 / scale 1.5; logM 1.0 / 2.0;
logVpc 0.5 / 0.7; logRamp 1.0 / 1.0; priorStrength 0; spreadFactor 0.8;
spreadFloor 0.15; spreadCap 1.0; sparseSpread 0.5; smoothMedian true;
medianBlend 1.0; minAnalogHours 12; regimeMismatch 0.15; delayedMismatch
0.05; weakTierWeight 0.3.

## LOO backtest, per launch (final config; loss vs house baseline)

| launch | hour-1 | loss | house | typical miss | 90% cov |
|---|---|---|---|---|---|
| ELDEN RING | 875,155 | 0.113 | 0.211 | 13% | 1.00 |
| Resident Evil Requiem | 46,345 | 0.961 | 1.273 | 262% | 0.13 |
| Hogwarts Legacy | 387,358 | 0.118 | 0.288 | 20% | 1.00 |
| Cyberpunk 2077 | 851,999 | 0.131 | 0.230 | 16% | 0.87 |
| Ghost of Yōtei | 27,206 | 0.229 | 0.473 | 45% | 0.91 |
| Monster Hunter Wilds | 152,314 | 0.270 | 0.427 | 53% | 0.78 |
| Black Myth: Wukong | 4,941 | 1.566 | 3.434 | 589% | 0.43 |
| Hollow Knight: Silksong | 164 | 1.232 | 3.941 | 392% | 0.35 |
| Battlefield 6 | 2,470 | 1.430 | 2.406 | 621% | 0.48 |
| Call of Duty: Black Ops 6 | 139,097 | 0.147 | 0.262 | 20% | 0.96 |
| Call of Duty: Modern Warfare III | 114,417 | 0.162 | 0.152 | 25% | 1.00 |
| Call of Duty: Black Ops 7 | 79,207 | 0.149 | 0.173 | 22% | 1.00 |
| Call of Duty: Modern Warfare 4 | 59,162 | 0.200 | 0.236 | 25% | 1.00 |
| 007 First Light | 127,800 | 0.140 | 0.348 | 21% | 1.00 |
| Forza Horizon 6 | 26,312 | 0.196 | 0.410 | 20% | 1.00 |
| Marathon | 1,393 | 0.851 | 1.745 | 228% | 0.52 |
| Saros | 6,400 | 0.241 | 0.601 | 44% | 1.00 |
| Zelda: Tears of the Kingdom | 129,948 | 0.156 | 0.309 | 25% | 1.00 |
| Starfield | 156,828 | 0.279 | 0.291 | 62% | 0.78 |
| Baldur's Gate 3 | 3,447 | 1.201 | 2.177 | 405% | 0.35 |
| Diablo IV | 533,455 | 0.220 | 0.125 | 38% | 0.65 |
| Borderlands 4 | 133,568 | 0.426 | 0.253 | 108% | 0.74 |
| Kingdom Come: Deliverance II | 414 | 1.390 | 3.464 | 317% | 0.35 |
| Assassin's Creed Shadows | 146,993 | 0.187 | 0.345 | 30% | 0.87 |
| DOOM: The Dark Ages | 50,351 | 0.159 | 0.256 | 25% | 0.96 |
| Elden Ring Nightreign | 319,909 | 0.365 | 0.252 | 90% | 0.78 |
| Clair Obscur: Expedition 33 | 10,639 | 0.603 | 1.145 | 182% | 0.65 |
| Death Stranding 2 | 42,221 | 0.163 | 0.176 | 26% | 1.00 |
| FINAL FANTASY VII REBIRTH | 53,526 | 0.181 | 0.173 | 23% | 0.96 |
| The Last of Us Part II | 365,019 | 0.271 | 0.247 | 65% | 0.96 |
| Ghost of Tsushima | 131,910 | 0.126 | 0.228 | 11% | 1.00 |
| Halo Infinite | 20,526 | 0.486 | 0.631 | 127% | 0.70 |
| Forza Horizon 5 | 43,895 | 0.240 | 0.325 | 35% | 0.78 |
| Stellar Blade | 27,057 | 0.195 | 0.372 | 29% | 1.00 |
| ARC Raiders | 1,410 | 1.544 | 3.377 | 657% | 0.48 |
| Marvel Rivals | 165,939 | 0.296 | 0.210 | 70% | 0.87 |
| HELLDIVERS 2 | 419 | 0.636 | 3.429 | 147% | 0.65 |

Mean 0.4525 vs house 0.9297; big launches 0.2049 vs 0.2509; small launches
0.7438 vs 1.7282; beats house on 30/37. The seven losses to the house are
all flat-ish launches where the house's flat forecast is hard to beat
(Modern Warfare III, Diablo IV, Borderlands 4, Nightreign, FFVII Rebirth,
The Last of Us Part II, Marvel Rivals) — the analog median rises a little
too much there. The worst misses are the tiny-hour-1 delayed launches, where
the true peak is 100–2000x hour 1 and the spread cannot honestly cover it;
all of them still beat the house by a wide margin.

## What the final case will look like

The final case adds the four practice launches as analogs (all `rolling`,
console-only, hour-1 23k–269k) to the 38 above. GTA VI's hour-1 print will
be far above every analog's (the category alone read 2,452,216 viewers /
11,781 channels on 2026-11-18, vs the largest analog hour-1 of 875,155), so
the kernel's relative weights pick the nearest rolling analogs and the
forecast is effectively a nearest-neighbour rolling-launch shape: a rise
through the US unlock hours to a peak at hours 19–20 (US prime time), peak /
hour-1 ≈ 2–3x. On the practice cases the program forecasts exactly that
shape (peaks at h19–h20, peak/hour-1 2.2–2.6x). If GTA VI's true day is
flatter than every rolling analog (e.g. the pre-release event inflates hour
1), the forecast overshoots; the spread (log σ ≈ 0.2–0.4 by hour) is the
honest price of that uncertainty.

## Limits

- The LOO backtest reuses the same 37 analogs for every target; the final
  has 42, including four perfect-regime analogs the LOO never sees, so the
  final should be at least as good as LOO on the big-launch regime — but
  GTA VI is off the analog scale, which LOO cannot test.
- SullyGnome hourly averages are one point an hour, not minute means; the
  final's prints are minute means. Shapes transfer; absolute levels are
  anchored to the case's own hour-1 print, so the difference is second-order.
- The delayed regime (unlock during the day) is the weakest part: only three
  analogs, peak ratios spanning 92–2120x. It does not apply to GTA VI.
- Live Twitch GQL gives current counts only; there is no historical
  endpoint, so no GQL history was used for calibration.

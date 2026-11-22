[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Einju/token-radar-02/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Einju/token-radar-02/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token Radar v2

A pre-token DeFi protocol radar. It reads a sealed DefiLlama snapshot (758 protocols, 40 on the watchlist, as of 2026-11-14), fits a quadratic size curve of log10(market cap) on log10(TVL) plus fitted growth and age terms with shrunk category adjustments across the 128 traded tokens at runtime, validates it with three held-out tests (leave-one-out median log error 0.56, 32.8% within 2x; repeated 80/20 split 0.552; walk-forward time-split 0.788), fits token-launch odds as a 0.5 logistic + 0.5 peer-record blend (5-fold CV AUC 0.733), and ranks all 342 pre-token protocols by implied value = fitted launch value x token odds. 256 rows are farmable and 86 exchange/bridge rows are flagged NOT FARMABLE with honest no-farm-path guidance. Each row carries a costed farm plan and a FARM/THIN/SKIP verdict from an expected-value rule (EV per $1,000 farmed = implied x 5e-6). A dark terminal-style dashboard shows the sortable, filterable board, a detail view per protocol, the 24 traded-token anchors, a model sandbox, and a research note. Deterministic: every run writes the same board bytes.

## Run it

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts --input /input/snapshot.json
```

Node 22+, standard library only, no network.

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>

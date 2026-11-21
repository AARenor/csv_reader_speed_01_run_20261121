# csv_reader_speed_01_run_20261121

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/AARenor/csv_reader_speed_01_run_20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/AARenor/csv_reader_speed_01_run_20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A dependency-free rewrite of make.fun's csv-reader 1.0.0 that answers exactly as it does — the same `{columns, rows, errors}` for every input, down to the error order and the padded and cut ragged rows — while reading the text in one pass of character codes and taking every field as a slice of the original text instead of a character-at-a-time concatenation. It was built by writing the broken-row policy out of the reference's own comments, then checking it against the vendored csv-reader on the practice cases and on 200,000 randomized adversarial texts, and tuning the cold start (a tiny warm-up over one text per branch) because the metric is the CPU time of a single process.

## Run it

```sh
node main.ts
# outside the grader's container the same program reads and writes two directories of your own:
MAKEFUN_INPUT_DIR=in MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>

# csv_reader_speed_01_run_20261121

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/AARenor/csv_reader_speed_01_run_20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/AARenor/csv_reader_speed_01_run_20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A dependency-free drop-in for make.fun's csv-reader 1.0.0: `solve.js` exports `run(input)`, which returns exactly
the `{columns, rows, errors}` csv-reader returns for one case's `{text, header}` — the same cells, the same padded
and cut ragged rows, the same errors in the same order, `line` and `row` included.

## How it is faster

The harness hands the entry `/input/cases.json` and takes `/output/answers.json`, so the reader never needs a
JavaScript string at all:

- `main.ts` reads `cases.json` as bytes and `solve.js` scans the **JSON-escaped bytes of each case's text where
  they sit**. JSON escapes exactly the characters a CSV reader cares about (`"` is `\"`, a line break is `\n` or
  `\r`), and a run of escaped bytes is already the exact JSON text of the value it spells, so a field is copied
  from the input to the output without being decoded, and no object, array or string is ever built for the
  answers. No `JSON.parse` of the 11 MB input, no `JSON.stringify` of the 12 MB output, no per-field `slice`.
- The whole file is answered in one pass and written with one `writeFileSync` of the finished buffer.
- Each field reader is a small function of its own (`plainInto`, `quotedInto`), and every rare branch (a stray CR
  to drop, a doubled quote, a line break inside quotes, junk after a closing quote, a quote that never closes) is
  on its own path, so V8 keeps the loops that meet hundreds of thousands of fields compiled. A tiny warm-up at
  module load walks every branch once before the real cases, so no case pays for a deoptimisation mid-scan.
- V8's incremental marking is off before `solve.js` is imported, as the house baseline does.

`run(input)` is the same reader over a single case, kept for the entry's contract; `main.ts` uses the
whole-file `answersJson()`.

## Measured speed

Method: `node main.ts` per run on the practice set (`kit/practice/input/cases.json`, 6 cases, 10,193,953
characters of CSV, 63,692 rows and 1,770 errors in the answers), fresh output directory, CPU time =
`process.resourceUsage()` user + system of that process at exit, runs in a rotated order, median, the whole
process pinned to **one CPU** with `taskset -c 0` to match the grader's 1 CPU container, on an otherwise idle
machine. The same harness measures this entry and the house baseline in the same heat:

| runtime | this entry (median CPU) | csv-reader 1.0.0 baseline | speedup |
|---|---|---|---|
| Node v22.23.5 (the runtime `RULES.txt` names for the graded runs) | **197.8 ms** (190.3 to 206.8) | 1129.9 ms (1082.1 to 1150.0) | **5.7x** |
| Node v24.22.3 | 191.7 ms (185.2 to 197.9) | 1155.9 ms (1148.1 to 1174.3) | 6.0x |
| Node v26.13.1 | 200.6 ms (193.6 to 209.2) | 1111.3 ms (1092.2 to 1137.8) | 5.5x |

Nine runs per entry per runtime on Node 22 and 26, five on Node 24. Every answer was identical to
`kit/practice/reference/expected.json` on all 6 cases in every one of those runs.

An earlier revision of this file quoted 8.1x and 8.0x. Those runs were made while the machine was building other
jobs, which slowed the baseline to 1607 to 1660 ms; on an idle 1 CPU machine the baseline is about 1130 ms and the
honest figure is 5.5x to 6.0x. The entry's own time barely moved (191 to 201 ms across runtimes), so the whole
difference was the machine, not the reader.

The reader was also checked for correctness beyond the practice set: against the vendored csv-reader 1.0.0 on 60
more generated cases (the kit's own generator, 10 more draws) and on 9,200 random broken texts (embedded newlines,
doubled quotes, CRLF, lone CRs, empty fields, trailing commas, BOMs, characters outside Latin-1, junk after a
closing quote, quotes that never close): every answer identical.

## Run it

```sh
node main.ts
# outside the grader's container the same program reads and writes two directories of your own:
MAKEFUN_INPUT_DIR=in MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>

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
`process.resourceUsage()` user + system of that process at exit, 9 runs each in a rotated order, median:

| entry | median CPU | min | max |
|---|---|---|---|
| csv-reader 1.0.0, the house baseline | 1607.4 ms | 1560.5 ms | 1692.1 ms |
| this repository's previous commit (5dcc858) | 414.4 ms | 401.6 ms | 438.1 ms |
| this entry | **198.7 ms** | 188.2 ms | 208.0 ms |

That is **8.1x faster than the house baseline** (8.5x in an earlier session on the same machine) and 2.1x faster
than the previous commit, with every answer identical as a JSON value. The same 6 cases were checked against
`kit/practice/reference/expected.json`, and the reader was checked against the vendored csv-reader 1.0.0 on 60
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

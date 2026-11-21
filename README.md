# csv_reader_speed_01_run_20261121

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/AARenor/csv_reader_speed_01_run_20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/AARenor/csv_reader_speed_01_run_20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A dependency-free drop-in for make.fun's csv-reader 1.0.0: `solve.js` exports `run(input)`, which returns exactly
the `{columns, rows, errors}` csv-reader returns for one case's `{text, header}` — the same cells, the same padded
and cut ragged rows, the same errors in the same order, `line` and `row` included. `main.ts` answers the harness's
whole `/input/cases.json` into `/output/answers.json` with `main()` from `solve.js`, the same reader.

## How it is fast

The work that counts is the entry's own CPU time, net of a do-nothing entry, on one CPU. Node's start is the same
for everyone, so what is left is reading 11 MB, writing 12.5 MB, the scan itself, and V8 compiling the scan.

- **No strings, no JSON parse.** `cases.json` is read as bytes and each case's text is scanned where it sits, still
  JSON-escaped. JSON escapes exactly the characters a CSV reader cares about (`"` is `\"`, a line break is `\n` or
  `\r`), and a run of escaped bytes is already the JSON text of the value it spells, so every field is copied from
  input bytes to output bytes. No `JSON.parse`, no `JSON.stringify`, no object, array or string per row or field.
- **Little fresh memory.** The input goes through one reused 256 KB window (refilled between records; a record
  that runs past the window is read again after a refill, or a larger window) and the answers go out through one
  reused output buffer, written with `writeSync` between records. The process never touches megabytes of new
  pages, which a sandbox like gVisor makes costly. The header flag comes *after* the text in `cases.json`, so the
  first record is written between two reserved gaps of fixed size that are filled at the end of the case (padded
  with JSON whitespace) once the flag is known; errors are kept as numbers and written at the end of the case.
- **Four bytes a step.** The field readers read the text as 32-bit words through a `DataView`, find the first
  comma, backslash or quote in a word with the zero-byte bit trick (the lowest flagged byte is always a real one),
  and store the word as it is; a plain field runs on through commas in the same call.
- **Compiled once, on purpose.** The scan is four small functions. `main.ts` sets V8 flags before importing
  `solve.js`: natives syntax, no inlining, no loop peeling, no concurrent OSR. A tiny warm-up walks every branch of
  the policy through a tiny window (refill, restart, growth and flush included), then the four readers are marked
  with `%OptimizeFunctionOnNextCall`: each is compiled once, synchronously, at its first call on the real input,
  from the warm-up's feedback. No on-stack replacement of a big loop, no background compile while slow code scans
  on the same CPU, and the helpers that run only a few thousand times (error writing, padding) are never compiled.
  Without the flag (`solve.js` imported on its own) the `new Function` that holds the natives call throws and V8
  tiers up by itself; the answers are the same either way.
- **Any spelling of the input.** Anything that is not the plain `JSON.stringify` layout the harness writes (a
  `\uXXXX` escape that spells a quote, comma or line break, other keys, whitespace) is answered by the same reader
  after `JSON.parse` and a canonical re-spelling of each case.

## Measured speed

Method: `node <entry>/main.ts` per run on the practice set (`kit/practice/input/cases.json`: 6 cases, 11,064,623
bytes, 10,193,953 characters of CSV; 63,692 rows and 1,770 errors in the reference answers), Node **v22.23.5** (the
grader's Node 22), the process pinned to **one CPU** (`taskset -c 3`), a fresh output directory per run. CPU time =
user + system of the whole child process (all its threads) read by the parent with `wait4`. A null entry (a
`main.ts` that reads nothing and writes `[null,null,null,null,null,null]`) runs in every round, as the grader's
control does; **net = median gross − median gross of the null entry**. Entries run in a rotated order in each round.

Nine rounds:

| entry | median gross CPU | median net CPU | net vs. csv-reader |
|---|---|---|---|
| null entry | 71.1 ms | 0 | |
| csv-reader 1.0.0 (house baseline) | 1163.0 ms | 1091.9 ms | 1x |
| this entry before this pass (commit 35f1836) | 202.9 ms | 131.8 ms | 8.3x |
| **this entry** | **142.3 ms** | **71.2 ms** | **15.3x** |

A second session of 15 rounds gave 202.2 / 130.7 ms (before) and 142.5 / 71.0 ms (this entry), gross / net.
Every answer in every run was identical to `kit/practice/reference/expected.json`. These are this machine's
numbers; the grader's sandbox is slower, so its figures are higher.

Where the net time goes (same machine): about 16 ms of V8 compiling the four readers, about 30 ms of scanning,
and 10 to 15 ms of system time (reading 11 MB, writing 12.5 MB, page faults).

## Checked against csv-reader 1.0.0

- The practice set through the kit's own scorer, and `makefun grade-local --driver docker` (the grader's image):
  6 of 6 cases, "L1 regrade reproduced byte for byte".
- 20 more sets drawn with the kit's own generator (120 cases; 10 of the 20 sets are fresh draws made for this
  pass), answered by `main.ts` and checked with the kit's scorer against the vendored csv-reader 1.0.0: all pass.
- 104,076 random broken texts in 8,400 `cases.json` files read through windows of 64 bytes to 256 KB (so every
  refill, record restart, window growth and output flush runs), about 30% of the files re-spelled with random `\uXXXX`
  escapes of any character, `\/`, whitespace and swapped keys: BOMs, CRLF, lone CRs inside and outside quotes,
  doubled quotes, junk after a closing quote, quotes that never close, blank lines, short and long rows, header true
  and false, control characters, lone surrogates, astral and non-Latin-1 characters. Plus 12,000 texts through
  `run()` and 1,200 through `main.ts` as separate processes. Every answer identical.

## Run it

```sh
node main.ts
# outside the grader's container the same program reads and writes two directories of your own:
MAKEFUN_INPUT_DIR=in MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>

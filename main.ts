// main.ts — the program the harness runs (node22): `node /bot/main.ts`. It reads every case from /input/cases.json,
// answers each one with run() from solve.js, and writes /output/answers.json, a JSON array of the answers in the
// cases' order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// Two things make it faster than the house driver without changing a byte of what it writes:
//   - V8's incremental marking is off before solve.js is imported (as the house baseline does), so the whole scan
//     runs under the same collector setting the baseline is timed with;
//   - the answers are serialised one case at a time and written straight out, instead of building every answer,
//     one 12 MB JSON string and then a copy of it: the array is still written as '[' + case joins + ']', the exact
//     bytes JSON.stringify of the whole array would write, but without the intermediate string and its copy.

import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];

const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
try {
  writeSync(fd, '[');
  for (let i = 0; i < cases.length; i++) {
    if (i > 0) writeSync(fd, ',');
    writeSync(fd, JSON.stringify(run(cases[i]!.input)));
  }
  writeSync(fd, ']');
} finally {
  closeSync(fd);
}

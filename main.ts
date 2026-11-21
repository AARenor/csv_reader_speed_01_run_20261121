// main.ts — the program the harness runs (node22): `node /bot/main.ts`. It reads every case from /input/cases.json,
// answers them all with answersJson() from solve.js, and writes /output/answers.json, the JSON array of the answers
// in the cases' order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// The file is read as bytes and answered as bytes: solve.js scans each case's text where it sits in the JSON
// (escaped, but escaped with exactly the characters a CSV reader cares about), so nothing is parsed into strings
// and the whole answers file is built once and written once.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its work runs under it (the rules: the house
// baseline runs with --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { answersJson } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  answersJson: (cases: Buffer) => Buffer;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

writeFileSync(join(OUTPUT_DIR, 'answers.json'), answersJson(readFileSync(join(INPUT_DIR, 'cases.json'))));

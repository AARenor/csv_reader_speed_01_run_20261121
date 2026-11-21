// node /bot/main.ts: answers /input/cases.json into /output/answers.json with solve.js (see its header).
// V8 flags first, so they hold for all of solve.js: compile on the main thread (one CPU: a background compile only
// competes with the scan it is compiling for) and keep each small reader its own compilation unit.
import { setFlagsFromString } from 'node:v8';
setFlagsFromString('--no-concurrent-osr');
setFlagsFromString('--no-concurrent-recompilation');
setFlagsFromString('--no-turbo-inlining');
const { main } = await import('./solve.js');
main(process.env.MAKEFUN_INPUT_DIR ?? '/input', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// node /bot/main.ts: answers /input/cases.json into /output/answers.json with solve.js (see its header).
// V8 flags first, so they hold for all of solve.js: natives syntax, so solve.js can have its few hot readers
// compiled synchronously right after its warm-up (and the rest never), and no inlining, so each reader stays a
// small compilation unit of its own.
import { setFlagsFromString } from 'node:v8';
setFlagsFromString('--allow-natives-syntax');
setFlagsFromString('--no-concurrent-osr');
setFlagsFromString('--no-turbo-inlining');
const { main } = await import('./solve.js');
main(process.env.MAKEFUN_INPUT_DIR ?? '/input', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

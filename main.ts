// node /bot/main.ts: answers /input/cases.json into /output/answers.json with solve.js (see its header).
// V8 flags first, so they hold for all of solve.js: natives syntax, so solve.js can have its few hot readers
// compiled synchronously right after its warm-up (and the rest never); no inlining and no loop peeling, so each
// reader stays a small compilation unit that compiles in a few milliseconds.
// No ESM `import` of a builtin: each one builds an ESM facade at a few ms of CPU. The flags are set through V8's
// own binding (its deprecation notice silenced), else through node:v8 from the builtin registry.
process.noDeprecation = true;
let setFlags: (flag: string) => void;
try {
  const binding = process.binding('v8') as { setFlagsFromString: (flag: string) => void };
  setFlags = (flag) => binding.setFlagsFromString(flag);
} catch {
  const v8 = process.getBuiltinModule('node:v8');
  setFlags = (flag) => v8.setFlagsFromString(flag);
}
setFlags('--allow-natives-syntax');
setFlags('--no-concurrent-osr');
setFlags('--no-turbo-inlining');
setFlags('--no-turbo-loop-peeling');
const { main } = await import('./solve.js');
main(process.env.MAKEFUN_INPUT_DIR ?? '/input', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

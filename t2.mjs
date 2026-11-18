import PluginTransport from './node_modules/@eniac/flexdesigner/dist/transport.js';
// Apply the SAME workaround the plugin applies (runtime.js:464-468)
const t = new PluginTransport('uid-x', 59999);
const bound = t.start.bind(t);
Object.defineProperty(bound, '__flexbarBound', { value: true });
t.start = bound;

let starts = 0;
const orig = t.start.bind(t);
t.start = function (...a) { starts++; return orig(...a); };
// simulate plugin's own wrapper around bound start
const b2 = t.start;
t.start = function (...a) { starts++; return b2(...a); };

t.start();
setTimeout(() => { console.log('RESULT: start() calls after 26s =', starts); process.exit(0); }, 26000);

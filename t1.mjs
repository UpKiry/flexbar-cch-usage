import PluginTransport from './node_modules/@eniac/flexdesigner/dist/transport.js';
import { WebSocketServer } from 'ws';

let sockets = 0;
const t = new PluginTransport('uid-x', 59999); // nothing listening -> ECONNREFUSED
const orig = t.start.bind(t);
let starts = 0;
t.start = function (...a) { starts++; console.log('start() call #' + starts, 'at', new Date().toISOString()); return orig(...a); };
t.start();
setTimeout(() => { console.log('TOTAL start() calls in 12s =', starts); process.exit(0); }, 12000);

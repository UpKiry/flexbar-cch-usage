import { createPluginRuntime } from './src/runtime.js';
// Simulate: host socket CLOSED -> plugin.getConfig() never settles (SDK timeout 0)
const plugin = {
  on(){}, start(){},
  async getConfig(){ return new Promise(() => {}); },  // never settles, like SDK timeout-0 call on a dead socket
  async setConfig(){ return {}; },
  async draw(){ return {}; },
};
const logger = { info(){}, warn(){}, error(){}, debug(){} };
const runtime = createPluginRuntime({ plugin, logger, configStorePath: '/nonexistent/x.json' });
runtime.start();
await new Promise(r=>setTimeout(r,300));
await runtime.handlers.alive({ serialNumber: 'A', keys: [{cid:'com.upkiry.flexbarcchusage.quota', uid:1, width:240, data:{range:'5h',metric:'quotaStatus'}}] });
console.log('after alive: refreshing =', runtime.getState().refreshing, '(true => refresh never settles)');
// a later click must not be able to start a new refresh
await runtime.handlers.data({ serialNumber:'A', data:{ evt:'click', key:{cid:'com.upkiry.flexbarcchusage.quota', uid:1, width:240, data:{range:'5h',metric:'quotaStatus'}} } });
await new Promise(r=>setTimeout(r,300));
console.log('after click: refreshing =', runtime.getState().refreshing, '| drawn signatures =', runtime.getState().fingerprintCount);
process.exit(0);

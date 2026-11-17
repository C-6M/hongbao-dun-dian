'use strict';
// DNS metadata only: TCP-check local resolver answers on the cloud without sending credentials.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { publicIPv4, sampleCandidates } = require('./node-health');
const root = '/data/hongbao', dir = root + '/proxy';
function tcp(address, port) {
  return new Promise(resolve => {
    const started = Date.now(), socket = net.createConnection({host:address,port});
    let done = false;
    const finish = ok => { if(done)return; done=true; socket.destroy(); resolve({ok,elapsedMs:Date.now()-started}); };
    socket.setTimeout(4000,()=>finish(false));
    socket.once('connect',()=>finish(true)); socket.once('error',()=>finish(false));
  });
}
async function main() {
  if(process.platform!=='linux'||path.resolve(__dirname,'..')!==root)throw new Error('Cloud install required');
  const config=JSON.parse(fs.readFileSync(dir+'/config.yaml','utf8'));
  const ledger=JSON.parse(fs.readFileSync(dir+'/node-health-ledger.json','utf8'));
  const payload=JSON.parse(fs.readFileSync(0,'utf8'));
  if(Object.keys(payload).length!==1||!Array.isArray(payload.nodes)||payload.nodes.length!==4
    ||new Set(payload.nodes.map(row=>row.index)).size!==4)throw new Error('Four candidate hints required');
  const nodes=payload.nodes.map(row=>{
    const node=config.proxies[row.index-1], source=ledger.sources[node?.name];
    if(row.index<9||row.index>12||!node||!source||source.server!==row.server||node.port!==row.port
      ||node.type!==row.type||!Array.isArray(row.addresses)||row.addresses.length>6
      ||row.addresses.some(address=>!publicIPv4(address)))throw new Error('Hint does not match an authorized original endpoint');
    return {index:row.index,name:node.name,server:row.server,port:row.port,type:row.type};
  });
  const rows=await sampleCandidates(nodes,{tcp,resolve:async host=>[{source:'local-system-dns',
    addresses:payload.nodes.filter(row=>row.server===host).flatMap(row=>row.addresses.map(address=>({address})))}]});
  console.log(JSON.stringify({at:new Date().toISOString(),localDnsAnswers:payload.nodes.length,
    cloudTcpPassed:rows.filter(row=>row.candidates.length).map(row=>row.index),
    additionalRetestPossible:rows.some(row=>row.index>9&&row.candidates.length),
    rows:rows.map(row=>({index:row.index,tcpCandidates:row.candidates.length})),
    apiQueriesMade:false,privateDataPrinted:false}));
}
if(require.main===module)main().catch(()=>{console.error('Local DNS cross-check failed; private details suppressed');process.exitCode=1;});

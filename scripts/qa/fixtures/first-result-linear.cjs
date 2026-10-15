#!/usr/bin/env node
// Synthetic read-only issue source for the first-result Electron acceptance journey.
const readline = require('node:readline');
const issues = [
  { id: 'QA-101', title: 'Shorten first-run setup', state: 'Done', project: 'First result', assignee: 'Test operator' },
  { id: 'QA-102', title: 'Preserve the request during connector setup', state: 'In Progress', project: 'First result', assignee: 'Test operator' },
  { id: 'QA-103', title: 'Verify the saved project update', state: 'Blocked', project: 'First result', blocker: 'Waiting for artifact readback', assignee: 'Test operator' },
];
const tools = [{ name: 'linear_list_issues', description: 'Read synthetic Linear issues for the First result QA project. This local fixture never changes external data.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }];
readline.createInterface({input:process.stdin}).on('line', (line) => {
  const request=JSON.parse(line);
  if(request.id===undefined)return;
  let result;
  if(request.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'linear-first-result-qa',version:'1.0.0'}};
  else if(request.method==='mcp/discover')result={name:'linear-first-result-qa',version:'1.0.0',protocolVersion:'2024-11-05',capabilities:{tools:{}}};
  else if(request.method==='tools/list')result={tools};
  else if(request.method==='tools/call' && request.params.name==='linear_list_issues')result={content:[{type:'text',text:JSON.stringify({source:'Local synthetic QA fixture',project:'First result',issues})}]};
  else if(request.method==='ping')result={};
  else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Unsupported fixture method'}})+'\n');return;}
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});

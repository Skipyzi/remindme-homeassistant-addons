// Real Codex/Pi/OpenCode and a Claude fixture against simulated inference and Home Assistant.
// No live credentials, provider requests or physical device calls.
const assert=require('node:assert/strict');const fs=require('node:fs'); const os=require('node:os'); const path=require('node:path');
const base=process.cwd(); const directory=fs.mkdtempSync(path.join(os.tmpdir(),'remindme-native-smoke-'));
process.env.AGENT_DATA_DIR=directory;process.env.CLAUDE_CONFIG_DIR=path.join(directory,'claude');process.env.CLAUDE_CLI_PATH=path.join(directory,'claude-fixture.cjs');fs.copyFileSync(path.join(base,'eval/claude-native-fixture.cjs'),process.env.CLAUDE_CLI_PATH);fs.chmodSync(process.env.CLAUDE_CLI_PATH,0o755);process.env.CHATGPT_AUTH_PATH=path.join(directory,'unused-auth.json');
const express=require(path.join(base,'node_modules/express'));
const {AgentRuntime}=require(path.join(base,'dist/agent/runtime'));
const {chatgptAuth}=require(path.join(base,'dist/harness/chatgptAuth'));
chatgptAuth.accessToken=async()=> 'fixture-token-never-sent-remotely';
const realFetch=global.fetch;let requests=[];let failures=0;let currentBackend='';
function sse(body){
 const hasOutput=(body.input||[]).some(i=>i.type==='function_call_output');
 const item=hasOutput ? {type:'message',id:'msg_test',role:'assistant',status:'completed',content:[{type:'output_text',text:'The fixture house has no connected lights.',annotations:[]}]} : {type:'function_call',id:'fc_test',call_id:'call_test',name:body.tools?.find(t=>t.name?.endsWith('home_entities'))?.name || 'home_entities',arguments:'{}',status:'completed'};
 const response={id:'resp_test',object:'response',created_at:1,status:'completed',model:'gpt-5.6-luna',output:[item],usage:{input_tokens:10,output_tokens:10,total_tokens:20,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
 const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:hasOutput? {...item,content:[]}:{...item,arguments:''}}];
 if(hasOutput) events.push({type:'response.content_part.added',output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',output_index:0,content_index:0,delta:item.content[0].text},{type:'response.output_text.done',output_index:0,content_index:0,text:item.content[0].text},{type:'response.content_part.done',output_index:0,content_index:0,part:item.content[0]});
 else events.push({type:'response.function_call_arguments.delta',output_index:0,delta:'{}'},{type:'response.function_call_arguments.done',output_index:0,arguments:'{}'});
 events.push({type:'response.output_item.done',output_index:0,item},{type:'response.completed',response});
 return new Response(events.map((event,i)=>`event: ${event.type}\ndata: ${JSON.stringify({...event,item_id:'msg_test',sequence_number:i})}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
}
global.fetch=async(input,init)=>{const url=String(input);if(url==='https://api.openai.com/v1/responses'){const body=JSON.parse(init.body);requests.push(body);if(currentBackend==='codex'){assert.ok(body.tools.some(t=>t.name==='home_entities'),'Codex must advertise the dynamic home tools to the model');assert.ok(!body.input.some(i=>i.type==='additional_tools'),'Codex coding tool catalogs must not reach the model');}return sse(body);} return realFetch(input,init);};
const deps=()=>({endpoint:()=>({url:new URL('https://api.openai.com/v1/responses'),authProvider:'chatgpt',model:'gpt-5.6-luna',headers:{'Content-Type':'application/json'},openaiCompat:true,label:'Fixture'}),activeModel:async()=>({}),contextSize:32768,systemPrompt:()=> 'You are a home assistant. Read devices using home_entities and answer briefly.',recall:()=>[],home:{cards:async()=>[],card:async()=>undefined,service:async()=>{throw Error('No physical service calls allowed');}},holdAction:()=> 'unused',holdReminder:()=> 'unused',listReminders:async()=>[],mcpTools:async()=>[],artifacts:{},features:{reminders:true,parcels:false}});
const app=express();app.use(express.json({limit:'2mb'}));const runtime=new AgentRuntime(deps,0);runtime.register(app);
(async()=>{
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));runtime.port=server.address().port;
 try{for(const backend of ['codex','claude','pi','opencode']){
  currentBackend=backend;runtime.store.configure({backend});let events=[];requests=[];const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),45000);
  try {await runtime.run({conversationId:`fixture-${backend}`,prompt:'Read the available lights and tell me what you found.',thinkingMode:'low',requestId:'fixture',attachments:[],history:[],openArtifactId:'',signal:controller.signal},(event,data)=>events.push({event,data}));
   const answer=events.findLast(e=>e.event==='answer'); assert.match(answer?.data.text||'',/fixture house/);assert.ok(events.some(e=>e.event==='tool_complete'&&e.data.name==='home_entities'),'The native client must actually execute a home tool');console.log(JSON.stringify({backend,success:true,requests:requests.length,toolCalls:events.filter(e=>e.event==='tool_complete').map(e=>e.data.name),answer:answer?.data.text,advertisedTools:requests[0]?.tools?.map(t=>t.name||t.type)}));
   events=[];await runtime.run({conversationId:`fixture-${backend}`,prompt:'And what did you find last time?',thinkingMode:'low',requestId:'fixture2',attachments:[],history:[],openArtifactId:'',signal:controller.signal},(event,data)=>events.push({event,data})); console.log(JSON.stringify({backend,resumed:true,answer:events.findLast(e=>e.event==='answer')?.data.text}));
  }catch(error){failures++;console.log(JSON.stringify({backend,success:false,error:error.message,requests:requests.length,advertisedTools:requests[0]?.tools?.map(t=>t.name||t.type)}));}finally{clearTimeout(timer);}
 }}finally{server.closeAllConnections();server.close();global.fetch=realFetch;process.exitCode=failures?1:0; fs.rmSync(directory,{recursive:true,force:true});}
})();

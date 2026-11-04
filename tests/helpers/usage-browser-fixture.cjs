// Isolated accounts and metadata only. Never connects to a model provider.
const {createServer,cloudRuntime:cloud}=require('../../server');
(async()=>{
 const owner=cloud.data.users[0];await cloud.createUser({identity:{user:owner}},{username:'alice',password:'fixture-password-123'});
 const alice=cloud.data.users.find(user=>user.username==='alice');
 for(const [user,source,model,status,usage] of [[owner,'chatgpt','gpt-owner','success',{input_tokens:1200,output_tokens:300}],
 [alice,'chatgpt','gpt-luna','success',{input_tokens:450,output_tokens:100}],
 [alice,'platform','free-model','failed',null],[alice,'personal','private-model','cancelled',null]]){
  const session={userId:user.id,hash:'fixture-'+user.id,expires:Date.now()+60000};cloud.change(data=>data.sessions.push(session));
  const options=cloud.callOptions({identity:{user,session}},source,'fixture',model),id=options.beforeCall();
  const error=status==='success'?null:status==='cancelled'?new DOMException('Aborted','AbortError'):{code:'fixture-failure'};
  options.afterCall(id,{usage},error);
 }
 const app=createServer();app.listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('USAGE_FIXTURE_READY'));
})().catch(error=>{console.error(error.message);process.exit(1);});

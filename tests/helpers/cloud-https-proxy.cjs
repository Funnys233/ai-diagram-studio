const fs=require('node:fs'),http=require('node:http'),https=require('node:https');
const server=https.createServer({key:fs.readFileSync(process.env.DIAGRAM_TEST_TLS_KEY),cert:fs.readFileSync(process.env.DIAGRAM_TEST_TLS_CERT)},(req,res)=>{
 const upstream=http.request('http://127.0.0.1:8276'+req.url,{method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);response.on('error',()=>res.destroy());});
 upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});
});server.listen(8277,'127.0.0.1',()=>process.send?.('ready'));
process.once('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});

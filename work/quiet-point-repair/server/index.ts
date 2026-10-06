import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { roomSchema,sessionSchema,type Source,type State } from '../shared/model.js';
import { newSession,closeSession,saveBatch,roomViews,history,actions,startAction,finishAction,tickDemo,setDemoQuiet,demoQuiet } from './store.js';
import { mountStudyRoutes } from './study-routes.js';
const app=express();app.use(express.json({limit:'64kb'}));
const sourceSchema=z.enum(['demo','microphone']);
const source=(x:unknown):Source=>sourceSchema.parse(x??'demo');
const snapshot=(s:Source):State=>{const now=Date.now();return {now,source:s,rooms:roomViews(s,now),actions:actions(s,now),demoQuiet};}; // §4.2：一个响应内共用同一 now，避免跨边界
app.get('/api/state',(req,res)=>res.json(snapshot(source(req.query.source))));
app.get('/api/rooms/:roomId/history',(req,res)=>res.json(history(roomSchema.parse(req.params.roomId),source(req.query.source))));
app.post('/api/sessions',(req,res)=>{const s=sessionSchema.parse(req.body);res.status(201).json({id:newSession(s.roomId,s.baselineDbfs,s.processing)});});
app.post('/api/sessions/:id/end',(req,res)=>{closeSession(z.string().uuid().parse(req.params.id));res.json({ok:true});});
app.post('/api/samples/batch',(req,res)=>{const body=z.object({samples:z.array(z.unknown()).min(1).max(60)}).strict().parse(req.body);const ids=saveBatch(body.samples);res.json({acceptedIds:ids});broadcast();});
app.post('/api/actions',(req,res)=>{const b=z.object({roomId:roomSchema,source:sourceSchema}).strict().parse(req.body);res.status(201).json({id:startAction(b.roomId,b.source)});broadcast();});
app.post('/api/actions/:id/finish',(req,res)=>{finishAction(z.string().uuid().parse(req.params.id));res.json({ok:true});broadcast();});
app.post('/api/demo',(req,res)=>{const b=z.object({quiet:z.boolean()}).strict().parse(req.body);setDemoQuiet(b.quiet);tickDemo();res.json({ok:true});broadcast();});
const listeners=new Set<{res:express.Response;source:Source}>();
app.get('/api/events',(req,res)=>{const s=source(req.query.source);res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();res.write(`data: ${JSON.stringify(snapshot(s))}\n\n`);const item={res,source:s};listeners.add(item);req.on('close',()=>listeners.delete(item));});
function broadcast(){for(const item of listeners)item.res.write(`data: ${JSON.stringify(snapshot(item.source))}\n\n`);}
// 阶段三：学习数据七接口（§5）。挂在既有路由之后、最终错误处理之前；非学习路径的错误原样交回。
// [总控裁定 2026-10-03 已满足] 曾因 acoustic-map.ts 的 __ACOUSTIC_MAP_CSV__ 占位符在 tsc+node 路径上无法替换而
// 摘除挂载（index→study-routes→study-store→study-model→acoustic-map 启动期抛 ACOUSTIC_MAP_BAD_HEADER）。
// 现按裁定改用**服务端本地常量**（shared/study-model.ts 自带 12 类字面量与 MAP_VERSION），
// 该 import 链不再触达 acoustic-map，故恢复挂载；Node 侧加载已验证（见 REPAIR_AI_PHASE3_REPORT.md）。
mountStudyRoutes(app);
setInterval(()=>{tickDemo();broadcast();},5000).unref();
if(existsSync(resolve('dist/index.html'))){app.use(express.static(resolve('dist')));app.get('/',(_req,res)=>res.sendFile(resolve('dist/index.html')));}
app.use((err:Error,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{res.status(400).json({error:err.message});});
// 云端合并部署（cloud/merged-server.mjs）要把本 app 挂进**同一个进程、同一个端口**：
// 于是导出 app，并把 listen 收进「直接运行入口」守卫——写法与 addons/main.ts 的 isMain 完全一致。
// 直跑 `node .runtime/server/index.js` 的行为与改动前**逐字一致**：仍监听 HOST??127.0.0.1、PORT??3001。
// 路由、鉴权、上传路径、主库 schema 一律未动（本文件只多出这两处结构改动）。
export { app };
const host=process.env.HOST??'127.0.0.1';const port=Number(process.env.PORT??3001);
const isMain=process.argv[1]!==undefined&&/(?:^|[\\/])index\.(?:js|ts)$/.test(process.argv[1]);
if(isMain)app.listen(port,host,()=>console.log(`静点后端：http://${host}:${port}`));

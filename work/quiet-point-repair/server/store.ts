import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rooms, RULES, type Source, type Sample, type RoomId, type RoomView, type Action } from '../shared/model.js';
import { median,round,parseSampleShape,assertReceiveRange } from './core.js';
const dataDirectory=process.env.QUIET_DATA_DIR??'data';
mkdirSync(dataDirectory,{recursive:true});
export const db=new DatabaseSync(join(dataDirectory,'quiet.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,roomId TEXT NOT NULL,source TEXT NOT NULL,baseline REAL NOT NULL,processing TEXT NOT NULL,createdAt INTEGER NOT NULL,closedAt INTEGER);
CREATE TABLE IF NOT EXISTS samples(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL,capturedAt INTEGER NOT NULL,receivedAt INTEGER NOT NULL,dbfs REAL NOT NULL,clipped INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS samples_session_time ON samples(sessionId,capturedAt);
CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY,roomId TEXT NOT NULL,sessionId TEXT NOT NULL,source TEXT NOT NULL,startedAt INTEGER NOT NULL,endedAt INTEGER,before REAL NOT NULL,after REAL,beforeCount INTEGER NOT NULL,afterCount INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'observing');`);
// ---- 迁移（契约 §4.3）：可重跑、保历史、单一时钟；失败即让启动失败，绝不在半迁移 schema 上监听 ----
function migrateActions(now:number):void{
  const cols=(db.prepare('PRAGMA table_info(actions)').all() as {name:string}[]).map(c=>c.name);
  const version=Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version??0);
  if(version>2)throw Error(`不支持的数据库版本 ${version}：请用匹配版本的应用打开`);
  if(version===2){if(!cols.includes('status'))throw Error('数据库版本与列结构不一致：actions.status 缺失');return;}
  db.exec('BEGIN');
  try{
    if(!cols.includes('status'))db.exec("ALTER TABLE actions ADD COLUMN status TEXT NOT NULL DEFAULT 'observing'");
    // 先回填旧完成记录，再清扫；否则 DEFAULT observing 会把已完成行动重新变成占位。
    db.prepare("UPDATE actions SET status='completed' WHERE endedAt IS NOT NULL AND status='observing'").run();
    db.prepare(`UPDATE actions SET status='expired' WHERE status='observing' AND endedAt IS NULL AND (startedAt < ? - 300000 OR EXISTS (SELECT 1 FROM sessions s WHERE s.id=actions.sessionId AND s.closedAt IS NOT NULL AND ? > s.closedAt + 60000))`).run(now,now);
    db.exec('PRAGMA user_version=2');
    db.exec('COMMIT');
  }catch(err){db.exec('ROLLBACK');throw err;}
}
migrateActions(Date.now());
export function newSession(roomId:RoomId,baseline:number,processing:string,source:Source='microphone',now=Date.now()):string {const id=randomUUID();db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,NULL)').run(id,roomId,source,baseline,processing,now);return id;}
export function closeSession(id:string,now=Date.now()):void {db.prepare('UPDATE sessions SET closedAt=COALESCE(closedAt,?) WHERE id=?').run(now,id);}
// 契约 §4.1（C）最终顺序：形状 → 批内去重与内容比较 → **既有 ID 全等即确认（不过任何动态门禁）**
// → 仅新 ID 过会话存在性/接收范围/会话窗口 → INSERT → COMMIT 后才 ACK。receiveNow 每次调用只取一次。
export function saveBatch(input:unknown[],now=Date.now()):string[]{
  const rows=input.map(x=>parseSampleShape(x));
  const byId=new Map<string,Sample>();
  for(const s of rows){
    const hit=byId.get(s.id);
    if(!hit){byId.set(s.id,s);continue;}
    if(hit.sessionId!==s.sessionId||hit.capturedAt!==s.capturedAt||hit.dbfs!==s.dbfs||hit.clipped!==s.clipped)throw Error('重复ID的内容不一致');
  }
  const ids=[...byId.keys()];
  db.exec('BEGIN');
  try{
    const confirmed=new Set<string>();
    for(const id of ids){
      const existing=db.prepare('SELECT sessionId,capturedAt,dbfs,clipped FROM samples WHERE id=?').get(id);
      if(!existing)continue;
      const s=byId.get(id)!;
      if(String(existing.sessionId)!==s.sessionId||Number(existing.capturedAt)!==s.capturedAt||Number(existing.dbfs)!==s.dbfs||Number(existing.clipped)!==Number(s.clipped))throw Error('重复ID的内容不一致');
      confirmed.add(id); // 已入库且内容全等：确认，不 INSERT / 不 UPDATE / receivedAt 不变 / 不再查会话或时间
    }
    for(const id of ids){
      if(confirmed.has(id))continue;
      const s=byId.get(id)!;
      const session=db.prepare('SELECT * FROM sessions WHERE id=?').get(s.sessionId);
      if(!session)throw Error('采样会话不存在');
      assertReceiveRange(s,now);
      if(s.capturedAt<Number(session.createdAt)-RULES.sessionCloseSkewMs)throw Error('采样不在会话时间内');
      if(session.closedAt!==null&&s.capturedAt>Number(session.closedAt)+RULES.sessionCloseSkewMs)throw Error('采样不在会话时间内');
      db.prepare('INSERT OR IGNORE INTO samples VALUES(?,?,?,?,?,?)').run(s.id,s.sessionId,s.capturedAt,now,s.dbfs,Number(s.clipped));
    }
    db.exec('COMMIT');
    return ids; // ACK 覆盖输入的去重 ID 集合，含被确认的历史 ID
  }catch(err){db.exec('ROLLBACK');throw err;}
}
function recentRows(roomId:RoomId,source:Source,now=Date.now()) {return db.prepare(`SELECT p.*,s.baseline,s.closedAt FROM samples p JOIN sessions s ON s.id=p.sessionId WHERE s.roomId=? AND s.source=? AND p.capturedAt>=? AND p.capturedAt<=? ORDER BY p.capturedAt DESC,p.id DESC`).all(roomId,source,now-15*60_000,now);}
export function roomViews(source:Source,now=Date.now()):RoomView[]{return rooms.map(room=>{const rows=recentRows(room.id,source,now);const latest=rows[0];const bySession=new Map<string,typeof latest>();for(const r of rows)if(r.closedAt===null&&now-Number(r.capturedAt)<RULES.staleMs&&Number(r.receivedAt)-Number(r.capturedAt)<=RULES.replayMs&&!bySession.has(String(r.sessionId)))bySession.set(String(r.sessionId),r);const fresh=[...bySession.values()];const changes=fresh.map(r=>Number(r.dbfs)-Number(r.baseline));return {...room,delta:changes.length?round(median(changes)!):null,online:fresh.length>0,terminalCount:fresh.length,ageSeconds:latest?Math.floor((now-Number(latest.capturedAt))/1000):null,latestDbfs:latest?Number(latest.dbfs):null,replayed:rows.filter(r=>Number(r.receivedAt)-Number(r.capturedAt)>RULES.replayMs).length,clipped:fresh.some(r=>Number(r.clipped)===1)};});}
export function history(roomId:RoomId,source:Source,now=Date.now()){return recentRows(roomId,source,now).map(r=>({time:Number(r.capturedAt),delta:round(Number(r.dbfs)-Number(r.baseline)),replay:Number(r.receivedAt)-Number(r.capturedAt)>RULES.replayMs})).reverse();}
// 契约 §4.2（D）：幂等清扫，只作用于 observing 且未结束的行动；两个条件都是严格 >。
export function reapActions(now=Date.now()):number{const r=db.prepare(`UPDATE actions SET status='expired' WHERE status='observing' AND endedAt IS NULL AND (startedAt < ? - 300000 OR EXISTS (SELECT 1 FROM sessions s WHERE s.id=actions.sessionId AND s.closedAt IS NOT NULL AND ? > s.closedAt + 60000))`).run(now,now);return Number(r.changes??0);}
export function actions(source:Source,now=Date.now()):Action[]{reapActions(now);return db.prepare('SELECT * FROM actions WHERE source=? ORDER BY startedAt DESC LIMIT 30').all(source).map(r=>{const a=r as unknown as Action;return {...a,change:a.after===null?null:round(a.after-a.before)};});}
function stats(sessionId:string,start:number,end:number){const rows=db.prepare('SELECT dbfs FROM samples WHERE sessionId=? AND capturedAt>=? AND capturedAt<=? ORDER BY capturedAt').all(sessionId,start,end);return {value:median(rows.map(r=>Number(r.dbfs))),count:rows.length};}
export function startAction(roomId:RoomId,source:Source,now=Date.now()):string {reapActions(now);if(db.prepare("SELECT id FROM actions WHERE roomId=? AND source=? AND status='observing'").get(roomId,source))throw Error('该空间已有进行中的行动');const latest=recentRows(roomId,source,now).find(r=>r.closedAt===null&&Number(r.receivedAt)-Number(r.capturedAt)<=RULES.replayMs);if(!latest||now-Number(latest.capturedAt)>=RULES.staleMs)throw Error('请先连接采样终端');const sessionId=String(latest.sessionId);const before=stats(sessionId,now-30_000,now);if(before.count<RULES.minSamples)throw Error('至少需要 3 条采样建立行动前基线');const id=randomUUID();db.prepare('INSERT INTO actions(id,roomId,sessionId,source,startedAt,before,beforeCount,status) VALUES(?,?,?,?,?,?,?,?)').run(id,roomId,sessionId,source,now,before.value!,before.count,'observing');return id;}
// 契约 §4.2：终态出口。expired 的写入必须先提交再抛业务错误，且绝不伪造 after/change。
export function finishAction(id:string,now=Date.now()):void {let a=db.prepare('SELECT * FROM actions WHERE id=?').get(id);if(!a)throw Error('行动不存在');reapActions(now);a=db.prepare('SELECT * FROM actions WHERE id=?').get(id);if(!a)throw Error('行动不存在');if(String(a.status)!=='observing')throw Error('行动已结束');if(now-Number(a.startedAt)<RULES.actionMinMs)throw Error('请继续观察，满 30 秒后完成');const after=stats(String(a.sessionId),Math.max(Number(a.startedAt),now-20_000),now);if(after.count>=RULES.minSamples){const r=db.prepare("UPDATE actions SET endedAt=?,after=?,afterCount=?,status='completed' WHERE id=? AND status='observing'").run(now,after.value!,after.count,id);if(Number(r.changes??0)!==1)throw Error('行动已结束');return;}const session=db.prepare('SELECT closedAt FROM sessions WHERE id=?').get(String(a.sessionId));if(session&&session.closedAt!==null){db.prepare("UPDATE actions SET status='expired' WHERE id=? AND status='observing'").run(id);throw Error('行动已中断，未形成有效后采样');}throw Error('同一终端的行动后采样不足，请继续观察');}
export let demoQuiet=false;
const demoIds=new Map<RoomId,string>();
for(const room of rooms){const existing=db.prepare("SELECT id FROM sessions WHERE roomId=? AND source='demo' ORDER BY createdAt DESC LIMIT 1").get(room.id);demoIds.set(room.id,existing?String(existing.id):newSession(room.id,-54,'演示生成器','demo',Date.now()-90_000));}
export function setDemoQuiet(v:boolean){demoQuiet=v;}
export function tickDemo(now=Date.now()){rooms.forEach((room,i)=>{const base=[12,5,1][i];const delta=(demoQuiet&&i===0?2:base)+Math.sin(now/5000+i)*0.6;saveBatch([{id:randomUUID(),sessionId:demoIds.get(room.id)!,capturedAt:now,dbfs:round(-54+delta),clipped:false}],now);});}
// 演示种子仅写到demo会话，不进入麦克风数据集；重启不重复种子。
if(Number(db.prepare("SELECT COUNT(*) AS n FROM samples p JOIN sessions s ON s.id=p.sessionId WHERE s.source='demo'").get()!.n)===0)for(let n=6;n>=1;n--)tickDemo(Date.now()-n*5000);

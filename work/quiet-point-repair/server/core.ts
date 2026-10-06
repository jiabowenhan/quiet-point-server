import { sampleSchema, type Sample } from '../shared/model.js';
export function median(values:number[]):number|null {if(!values.length)return null;const a=[...values].sort((x,y)=>x-y);const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}
/** 只校验单条样本的形状（五字段 / UUID / 正整数毫秒 / dbfs 范围 / boolean），不做任何相对 now 的动态范围判断。 */
export function parseSampleShape(input:unknown):Sample {return sampleSchema.parse(input);}
/** 新 ID 的接收范围（闭区间）：过去侧 24h、未来侧 +60s。已确认的历史 ID 不再过这道门禁。 */
export function assertReceiveRange(s:Sample,now=Date.now()):void {if(s.capturedAt>now+60_000||s.capturedAt<now-86_400_000)throw Error('采样时间超出接收范围');}
export function validateSample(input:unknown,now=Date.now()):Sample {const s=parseSampleShape(input);assertReceiveRange(s,now);return s;}
export function round(x:number):number{return Math.round(x*10)/10;}

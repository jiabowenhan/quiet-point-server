/**
 * F8-c（匿名「共同存在信号」）契约与**纯**函数。
 *
 * 权威口径（SCOPE_FINAL §23:35「隐私边界（硬性）」）：
 *  · **匿名**：不交换身份/设备标识 —— 响应用户 hash、**不返回**任何可指认的字段（无 owner、无 hash、
 *    无终端号、无名单、无时间戳）；
 *  · **只有房间级粗档**：『暂时只有你』/『另有 1 位』/『还有几位』——**永远不给精确人数**（≥2 一律同一档，
 *    连"到底是 2 还是 20"都推不出来）；
 *  · **双向 opt-in**：双方都开才互相可见；没开的人既看不见别人、也**不被计入**别人的视野；随时可关；
 *  · **短 TTL**：心跳过期即消失，**不形成"谁在这里"的监视面、不留历史**（存储里每人只有一条最新记录，
 *    过期条目在读写两条路径上都被剔除）。
 *
 * 文案诚实性说明：label 里的「在安静学习」描述的是**对方已加入安静自习存在层**这一事实，
 * 不是我们对他的声学测量结论（我们不采集、不推断对方的安静度）。
 */

import { z } from 'zod';
import { roomSchema } from '../../shared/model.js';

export const PRESENCE_HEARTBEAT_SCHEMA_VERSION = 'presence-heartbeat-v1';
export const PRESENCE_VIEW_SCHEMA_VERSION = 'presence-view-v1';
/** 短 TTL：90 s 内没有新心跳即消失。 */
export const PRESENCE_TTL_MS = 90_000;
/** 建议心跳间隔（UI 定时器用；服务端不强制——过期就消失，不靠客户端守约）。 */
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 30_000;
/** 每房间同时在线的 opted-in 身份上限（有界，超限明确 507）。 */
export const MAX_PRESENCE_IDENTITIES_PER_ROOM = 32;

/** 对外可见的粗档；`hidden` = 你没开（不向你揭示任何人）；`unknown` = 缺证，不假装"没人"。 */
export type PeerPresence = 'hidden' | 'none' | 'one' | 'some' | 'unknown';

/** 计数 → 粗档。**故意**在 ≥2 处截断：调用方拿不到精确人数，连数都算不出来。 */
export function peerBucket(count: number): 'none' | 'one' | 'some' {
  if (!Number.isFinite(count) || count <= 0) return 'none';
  if (count === 1) return 'one';
  return 'some';
}

export function presenceLabel(presence: PeerPresence): string {
  switch (presence) {
    case 'hidden':
      return '你还没有开启「共同存在信号」';
    case 'none':
      return '目前只有你在这里';
    case 'one':
      return '另有 1 位同学也在安静学习';
    case 'some':
      return '还有几位同学也在安静学习';
    default:
      return '暂时无法确认（共同存在信号不可用）';
  }
}

export const heartbeatSchema = z
  .object({
    schemaVersion: z.literal(PRESENCE_HEARTBEAT_SCHEMA_VERSION),
    roomId: roomSchema,
    /** true = 开启并续期；false = **立即关闭并撤回心跳**（随时可关）。 */
    optIn: z.boolean(),
  })
  .strict();
export type HeartbeatRequest = z.infer<typeof heartbeatSchema>;

export interface PresenceAck {
  schemaVersion: typeof PRESENCE_HEARTBEAT_SCHEMA_VERSION;
  roomId: string;
  /** 你当前的开关状态（服务端记录的真值）。 */
  youOptedIn: boolean;
  peerPresence: PeerPresence;
  label: string;
  /** 心跳有效期（秒）——配置常量，**不是**关于别人的信息。 */
  ttlSeconds: number;
  /** 建议下次心跳间隔（秒）。 */
  nextHeartbeatSeconds: number;
  serverReceivedAt: number;
  storeCorrupted: boolean;
  reason: string | null;
}

export interface PresenceView {
  schemaVersion: typeof PRESENCE_VIEW_SCHEMA_VERSION;
  roomId: string;
  youOptedIn: boolean;
  peerPresence: PeerPresence;
  label: string;
  ttlSeconds: number;
  heartbeatIntervalSeconds: number;
  computedAt: number;
  storeCorrupted: boolean;
  reason: string | null;
}

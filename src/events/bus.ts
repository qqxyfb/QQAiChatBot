import { EventEmitter } from 'node:events';
import type { MetricEvent } from '../types';

/** 进程内事件总线：打点事件统一入口 */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export function emit(ev: MetricEvent): void {
  try {
    bus.emit(ev.kind, ev);
  } catch {
    // 打点失败不影响主流程
  }
}

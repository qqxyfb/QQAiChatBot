export function nowMs(): number {
  return Date.now();
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 本地日期 'YYYY-MM-DD' */
export function dayStr(ts: number = Date.now()): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地当天 00:00:00 的毫秒时间戳 */
export function dayStartMs(ts: number = Date.now()): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本地小时（0-23） */
export function hourOf(ts: number): number {
  return new Date(ts).getHours();
}

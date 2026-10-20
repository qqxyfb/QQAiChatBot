import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Empty, Input, Select, Space, Tag, theme } from 'antd';
import { api, wsUrl } from '../api/client';
import { useAppStore } from '../store';

interface LogRow {
  seq: number;
  ts: number;
  level: string;
  source: string;
  connectionId?: string;
  msg: string;
}

const MAX_ROWS = 2000;
const BACKFILL_LIMIT = 800;
const ALL_LEVEL = 'ALL';
const ALL_SOURCE = 'ALL';
const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
const SOURCES = ['server', 'connector', 'llm', 'pipeline'];

/** 合并日志：seq 单调递增走快路径，断线重连回补时走去重慢路径 */
function mergeRows(prev: LogRow[], incoming: LogRow[]): LogRow[] {
  if (!incoming.length) return prev;
  if (!prev.length) return incoming.slice(-MAX_ROWS);
  const lastSeq = prev[prev.length - 1].seq;
  if (incoming[0].seq > lastSeq) return [...prev, ...incoming].slice(-MAX_ROWS);

  const map = new Map<number, LogRow>();
  for (const r of prev) map.set(r.seq, r);
  for (const r of incoming) map.set(r.seq, r);
  return [...map.values()].sort((a, b) => a.seq - b.seq).slice(-MAX_ROWS);
}

export default function LogsPage() {
  const { activeConnectionId } = useAppStore();
  const { token } = theme.useToken();
  const [rows, setRows] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  // 默认「全部级别」：进页面就该看到已发生的日志，而不是空列表
  const [level, setLevel] = useState<string>(ALL_LEVEL);
  const [source, setSource] = useState<string>(ALL_SOURCE);
  const [keyword, setKeyword] = useState('');
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const listRef = useRef<HTMLDivElement | null>(null);
  const lastSeqRef = useRef(0);

  const append = useCallback((incoming: LogRow[]) => {
    if (!incoming.length) return;
    const maxSeq = Math.max(lastSeqRef.current, ...incoming.map((r) => r.seq));
    lastSeqRef.current = maxSeq;
    setRows((prev) => mergeRows(prev, incoming));
  }, []);

  /** 首次进入 / 断线重连：都把已有日志回填进来（不传 level = 全部级别） */
  const backfill = useCallback(async () => {
    const params = new URLSearchParams({ limit: String(BACKFILL_LIMIT) });
    if (lastSeqRef.current > 0) params.set('since', String(lastSeqRef.current));
    try {
      append(await api.get<LogRow[]>(`/api/logs?${params}`));
    } catch {
      /* 首次拉取失败不阻塞 WS 实时流 */
    } finally {
      setLoading(false);
    }
  }, [append]);

  useEffect(() => {
    void backfill();

    let ws: WebSocket | null = null;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      ws = new WebSocket(wsUrl('/ws/logs'));
      ws.onopen = () => {
        // 断线期间可能漏了日志，这里按 since 补洞
        void backfill();
      };
      ws.onmessage = (ev) => {
        if (pausedRef.current) return;
        try {
          append([JSON.parse(ev.data as string) as LogRow]);
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (!closed) timer = setTimeout(connect, 3000);
      };
    };
    connect();

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [append, backfill]);

  // 选中的连接只看本连接 + 系统级日志（系统日志没有 connectionId，滤掉会让页面重新变空）
  const scoped = rows.filter(
    (r) => !activeConnectionId || !r.connectionId || r.connectionId === activeConnectionId
  );

  const levelCount = (lv: string) => scoped.filter((r) => r.level === lv).length;

  const filtered = scoped.filter(
    (r) =>
      (level === ALL_LEVEL || r.level === level) &&
      (source === ALL_SOURCE || r.source === source) &&
      (!keyword || r.msg.toLowerCase().includes(keyword.toLowerCase()))
  );

  // 新日志追加后自动滚到底部（暂停/手动上翻时不打扰）
  useEffect(() => {
    if (paused) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filtered.length, paused]);

  const resetFilters = () => {
    setLevel(ALL_LEVEL);
    setSource(ALL_SOURCE);
    setKeyword('');
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          style={{ width: 150 }}
          value={level}
          onChange={setLevel}
          options={[
            { value: ALL_LEVEL, label: `全部级别（${scoped.length}）` },
            ...LEVELS.map((v) => ({ value: v, label: `${v}（${levelCount(v)}）` })),
          ]}
        />
        <Select
          style={{ width: 150 }}
          value={source}
          onChange={setSource}
          options={[
            { value: ALL_SOURCE, label: '全部来源' },
            ...SOURCES.map((v) => ({ value: v, label: v })),
          ]}
        />
        <Input.Search placeholder="关键字" style={{ width: 240 }} onSearch={setKeyword} allowClear />
        <Button onClick={() => setPaused((p) => !p)}>{paused ? '继续' : '暂停'}</Button>
        <Button onClick={() => setRows([])}>清屏</Button>
        <Button
          onClick={() =>
            window.open(
              `/api/logs/export?connectionId=${activeConnectionId}&level=${
                level === ALL_LEVEL ? '' : level
              }&source=${source === ALL_SOURCE ? '' : source}&keyword=${encodeURIComponent(keyword)}`
            )
          }
        >
          导出
        </Button>
        <Tag>{filtered.length} 条</Tag>
        {paused && <Tag color="orange">已暂停接收</Tag>}
        {activeConnectionId && <Tag color="blue">已按连接筛选（含系统日志）</Tag>}
      </Space>

      <div
        ref={listRef}
        style={{
          maxHeight: 'calc(100vh - 220px)',
          overflow: 'auto',
          fontFamily: 'monospace',
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: 8,
        }}
      >
        {filtered.length === 0 ? (
          <div style={{ padding: '48px 0' }}>
            <Empty
              description={
                loading
                  ? '加载中…'
                  : rows.length === 0
                    ? '暂无日志：连接启动后这里会实时显示'
                    : '当前筛选条件下没有日志'
              }
            >
              {rows.length > 0 && <Button onClick={resetFilters}>重置筛选</Button>}
            </Empty>
          </div>
        ) : (
          filtered.map((r) => (
            <div
              key={r.seq}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                padding: '4px 10px',
                borderBottom: `1px solid ${token.colorSplit}`,
                fontSize: 12,
                lineHeight: '20px',
              }}
            >
              <Tag
                style={{ marginInlineEnd: 0, flex: '0 0 auto' }}
                color={
                  r.level === 'ERROR' ? 'red' : r.level === 'WARN' ? 'orange' : r.level === 'DEBUG' ? 'default' : 'blue'
                }
              >
                {r.level}
              </Tag>
              <Tag style={{ marginInlineEnd: 0, flex: '0 0 auto' }}>{r.source}</Tag>
              <span style={{ color: token.colorTextSecondary, flex: '0 0 auto' }}>
                {new Date(r.ts).toLocaleTimeString()}
              </span>
              <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{r.msg}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

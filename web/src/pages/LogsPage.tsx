import React, { useEffect, useRef, useState } from 'react';
import { Button, Input, List, Select, Space, Tag, theme } from 'antd';
import { wsUrl } from '../api/client';
import { useAppStore } from '../store';

interface LogRow {
  seq: number;
  ts: number;
  level: string;
  source: string;
  connectionId?: string;
  msg: string;
}

export default function LogsPage() {
  const { activeConnectionId } = useAppStore();
  const { token } = theme.useToken();
  const [rows, setRows] = useState<LogRow[]>([]);
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState<string | undefined>();
  const [source, setSource] = useState<string | undefined>();
  const [keyword, setKeyword] = useState('');
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      ws = new WebSocket(wsUrl('/ws/logs'));
      ws.onmessage = (ev) => {
        if (pausedRef.current) return;
        try {
          const row = JSON.parse(ev.data as string) as LogRow;
          setRows((prev) => [...prev.slice(-1999), row]);
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
  }, []);

  const filtered = rows.filter(
    (r) =>
      (!activeConnectionId || r.connectionId === activeConnectionId) &&
      (!level || r.level === level) &&
      (!source || r.source === source) &&
      (!keyword || r.msg.toLowerCase().includes(keyword.toLowerCase()))
  );

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder="级别"
          allowClear
          style={{ width: 120 }}
          value={level}
          onChange={setLevel}
          options={['DEBUG', 'INFO', 'WARN', 'ERROR'].map((v) => ({ value: v, label: v }))}
        />
        <Select
          placeholder="来源"
          allowClear
          style={{ width: 140 }}
          value={source}
          onChange={setSource}
          options={['server', 'connector', 'llm', 'pipeline'].map((v) => ({ value: v, label: v }))}
        />
        <Input.Search placeholder="关键字" style={{ width: 240 }} onSearch={setKeyword} allowClear />
        <Button onClick={() => setPaused((p) => !p)}>{paused ? '继续' : '暂停'}</Button>
        <Button onClick={() => setRows([])}>清屏</Button>
        <Button
          onClick={() =>
            window.open(
              `/api/logs/export?connectionId=${activeConnectionId}&level=${level || ''}&source=${source || ''}&keyword=${encodeURIComponent(keyword)}`
            )
          }
        >
          导出
        </Button>
        <Tag>{filtered.length} 条</Tag>
      </Space>

      <List
        size="small"
        dataSource={filtered}
        style={{ maxHeight: '70vh', overflow: 'auto', fontFamily: 'monospace' }}
        renderItem={(r) => (
          <List.Item style={{ padding: '4px 8px' }}>
            <Space size={8} wrap>
              <Tag color={r.level === 'ERROR' ? 'red' : r.level === 'WARN' ? 'orange' : r.level === 'DEBUG' ? 'default' : 'blue'}>
                {r.level}
              </Tag>
              <Tag>{r.source}</Tag>
              <span style={{ color: token.colorTextSecondary }}>{new Date(r.ts).toLocaleTimeString()}</span>
              <span>{r.msg}</span>
            </Space>
          </List.Item>
        )}
      />
    </div>
  );
}

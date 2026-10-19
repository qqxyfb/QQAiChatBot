import React, { useEffect, useState } from 'react';
import { Button, Card, Input, Space, Table, Tag, message } from 'antd';
import { api } from '../api/client';
import { useAppStore } from '../store';

interface SessionItem {
  fromHash: string;
  lastTs: number;
  messages: number;
  tokens: number;
}

interface MessageRow {
  id: number;
  ts: number;
  channel: string;
  from_hash: string;
  direction: string;
  content: string;
  reply: string;
  finish_reason: string;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export default function HistoryPage() {
  const { activeConnectionId, historyFromHash, setHistoryFromHash } = useAppStore();
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [total, setTotal] = useState(0);
  const [fromHash, setFromHash] = useState<string>('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    void loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnectionId]);

  // 从统计页「Top 对象」下钻
  useEffect(() => {
    if (!historyFromHash) return;
    setFromHash(historyFromHash);
    void loadMessages(1, historyFromHash);
    setHistoryFromHash('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyFromHash]);

  async function loadSessions() {
    const q = activeConnectionId ? `?connectionId=${activeConnectionId}` : '';
    try {
      setSessions(await api.get<SessionItem[]>(`/api/history/sessions${q}`));
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  async function loadMessages(p = 1, hash = fromHash) {
    const params = new URLSearchParams();
    if (activeConnectionId) params.set('connectionId', activeConnectionId);
    if (hash) params.set('fromHash', hash);
    if (keyword) params.set('keyword', keyword);
    params.set('page', String(p));
    params.set('pageSize', '50');
    try {
      const r = await api.get<{ rows: MessageRow[]; total: number }>(`/api/history/messages?${params}`);
      setMessages(r.rows);
      setTotal(r.total);
      setPage(p);
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="会话列表（按对象）">
        <Table
          size="small"
          rowKey="fromHash"
          dataSource={sessions}
          pagination={false}
          onRow={(r) => ({
            onClick: () => {
              setFromHash(r.fromHash);
              void loadMessages(1);
            },
            style: { cursor: 'pointer' },
          })}
          columns={[
            { title: '对象（哈希）', dataIndex: 'fromHash', render: (v: string) => <Tag>{v}</Tag> },
            { title: '最后时间', dataIndex: 'lastTs', render: (v: number) => new Date(v).toLocaleString() },
            { title: '消息数', dataIndex: 'messages' },
            { title: 'Token', dataIndex: 'tokens' },
          ]}
        />
      </Card>

      <Card
        title={`消息明细${fromHash ? ` · ${fromHash}` : ''}`}
        extra={
          <Space>
            <Input.Search placeholder="关键字" style={{ width: 200 }} onSearch={(v) => { setKeyword(v); void loadMessages(1); }} allowClear />
            <Button onClick={() => setFromHash('')} disabled={!fromHash}>清除对象筛选</Button>
            <Button
              onClick={() =>
                window.open(
                  `/api/history/export?connectionId=${activeConnectionId}&fromHash=${fromHash}&keyword=${encodeURIComponent(keyword)}&format=csv`
                )
              }
            >
              导出 CSV
            </Button>
          </Space>
        }
      >
        <Table
          size="small"
          rowKey="id"
          dataSource={messages}
          pagination={{ current: page, pageSize: 50, total, onChange: (p) => void loadMessages(p) }}
          columns={[
            { title: '时间', dataIndex: 'ts', width: 170, render: (v: number) => new Date(v).toLocaleString() },
            { title: '渠道', dataIndex: 'channel', width: 80 },
            { title: '对象', dataIndex: 'from_hash', width: 130 },
            { title: '用户消息', dataIndex: 'content', ellipsis: true },
            { title: '机器人回复', dataIndex: 'reply', ellipsis: true },
            {
              title: '结果',
              dataIndex: 'finish_reason',
              width: 100,
              render: (v: string) => <Tag color={v === 'normal' ? 'green' : v === 'error' ? 'red' : 'orange'}>{v}</Tag>,
            },
            { title: 'Token', width: 100, render: (_: unknown, r: MessageRow) => `${r.prompt_tokens}/${r.completion_tokens}` },
            { title: '延迟(ms)', dataIndex: 'latency_ms', width: 100 },
          ]}
        />
      </Card>
    </Space>
  );
}

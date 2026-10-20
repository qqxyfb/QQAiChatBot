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

/** 表情包标记：兼容新旧两种写法 [表情包:标签] / [sticker:标签] */
const STICKER_RE = /\[(?:sticker|表情包)\s*[:：]\s*([^\]]+)\]/g;

function PictureIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden
      style={{ marginRight: 4, verticalAlign: '-2px' }}
    >
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <circle cx="5.6" cy="6.4" r="1.1" fill="currentColor" stroke="none" />
      <path d="M3 11.5l3-3 2.4 2.4 1.6-1.6L13 12" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * 机器人回复单元格：把 [表情包:标签] 渲染成「图片」样式的标签。
 * 纯表情包回复的正文被剥离后为空，过去在这里是一片空白，看不出机器人发了图。
 */
function ReplyCell({ text }: { text?: string }) {
  const raw = text ?? '';
  if (!raw.trim()) return <span style={{ opacity: 0.45 }}>—</span>;

  const parts: React.ReactNode[] = [];
  let last = 0;
  STICKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null = STICKER_RE.exec(raw);
  while (m) {
    const plain = raw.slice(last, m.index).trim();
    if (plain) parts.push(<span key={`t-${m.index}`}>{plain}</span>);
    parts.push(
      <Tag key={`s-${m.index}`} color="purple" title={`已发送表情包（标签：${m[1]}）`} style={{ marginInline: 4 }}>
        <PictureIcon />
        表情包 · {m[1]}
      </Tag>
    );
    last = m.index + m[0].length;
    m = STICKER_RE.exec(raw);
  }
  const tail = raw.slice(last).trim();
  if (tail) parts.push(<span key="tail">{tail}</span>);

  return <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{parts}</span>;
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
    // 进页面就带出最近消息，避免「消息明细」一片空白让人以为没记录
    void loadMessages(1, '');
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
              // 必须显式传 hash：setFromHash 是异步的，直接读 fromHash 会拿到上一次的值
              void loadMessages(1, r.fromHash);
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
            <Button
              onClick={() => {
                setFromHash('');
                void loadMessages(1, '');
              }}
              disabled={!fromHash}
            >
              清除对象筛选
            </Button>
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
            {
              title: '机器人回复',
              dataIndex: 'reply',
              width: 320,
              render: (v: string) => <ReplyCell text={v} />,
            },
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

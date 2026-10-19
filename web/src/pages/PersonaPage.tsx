import React, { useEffect, useState } from 'react';
import { Button, Input, Modal, Popconfirm, Space, Table, Tag, message } from 'antd';
import { api } from '../api/client';

interface PersonaItem {
  id: string;
  name: string;
  tags?: string[];
  builtin: boolean;
  referencedBy: string[];
  profilePrompt: string;
}

export default function PersonaPage() {
  const [list, setList] = useState<PersonaItem[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [genOpen, setGenOpen] = useState(false);
  const [genText, setGenText] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpText, setHelpText] = useState('');

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    try {
      setList(await api.get<PersonaItem[]>('/api/persona'));
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  async function doImport() {
    try {
      await api.post('/api/persona/import', { content: importText });
      message.success('导入成功');
      setImportOpen(false);
      setImportText('');
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  async function doGenerate() {
    try {
      await api.post('/api/persona/generate', { description: genText });
      message.success('生成成功');
      setGenOpen(false);
      setGenText('');
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  async function showHelp() {
    try {
      setHelpText(await api.get<string>('/api/persona/help'));
      setHelpOpen(true);
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  async function remove(id: string) {
    try {
      await api.del(`/api/persona/${id}`);
      message.success('已删除');
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" onClick={() => setImportOpen(true)}>
          导入人格
        </Button>
        <Button onClick={() => setGenOpen(true)}>在线生成</Button>
        <Button onClick={showHelp}>格式帮助</Button>
      </Space>

      <Table
        rowKey="id"
        dataSource={list}
        columns={[
          { title: '名称', dataIndex: 'name' },
          {
            title: '标签',
            dataIndex: 'tags',
            render: (t: string[]) => (t || []).map((x) => <Tag key={x}>{x}</Tag>),
          },
          {
            title: '内置',
            dataIndex: 'builtin',
            render: (b: boolean) => (b ? <Tag color="blue">内置</Tag> : null),
          },
          {
            title: '被引用连接',
            dataIndex: 'referencedBy',
            render: (r: string[]) => (r || []).join('、') || '—',
          },
          {
            title: '操作',
            render: (_: unknown, r: PersonaItem) => (
              <Space>
                <Button
                  type="link"
                  onClick={async () => {
                    const full = await api.get<Record<string, unknown>>(`/api/persona/${r.id}`);
                    setImportText(JSON.stringify(full, null, 2));
                    setImportOpen(true);
                  }}
                >
                  查看 / 复制
                </Button>
                <Popconfirm title="确认删除该人格？" onConfirm={() => remove(r.id)}>
                  <Button type="link" danger disabled={r.builtin}>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title="导入人格（JSON）"
        open={importOpen}
        onOk={doImport}
        onCancel={() => setImportOpen(false)}
        width={760}
      >
        <Input.TextArea
          rows={16}
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder="粘贴人格 JSON，必填 name、profilePrompt（含 {user_message}）"
        />
      </Modal>

      <Modal
        title="在线生成人格"
        open={genOpen}
        onOk={doGenerate}
        onCancel={() => setGenOpen(false)}
        width={640}
      >
        <Input.TextArea
          rows={8}
          value={genText}
          onChange={(e) => setGenText(e.target.value)}
          placeholder="描述你想要的人设，例如：温柔、说话简短、喜欢用「呀」结尾…"
        />
      </Modal>

      <Modal title="人格格式帮助" open={helpOpen} onCancel={() => setHelpOpen(false)} footer={null} width={820}>
        <pre style={{ whiteSpace: 'pre-wrap', maxHeight: '60vh', overflow: 'auto' }}>{helpText}</pre>
      </Modal>
    </div>
  );
}

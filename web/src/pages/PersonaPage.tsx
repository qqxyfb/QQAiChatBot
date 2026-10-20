import React, { useEffect, useState } from 'react';
import { AutoComplete, Button, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, message } from 'antd';
import { api } from '../api/client';

interface PersonaItem {
  id: string;
  name: string;
  profile?: string;
  tags?: string[];
  bannedWords?: string[];
  builtin: boolean;
  referencedBy: string[];
  profilePrompt: string;
  stickerSet?: string;
  voice?: { enabled?: boolean; tts?: { voice?: string } };
}

export default function PersonaPage() {
  const [list, setList] = useState<PersonaItem[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [genOpen, setGenOpen] = useState(false);
  const [genText, setGenText] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpText, setHelpText] = useState('');
  const [editing, setEditing] = useState<PersonaItem | null>(null);
  const [editForm] = Form.useForm();
  const [stickerSets, setStickerSets] = useState<Array<{ id: string; name: string; isDefault: boolean }>>([]);
  const [voices, setVoices] = useState<Array<{ id: string; name: string }>>([]);

  function openEdit(r: PersonaItem) {
    setEditing(r);
    editForm.setFieldsValue({
      name: r.name,
      profile: r.profile,
      profilePrompt: r.profilePrompt,
      tags: (r.tags ?? []).join(', '),
      bannedWords: (r.bannedWords ?? []).join('\n'),
      stickerSet: r.stickerSet || '',
      voiceEnabled: r.voice?.enabled ?? false,
      voiceVoice: r.voice?.tts?.voice || '',
    });
  }

  async function doEdit() {
    if (!editing) return;
    try {
      const v = await editForm.validateFields();
      await api.put(`/api/persona/${editing.id}`, {
        name: v.name,
        profile: v.profile,
        profilePrompt: v.profilePrompt,
        tags: String(v.tags || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        bannedWords: String(v.bannedWords || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        stickerSet: v.stickerSet || undefined,
        voice: { enabled: !!v.voiceEnabled, tts: { voice: v.voiceVoice || 'zh-CN-XiaoxiaoNeural' } },
      });
      message.success('已保存');
      setEditing(null);
      await load();
    } catch (e) {
      if ((e as { errorFields?: unknown }).errorFields) return;
      message.error((e as Error).message);
    }
  }

  useEffect(() => {
    void load();
    api
      .get<Array<{ id: string; name: string; isDefault: boolean }>>('/api/stickers/sets')
      .then(setStickerSets)
      .catch(() => undefined);
    api
      .get<Array<{ id: string; name: string }>>('/api/tts/voices')
      .then(setVoices)
      .catch(() => undefined);
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
                <Button type="link" onClick={() => openEdit(r)}>
                  编辑
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

      <Modal
        title={`编辑人格 · ${editing?.name ?? ''}`}
        open={!!editing}
        onOk={doEdit}
        onCancel={() => setEditing(null)}
        width={760}
        okText="保存"
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="profile" label="人格画像">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item
            name="profilePrompt"
            label="系统提示词（必须包含 {user_message}）"
            rules={[
              { required: true, message: '请输入系统提示词' },
              {
                validator: (_, v: string) =>
                  v && v.includes('{user_message}')
                    ? Promise.resolve()
                    : Promise.reject(new Error('必须包含 {user_message} 占位符')),
              },
            ]}
          >
            <Input.TextArea rows={7} />
          </Form.Item>
          <Form.Item name="tags" label="标签（英文逗号分隔）">
            <Input placeholder="温柔, 句短, 日常向" />
          </Form.Item>
          <Form.Item name="stickerSet" label="表情包组（不选则用默认组）">
            <Select
              allowClear
              placeholder="默认组"
              options={stickerSets.map((s) => ({
                value: s.id,
                label: s.isDefault ? `${s.name}（默认）` : s.name,
              }))}
            />
          </Form.Item>
          <Form.Item name="voiceEnabled" label="语音回复（对文字回复附加语音）" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="voiceVoice" label="语音音色（留空用全局默认）">
            <AutoComplete
              style={{ width: 280 }}
              options={voices.map((v) => ({ value: v.id, label: `${v.name}（${v.id}）` }))}
              placeholder="zh-CN-XiaoxiaoNeural"
              filterOption={(input, option) => String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())}
            />
          </Form.Item>
          <Form.Item name="bannedWords" label="安全红线词（每行一个）">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

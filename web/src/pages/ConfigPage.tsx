import React, { useEffect, useState } from 'react';
import { AutoComplete, Button, Card, Divider, Form, Input, InputNumber, Select, Space, Switch, Table, message, theme } from 'antd';
import { api } from '../api/client';
import type { GlobalConfig } from '../types';

export default function ConfigPage() {
  const [form] = Form.useForm();
  const [testResult, setTestResult] = useState('');
  const [ttsResult, setTtsResult] = useState('');
  const [voices, setVoices] = useState<Array<{ id: string; name: string }>>([]);
  const { token } = theme.useToken();

  useEffect(() => {
    void load();
    api
      .get<Array<{ id: string; name: string }>>('/api/tts/voices')
      .then(setVoices)
      .catch(() => undefined);
  }, []);

  async function load() {
    try {
      const cfg = await api.get<GlobalConfig>('/api/config');
      form.setFieldsValue({ ...cfg, pricingText: JSON.stringify(cfg.pricing ?? {}, null, 2) });
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  async function save() {
    try {
      const v = await form.validateFields();
      let pricing = {};
      try {
        pricing = JSON.parse(v.pricingText || '{}');
      } catch {
        message.error('单价 JSON 格式错误');
        return;
      }
      const payload = { ...v, pricing };
      delete (payload as { pricingText?: string }).pricingText;
      const saved = await api.put<GlobalConfig>('/api/config', payload);
      message.success('已保存');
      // 用服务端返回值回填，保证界面与落盘一致（不再出现 *** 占位）
      form.setFieldsValue({ ...saved, pricingText: JSON.stringify(saved.pricing ?? {}, null, 2) });
    } catch (e) {
      if ((e as { errorFields?: unknown }).errorFields) return;
      message.error((e as Error).message);
    }
  }

  async function testLlm() {
    try {
      const v = form.getFieldsValue();
      const r = await api.post<{ ok: boolean; message: string; latencyMs: number }>(
        '/api/config/test-llm',
        v.llm
      );
      setTestResult(`${r.ok ? '成功' : '失败'} · ${r.message} · ${r.latencyMs}ms`);
    } catch (e) {
      setTestResult(`失败 · ${(e as Error).message}`);
    }
  }

  async function testTts() {
    try {
      const v = form.getFieldsValue();
      const r = await api.post<{ ok: boolean; message: string }>('/api/tts/test', v.tts);
      setTtsResult(`${r.ok ? '成功' : '失败'} · ${r.message}`);
    } catch (e) {
      setTtsResult(`失败 · ${(e as Error).message}`);
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="全局配置"
        extra={
          <Space>
            <Button onClick={testLlm}>测试 LLM</Button>
            <Button type="primary" onClick={save}>
              保存
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
        <Divider orientation="left">LLM 默认配置</Divider>
        <Form.Item name={['llm', 'baseUrl']} label="Base URL" rules={[{ required: true }]}>
          <Input placeholder="https://api.deepseek.com/v1" />
        </Form.Item>
        <Form.Item name={['llm', 'apiKey']} label="API Key" extra="本地回显真实值，点右侧图标可切换明文/密文">
          <Input.Password visibilityToggle placeholder="sk-..." />
        </Form.Item>
        <Form.Item name={['llm', 'model']} label="模型" rules={[{ required: true }]}>
          <Input placeholder="deepseek-chat" />
        </Form.Item>
        <Space size="large">
          <Form.Item name={['llm', 'temperature']} label="Temperature">
            <InputNumber min={0} max={2} step={0.1} />
          </Form.Item>
          <Form.Item name={['llm', 'maxTokens']} label="Max Tokens">
            <InputNumber min={1} max={8192} />
          </Form.Item>
        </Space>
        {testResult && <div style={{ marginBottom: 12, color: token.colorTextSecondary }}>{testResult}</div>}

        <Divider orientation="left">TTS 默认配置（语音回复）</Divider>
        <Space size="large" wrap>
          <Form.Item name={['tts', 'provider']} label="厂商">
            <Select
              style={{ width: 180 }}
              options={[
                { value: 'edge', label: 'Edge（免费）' },
                { value: 'openai-compatible', label: 'OpenAI 兼容' },
              ]}
            />
          </Form.Item>
          <Form.Item name={['tts', 'voice']} label="音色">
            <AutoComplete
              style={{ width: 240 }}
              options={voices.map((v) => ({ value: v.id, label: `${v.name}（${v.id}）` }))}
              placeholder="zh-CN-XiaoxiaoNeural"
              filterOption={(input, option) => String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())}
            />
          </Form.Item>
          <Form.Item name={['tts', 'model']} label="模型（OpenAI 兼容用）">
            <Input placeholder="tts-1" style={{ width: 140 }} />
          </Form.Item>
        </Space>
        <Form.Item name={['tts', 'baseUrl']} label="Base URL（OpenAI 兼容必填，Edge 可留空）">
          <Input placeholder="https://api.openai.com/v1" />
        </Form.Item>
        <Form.Item name={['tts', 'apiKey']} label="API Key（Edge 可留空）">
          <Input.Password visibilityToggle placeholder="OpenAI 兼容厂商的 key" />
        </Form.Item>
        <Button onClick={testTts}>测试 TTS</Button>
        {ttsResult && <div style={{ marginTop: 8, color: token.colorTextSecondary }}>{ttsResult}</div>}

        <Divider orientation="left">存储</Divider>
        <Form.Item name={['storage', 'dataDir']} label="数据目录（留空使用默认）">
          <Input />
        </Form.Item>
        <Space size="large">
          <Form.Item name={['storage', 'historyRetentionDays']} label="聊天记录保留天数">
            <InputNumber min={0} />
          </Form.Item>
          <Form.Item name={['storage', 'logRetentionDays']} label="日志保留天数">
            <InputNumber min={0} />
          </Form.Item>
        </Space>

        <Divider orientation="left">服务</Divider>
        <Space size="large">
          <Form.Item name={['server', 'port']} label="端口">
            <InputNumber min={1} max={65535} />
          </Form.Item>
          <Form.Item name={['server', 'allowLan']} label="外网访问" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name={['server', 'accessToken']} label="访问令牌（外网必填，≥8 位）">
            <Input.Password visibilityToggle placeholder="开启外网访问时必填" />
          </Form.Item>
        </Space>

        <Divider orientation="left">更新（GitHub Release）</Divider>
        <Space size="large">
          <Form.Item name={['update', 'owner']} label="仓库 Owner">
            <Input />
          </Form.Item>
          <Form.Item name={['update', 'repo']} label="仓库名">
            <Input />
          </Form.Item>
          <Form.Item name={['update', 'autoCheck']} label="启动时检测" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Space>

        <Divider orientation="left">成本单价（元 / 百万 token）</Divider>
        <Form.Item name="pricingText" label="pricing JSON">
          <Input.TextArea rows={5} placeholder={'{\n  "deepseek-chat": { "inputPrice": 2, "outputPrice": 8 }\n}'} />
        </Form.Item>

        <Divider />
        <Form.Item name="maxConnections" label="最大连接数">
          <InputNumber min={1} max={100} />
        </Form.Item>
        </Form>
      </Card>
      <BanwordCard />
    </Space>
  );
}

function BanwordCard() {
  const [list, setList] = useState<Array<{ id: number; word: string; direction: string }>>([]);
  const [word, setWord] = useState('');
  const [direction, setDirection] = useState('both');

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    try {
      setList(await api.get<Array<{ id: number; word: string; direction: string }>>('/api/banword'));
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  async function add() {
    if (!word.trim()) return;
    try {
      await api.post('/api/banword', { word: word.trim(), direction });
      setWord('');
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  async function remove(id: number) {
    try {
      await api.del(`/api/banword/${id}`);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  return (
    <Card title="全局安全词库（与人格红线词叠加生效）">
      <Space style={{ marginBottom: 12 }}>
        <Input
          value={word}
          onChange={(e) => setWord(e.target.value)}
          placeholder="违禁词"
          style={{ width: 240 }}
        />
        <Select
          value={direction}
          onChange={setDirection}
          style={{ width: 120 }}
          options={[
            { value: 'both', label: '双向' },
            { value: 'in', label: '仅输入' },
            { value: 'out', label: '仅输出' },
          ]}
        />
        <Button type="primary" onClick={add}>
          添加
        </Button>
      </Space>
      <Table
        size="small"
        rowKey="id"
        dataSource={list}
        pagination={{ pageSize: 10 }}
        columns={[
          { title: '词', dataIndex: 'word' },
          { title: '方向', dataIndex: 'direction', width: 120 },
          {
            title: '操作',
            width: 100,
            render: (_: unknown, r: { id: number }) => (
              <Button type="link" danger onClick={() => remove(r.id)}>
                删除
              </Button>
            ),
          },
        ]}
      />
    </Card>
  );
}

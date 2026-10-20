import React, { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Col,
  Divider,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  message,
  theme,
} from 'antd';
import { api } from '../api/client';
import { useAppStore, type ConnectionItem } from '../store';

export default function ConnectionsPage() {
  const { connections, loadConnections } = useAppStore();
  const { token } = theme.useToken();
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm();
  const [detail, setDetail] = useState<ConnectionItem | null>(null);
  const [detailForm] = Form.useForm();
  const [personas, setPersonas] = useState<Array<{ id: string; name: string }>>([]);
  const [riskOpen, setRiskOpen] = useState(false);
  const [copyTarget, setCopyTarget] = useState<ConnectionItem | null>(null);
  const [copyForm] = Form.useForm();

  useEffect(() => {
    api
      .get<Array<{ id: string; name: string }>>('/api/persona')
      .then(setPersonas)
      .catch(() => undefined);
  }, []);

  async function doCopy() {
    if (!copyTarget) return;
    try {
      const v = await copyForm.validateFields();
      await api.post('/api/connections', {
        name: v.name,
        type: copyTarget.type,
        copyFrom: copyTarget.connectionId,
      });
      message.success('已复制连接');
      setCopyTarget(null);
      await loadConnections();
    } catch (e) {
      if ((e as { errorFields?: unknown }).errorFields) return;
      message.error((e as Error).message);
    }
  }

  async function create() {
    try {
      const v = await createForm.validateFields();
      const cfg = await api.post<ConnectionItem>('/api/connections', v);
      message.success('已创建');
      setCreateOpen(false);
      createForm.resetFields();
      await loadConnections();
      openDetail(cfg);
    } catch (e) {
      if ((e as { errorFields?: unknown }).errorFields) return;
      message.error((e as Error).message);
    }
  }

  function openDetail(c: ConnectionItem) {
    setDetail(c);    const chat = (c.chat ?? {}) as Record<string, unknown>;
    detailForm.setFieldsValue({
      name: c.name,
      personaId: c.personaId,
      appId: c.official?.appId,
      appSecret: c.official?.appSecret,
      apiDomain: c.official?.apiDomain,
      host: c.account?.host,
      port: c.account?.port,
      wsMode: c.account?.wsMode,
      riskConfirmed: c.riskConfirmed,
      mode: chat.mode,
      groupList: ((chat.groupList as string[]) ?? []).join('\n'),
      userList: ((chat.userList as string[]) ?? []).join('\n'),
      contextMaxMessages: chat.contextMaxMessages,
      contextTtlMinutes: chat.contextTtlMinutes,
      dailyTokenBudget: chat.dailyTokenBudget,
      maxInputLen: chat.maxInputLen,
      maxPerMinute: (chat.rateLimit as { maxPerMinute?: number })?.maxPerMinute,
      minIntervalMs: (chat.rateLimit as { minIntervalMs?: number })?.minIntervalMs,
      trigger: chat.trigger,
      triggerKeywords: ((chat.triggerKeywords as string[]) ?? []).join('\n'),
      randomProbability: chat.randomProbability,
      llmBaseUrl: c.llmOverride?.baseUrl,
      llmApiKey: c.llmOverride?.apiKey,
      llmModel: c.llmOverride?.model,
    });
  }

  async function saveDetail() {
    if (!detail) return;
    try {
      const v = await detailForm.validateFields();
      if (detail.type === 'account' && !v.riskConfirmed) {
        setRiskOpen(true);
        return;
      }
      const payload = {
        ...detail,
        name: v.name,
        personaId: v.personaId,
        riskConfirmed: Boolean(v.riskConfirmed),
        llmOverride: v.llmBaseUrl
          ? {
              baseUrl: v.llmBaseUrl,
              apiKey: v.llmApiKey || '',
              model: v.llmModel || '',
              temperature: 0.8,
              maxTokens: 512,
            }
          : undefined,
        official:
          detail.type === 'official'
            ? { appId: v.appId, appSecret: v.appSecret, apiDomain: v.apiDomain }
            : undefined,
        account:
          detail.type === 'account' ? { host: v.host, port: v.port, wsMode: v.wsMode } : undefined,
        chat: {
          ...(detail.chat as Record<string, unknown>),
          mode: v.mode,
          groupList: String(v.groupList || '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
          userList: String(v.userList || '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
          contextMaxMessages: v.contextMaxMessages,
          contextTtlMinutes: v.contextTtlMinutes,
          dailyTokenBudget: v.dailyTokenBudget,
          maxInputLen: v.maxInputLen,
          rateLimit: { maxPerMinute: v.maxPerMinute, minIntervalMs: v.minIntervalMs },
          trigger: v.trigger,
          triggerKeywords: String(v.triggerKeywords || '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
          randomProbability: v.randomProbability,
        },
      };
      await api.put(`/api/connections/${detail.connectionId}`, payload);
      message.success('已保存');
      forceClose();
      await loadConnections();
    } catch (e) {
      if ((e as { errorFields?: unknown }).errorFields) return;
      message.error((e as Error).message);
    }
  }

  /** 直接关闭并丢弃编辑态（保存成功后 / 用户确认放弃后调用） */
  function forceClose(): void {
    detailForm.resetFields();
    setDetail(null);
  }

  /** 关闭抽屉前做脏检查，避免误触遮罩/ESC 丢掉未保存的编辑 */
  function requestClose(): void {
    if (!detail) return;
    if (!detailForm.isFieldsTouched()) {
      forceClose();
      return;
    }
    Modal.confirm({
      title: '放弃未保存的修改？',
      content: '关闭后本次编辑的内容不会保存。',
      okText: '放弃修改',
      cancelText: '继续编辑',
      okButtonProps: { danger: true },
      onOk: forceClose,
    });
  }

  async function toggle(c: ConnectionItem) {
    try {
      if (c.status === 'running') {
        await api.post(`/api/connections/${c.connectionId}/stop`);
        message.success('已停止');
      } else {
        const r = await api.post<{
          ok: boolean;
          message: string;
          precheck?: { items: Array<{ status: string; message: string }> };
        }>(`/api/connections/${c.connectionId}/start`);
        if (!r.ok) {
          Modal.error({
            title: '启动失败',
            content:
              r.precheck?.items
                ?.filter((i) => i.status === 'fail')
                .map((i) => i.message)
                .join('；') || r.message,
          });
        } else {
          message.success('已启动');
        }
      }
      await loadConnections();
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" onClick={() => setCreateOpen(true)}>
          新建连接
        </Button>
        <Button
          onClick={async () => {
            const r = await api.post<{ started: string[]; failed: unknown[] }>('/api/connections/start-all');
            message.success(`已启动 ${r.started.length} 个，失败 ${r.failed.length} 个`);
            await loadConnections();
          }}
        >
          全部启动
        </Button>
        <Button
          onClick={async () => {
            await api.post('/api/connections/stop-all');
            message.success('已全部停止');
            await loadConnections();
          }}
        >
          全部停止
        </Button>
      </Space>

      <Row gutter={[16, 16]}>
        {connections.map((c) => (
          <Col span={8} key={c.connectionId}>
            <Card
              title={
                <Space>
                  {c.name}
                  <Tag color={c.type === 'official' ? 'blue' : 'purple'}>
                    {c.type === 'official' ? '官方Bot' : '登录QQ号'}
                  </Tag>
                </Space>
              }
              extra={
                <Tag color={c.status === 'running' ? 'green' : c.status === 'error' ? 'red' : 'default'}>
                  {c.status}
                </Tag>
              }
              actions={[
                <Button type="link" key="cfg" onClick={() => openDetail(c)}>
                  配置
                </Button>,
                <Button type="link" key="toggle" onClick={() => toggle(c)}>
                  {c.status === 'running' ? '停止' : '启动'}
                </Button>,
                <Button
                  type="link"
                  key="test"
                  onClick={async () => {
                    try {
                      const r = await api.post<{ ok: boolean; message: string }>(
                        `/api/connections/${c.connectionId}/test`
                      );
                      if (r.ok) message.success(r.message);
                      else message.warning(r.message);
                    } catch (e) {
                      message.error((e as Error).message);
                    }
                  }}
                >
                  测试
                </Button>,
                <Popconfirm
                  key="del"
                  title="确认删除该连接？"
                  onConfirm={async () => {
                    try {
                      await api.del(`/api/connections/${c.connectionId}`);
                      message.success('已删除');
                      await loadConnections();
                    } catch (e) {
                      message.error((e as Error).message);
                    }
                  }}
                >
                  <Button type="link" danger>
                    删除
                  </Button>
                </Popconfirm>,
              ]}
            >
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <div>人格：{c.personaName}</div>
                <div>
                  今日消息：{c.todayMessages}　今日 Token：{c.todayTokens}
                </div>
              </Space>
            </Card>
          </Col>
        ))}
        {connections.length === 0 && <Col span={24}>暂无连接，点击「新建连接」开始。</Col>}
      </Row>

      <Modal title="新建连接" open={createOpen} onOk={create} onCancel={() => setCreateOpen(false)}>
        <Form form={createForm} layout="vertical" initialValues={{ type: 'official' }}>
          <Form.Item name="name" label="连接名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：主号 / 测试Bot" />
          </Form.Item>
          <Form.Item name="type" label="连接类型" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'official', label: 'QQ 官方机器人（AppID + AppSecret）' },
                { value: 'account', label: '登录 QQ 号（OneBot v11）' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={detail ? `连接配置 · ${detail.name}` : ''}
        width={680}
        open={!!detail}
        onClose={requestClose}
        maskClosable={false}
        keyboard={false}
        extra={
          <Space>
            <Button
              onClick={() => {
                if (!detail) return;
                setCopyTarget(detail);
                copyForm.setFieldsValue({ name: `${detail.name} 副本` });
              }}
            >
              复制连接
            </Button>
            <Button type="primary" onClick={saveDetail}>
              保存
            </Button>
          </Space>
        }
      >
        {detail && (
          <Form form={detailForm} layout="vertical">
            <Form.Item name="name" label="连接名称" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="personaId" label="绑定人格" rules={[{ required: true }]}>
              <Select options={personas.map((p) => ({ value: p.id, label: p.name }))} />
            </Form.Item>

            {detail.type === 'official' ? (
              <>
                <Form.Item name="appId" label="AppID">
                  <Input />
                </Form.Item>
                <Form.Item name="appSecret" label="AppSecret">
                  <Input.Password />
                </Form.Item>
                <Form.Item name="apiDomain" label="API 域名">
                  <Input placeholder="https://api.sgroup.qq.com" />
                </Form.Item>
              </>
            ) : (
              <>
                <Form.Item name="host" label="OneBot 地址">
                  <Input placeholder="127.0.0.1" />
                </Form.Item>
                <Form.Item name="port" label="端口">
                  <InputNumber style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item name="wsMode" label="连接方式">
                  <Select
                    options={[
                      { value: 'forward', label: '正向 WS（连接 NapCat）' },
                      { value: 'reverse', label: '反向 WS（暂未实现）' },
                    ]}
                  />
                </Form.Item>
                <Form.Item name="riskConfirmed" label="封号风险确认" valuePropName="checked">
                  <Switch checkedChildren="已知晓" unCheckedChildren="未确认" />
                </Form.Item>
              </>
            )}

            <Divider>聊天配置</Divider>
            <Form.Item name="trigger" label="触发规则">
              <Select
                options={[
                  { value: 'at', label: '仅 @ 回复（默认）' },
                  { value: 'keyword', label: '关键词触发（命中即回复，@ 也回复）' },
                  { value: 'random', label: '概率闲聊（按概率主动插话）' },
                  { value: 'silent', label: '静默（不回复）' },
                ]}
              />
            </Form.Item>
            <Form.Item name="triggerKeywords" label="触发关键词（每行一个，仅关键词模式生效）">
              <Input.TextArea rows={3} placeholder={'例如：\n机器人\n小助手'} />
            </Form.Item>
            <Form.Item name="randomProbability" label="闲聊概率（0~1，仅概率模式生效）">
              <InputNumber min={0} max={1} step={0.05} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="mode" label="名单模式">
              <Select
                options={[
                  { value: 'whitelist', label: '白名单（仅名单内响应）' },
                  { value: 'blacklist', label: '黑名单（名单内不响应）' },
                ]}
              />
            </Form.Item>
            <Form.Item name="groupList" label="群名单（每行一个）">
              <Input.TextArea rows={3} />
            </Form.Item>
            <Form.Item name="userList" label="对象名单（每行一个）">
              <Input.TextArea rows={3} />
            </Form.Item>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="contextMaxMessages" label="上下文条数">
                  <InputNumber min={1} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="contextTtlMinutes" label="上下文过期（分钟）">
                  <InputNumber min={1} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="dailyTokenBudget" label="每日 Token 预算">
                  <InputNumber min={0} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="maxInputLen" label="输入长度上限">
                  <InputNumber min={1} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="maxPerMinute" label="每分钟最大回复">
                  <InputNumber min={1} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="minIntervalMs" label="最小间隔（ms）">
                  <InputNumber min={0} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>

            <Divider>LLM 覆盖（可选，留空则使用全局配置）</Divider>
            <Form.Item name="llmBaseUrl" label="Base URL">
              <Input placeholder="https://api.deepseek.com/v1" />
            </Form.Item>
            <Form.Item name="llmApiKey" label="API Key">
              <Input.Password placeholder="留空使用全局 Key" />
            </Form.Item>
            <Form.Item name="llmModel" label="模型">
              <Input placeholder="deepseek-chat" />
            </Form.Item>
          </Form>
        )}
      </Drawer>

      <Modal
        title="封号风险提示"
        open={riskOpen}
        onOk={() => setRiskOpen(false)}
        onCancel={() => setRiskOpen(false)}
        okText="我已知晓"
      >
        <p>
          使用「登录 QQ 号」方式接入属于第三方协议，存在账号被限制或封禁的风险，请确认已知晓并自行承担。
        </p>
      </Modal>

      <Modal
        title="复制连接"
        open={!!copyTarget}
        onOk={doCopy}
        onCancel={() => setCopyTarget(null)}
        okText="复制"
      >
        <Form form={copyForm} layout="vertical">
          <Form.Item name="name" label="新连接名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input />
          </Form.Item>
          <p style={{ color: token.colorTextSecondary, margin: 0 }}>
            将复制源连接的凭据、人格、名单与流量控制配置（不含运行状态）。
          </p>
        </Form>
      </Modal>
    </div>
  );
}

import React, { useState } from 'react';
import { Alert, AutoComplete, Button, Input, Tooltip, message } from 'antd';
import { api } from '../api/client';

export interface ModelOption {
  ok: boolean;
  models: string[];
  message: string;
  latencyMs: number;
  baseUrl: string;
}

interface Props {
  value?: string;
  onChange?: (v: string) => void;
  /** 取当前表单里的 baseUrl / apiKey；留空则由服务端回退到已保存的配置 */
  getCredentials?: () => { baseUrl?: string; apiKey?: string };
  placeholder?: string;
}

/**
 * 模型输入框：可自由输入，也可一键从 OpenAI 兼容的 /v1/models 拉取候选。
 * 手填模型名太容易出错（大小写、前缀、代理站的别名），所以这里把列表摆出来。
 */
export default function ModelAutoComplete({ value, onChange, getCredentials, placeholder }: Props) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [hint, setHint] = useState<{ type: 'success' | 'warning' | 'error'; text: string } | null>(null);

  async function fetchModels(): Promise<void> {
    setLoading(true);
    setHint(null);
    try {
      const cred = getCredentials?.() ?? {};
      const r = await api.post<ModelOption>('/api/config/models', {
        baseUrl: cred.baseUrl || '',
        apiKey: cred.apiKey || '',
      });
      if (r.ok) {
        setModels(r.models);
        setHint({
          type: 'success',
          text: `${r.message}（${r.baseUrl}，${r.latencyMs}ms）${value && !r.models.includes(value) ? ` · 当前填写的 ${value} 不在列表中` : ''}`,
        });
        if (!value) onChange?.(r.models[0]);
      } else {
        setHint({ type: 'warning', text: r.message });
      }
    } catch (e) {
      const text = (e as Error).message;
      setHint({ type: 'error', text });
      message.error('获取模型列表失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8 }}>
        <AutoComplete
          value={value}
          onChange={(v) => onChange?.(v ?? '')}
          options={models.map((m) => ({ value: m, label: m }))}
          filterOption={(input, option) =>
            String(option?.value ?? '').toLowerCase().includes(String(input ?? '').toLowerCase())
          }
          style={{ flex: 1 }}
          popupMatchSelectWidth
        >
          <Input placeholder={placeholder ?? 'deepseek-chat'} />
        </AutoComplete>
        <Tooltip title="从服务端 /v1/models 拉取可选模型，避免手填出错">
          <Button onClick={fetchModels} loading={loading}>
            获取模型
          </Button>
        </Tooltip>
      </div>
      {hint && (
        <Alert
          style={{ marginTop: 8 }}
          type={hint.type}
          showIcon
          message={
            <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12.5 }}>{hint.text}</span>
          }
        />
      )}
    </div>
  );
}

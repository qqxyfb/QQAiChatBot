import React, { useEffect, useState } from 'react';
import { Alert, Button, Layout, Menu, Modal, Segmented, Select, Space, Typography, message, theme } from 'antd';
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAppStore } from './store';
import { api } from './api/client';
import { useTheme, type ThemeMode } from './theme';
import ConnectionsPage from './pages/ConnectionsPage';
import ConfigPage from './pages/ConfigPage';
import PersonaPage from './pages/PersonaPage';
import LogsPage from './pages/LogsPage';
import StatsPage from './pages/StatsPage';
import CostPage from './pages/CostPage';
import HistoryPage from './pages/HistoryPage';
import StickerPage from './pages/StickerPage';

const MENU = [
  { key: '/', label: '连接管理' },
  { key: '/config', label: '核心配置' },
  { key: '/persona', label: '人格管理' },
  { key: '/stickers', label: '表情包管理' },
  { key: '/logs', label: '运行日志' },
  { key: '/stats', label: '数据统计' },
  { key: '/cost', label: '使用消耗' },
  { key: '/history', label: '聊天记录' },
];

/**
 * 是否有更新：必须逐段比较，不能用 !== 判断。
 * 否则高版本运行时（例如本地 0.1.1、线上 latest 仍为 0.1.0）会误报「发现新版本 0.1.0」。
 */
function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/i, '').split(/[.-]/).map((s) => Number.parseInt(s, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export default function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}

function Shell() {
  const navigate = useNavigate();
  const location = useLocation();
  const { connections, activeConnectionId, setActive, loadConnections } = useAppStore();
  const { mode, resolved, setMode } = useTheme();
  const { token } = theme.useToken();
  const [updateInfo, setUpdateInfo] = useState<{
    current: string;
    latest: { version: string; changelog: string } | null;
  } | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    loadConnections().catch(() => undefined);
    const timer = setInterval(() => loadConnections().catch(() => undefined), 15000);
    return () => clearInterval(timer);
  }, [loadConnections]);

  useEffect(() => {
    api
      .get<{ current: string; latest: { version: string; changelog: string } | null }>('/api/update/check')
      .then(setUpdateInfo)
      .catch(() => undefined);
  }, []);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider
        width={200}
        theme={resolved === 'dark' ? 'dark' : 'light'}
        style={{ borderRight: `1px solid ${token.colorBorderSecondary}` }}
      >
        <div
          style={{
            padding: '18px 16px',
            fontWeight: 600,
            fontSize: 16,
            color: resolved === 'dark' ? '#ffffff' : token.colorText,
          }}
        >
          QQ AI ChatBot
        </div>
        <Menu
          theme={resolved === 'dark' ? 'dark' : 'light'}
          mode="inline"
          selectedKeys={[location.pathname]}
          items={MENU}
          onClick={({ key }) => navigate(key)}
        />
      </Layout.Sider>
      <Layout>
        <Layout.Header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingInline: 24,
            background: token.colorBgContainer,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <Typography.Text strong>多连接管理后台</Typography.Text>
          <Space>
            <Typography.Text type="secondary">连接筛选：</Typography.Text>
            <Select
              style={{ width: 240 }}
              value={activeConnectionId}
              onChange={setActive}
              options={[
                { value: '', label: `全部连接（${connections.length}）` },
                ...connections.map((c) => ({
                  value: c.connectionId,
                  label: `${c.name}${c.status === 'running' ? ' · 运行中' : ''}`,
                })),
              ]}
            />
            <Segmented
              size="small"
              value={mode}
              onChange={(v) => setMode(v as ThemeMode)}
              options={[
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
                { value: 'system', label: '跟随系统' },
              ]}
            />
          </Space>
        </Layout.Header>
        <Layout.Content style={{ padding: 24 }}>
          {updateInfo?.latest && isNewerVersion(updateInfo.latest.version, updateInfo.current) && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message={`发现新版本 ${updateInfo.latest.version}（当前 ${updateInfo.current}）`}
              description={(updateInfo.latest.changelog || '').slice(0, 200)}
              action={
                <Button
                  size="small"
                  loading={downloading}
                  onClick={async () => {
                    setDownloading(true);
                    try {
                      const r = await api.post<{ path: string; version: string; verified: boolean }>(
                        '/api/update/download'
                      );
                      message.success(`已下载到 ${r.path}${r.verified ? '（SHA256 校验通过）' : ''}`, 6);
                    } catch (e) {
                      // 安装包约 100MB+，失败原因往往较长（超时/网络/手动下载地址），用弹窗展示更可读
                      Modal.error({ title: '下载更新失败', content: (e as Error).message, okText: '知道了' });
                    } finally {
                      setDownloading(false);
                    }
                  }}
                >
                  {downloading ? '下载中…' : '下载更新'}
                </Button>
              }
            />
          )}
          <Routes>
            <Route path="/" element={<ConnectionsPage />} />
            <Route path="/config" element={<ConfigPage />} />
            <Route path="/persona" element={<PersonaPage />} />
            <Route path="/stickers" element={<StickerPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/stats" element={<StatsPage />} />
            <Route path="/cost" element={<CostPage />} />
            <Route path="/history" element={<HistoryPage />} />
          </Routes>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}

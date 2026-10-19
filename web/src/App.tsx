import React, { useEffect, useState } from 'react';
import { Alert, Layout, Menu, Select, Space, Typography } from 'antd';
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAppStore } from './store';
import { api } from './api/client';
import ConnectionsPage from './pages/ConnectionsPage';
import ConfigPage from './pages/ConfigPage';
import PersonaPage from './pages/PersonaPage';
import LogsPage from './pages/LogsPage';
import StatsPage from './pages/StatsPage';
import CostPage from './pages/CostPage';
import HistoryPage from './pages/HistoryPage';

const MENU = [
  { key: '/', label: '连接管理' },
  { key: '/config', label: '核心配置' },
  { key: '/persona', label: '人格管理' },
  { key: '/logs', label: '运行日志' },
  { key: '/stats', label: '数据统计' },
  { key: '/cost', label: '使用消耗' },
  { key: '/history', label: '聊天记录' },
];

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
  const [updateInfo, setUpdateInfo] = useState<{
    current: string;
    latest: { version: string; changelog: string } | null;
  } | null>(null);

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
      <Layout.Sider width={200} theme="dark">
        <div style={{ padding: '18px 16px', fontWeight: 600, fontSize: 16 }}>QQ AI ChatBot</div>
        <Menu
          theme="dark"
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
            background: '#141414',
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
          </Space>
        </Layout.Header>
        <Layout.Content style={{ padding: 24 }}>
          {updateInfo?.latest && updateInfo.latest.version !== updateInfo.current && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message={`发现新版本 ${updateInfo.latest.version}（当前 ${updateInfo.current}）`}
              description={(updateInfo.latest.changelog || '').slice(0, 200)}
            />
          )}
          <Routes>
            <Route path="/" element={<ConnectionsPage />} />
            <Route path="/config" element={<ConfigPage />} />
            <Route path="/persona" element={<PersonaPage />} />
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

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'qqab.theme';

interface ThemeCtxValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (m: ThemeMode) => void;
}

const ThemeCtx = createContext<ThemeCtxValue>({
  mode: 'light',
  resolved: 'light',
  setMode: () => undefined,
});

export function useTheme(): ThemeCtxValue {
  return useContext(ThemeCtx);
}

/**
 * ECharts 通用样式：颜色全部取自 AntD token，
 * 避免浅色主题下出现「深灰轴线 + 浅灰图例」这类不可读组合。
 */
export function useChartStyle() {
  const { token } = antdTheme.useToken();
  return useMemo(
    () => ({
      axis: {
        axisLine: { lineStyle: { color: token.colorBorder } },
        axisLabel: { color: token.colorTextSecondary },
      },
      split: { splitLine: { lineStyle: { color: token.colorBorderSecondary } } },
      legend: { color: token.colorTextSecondary },
      label: { color: token.colorText },
      text: { color: token.colorTextSecondary },
    }),
    [token]
  );
}

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* 隐私模式下 localStorage 可能抛错 */
  }
  return 'light'; // 默认浅色（长时间使用更省眼）
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
}

/**
 * 主题容器：浅色 / 深色 / 跟随系统，选择结果持久化到 localStorage。
 * ConfigProvider 放在这里，页面里用 useTheme() 取当前模式。
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(readMode);
  const [sysDark, setSysDark] = useState<boolean>(systemPrefersDark);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent): void => setSysDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved: ResolvedTheme = mode === 'system' ? (sysDark ? 'dark' : 'light') : mode;

  // 页面外的 overscroll 区域也要跟随主题，否则深色下顶部/底部会露白
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.body.style.background = resolved === 'dark' ? '#141414' : '#f5f5f5';
  }, [resolved]);

  const value = useMemo<ThemeCtxValue>(() => ({ mode, resolved, setMode }), [mode, resolved]);

  return (
    <ThemeCtx.Provider value={value}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: resolved === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: { borderRadius: 8 },
        }}
      >
        {children}
      </ConfigProvider>
    </ThemeCtx.Provider>
  );
}

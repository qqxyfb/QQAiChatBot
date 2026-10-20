import { create } from 'zustand';
import { api } from '../api/client';

export interface ConnectionItem {
  connectionId: string;
  name: string;
  type: 'official' | 'account';
  status: string;
  personaId: string;
  personaName: string;
  todayMessages: number;
  todayTokens: number;
  official?: { appId: string; appSecret: string; apiDomain?: string };
  account?: { host: string; port: number; wsMode: 'forward' | 'reverse'; accessToken?: string };
  riskConfirmed: boolean;
  chat: Record<string, unknown>;
  llmOverride?: { baseUrl: string; apiKey: string; model: string; temperature?: number; maxTokens?: number };
}

interface AppState {
  connections: ConnectionItem[];
  activeConnectionId: string; // '' = 全部连接
  historyFromHash: string; // 从统计页下钻到聊天记录时的对象筛选
  setConnections: (list: ConnectionItem[]) => void;
  setActive: (id: string) => void;
  setHistoryFromHash: (hash: string) => void;
  loadConnections: () => Promise<void>;
}

export const useAppStore = create<AppState>((set) => ({
  connections: [],
  activeConnectionId: '',
  historyFromHash: '',
  setConnections: (connections) => set({ connections }),
  setActive: (activeConnectionId) => set({ activeConnectionId }),
  setHistoryFromHash: (historyFromHash) => set({ historyFromHash }),
  loadConnections: async () => {
    const list = await api.get<ConnectionItem[]>('/api/connections');
    set({ connections: list });
  },
}));

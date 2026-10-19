import type { ConnectionConfig, ConnectionStatus } from '../types';
import { ConnectionRuntime, RuntimeDeps } from './runtime';

export interface ManagerDeps extends RuntimeDeps {
  loadConfig: (id: string) => ConnectionConfig;
  listRunning: () => string[];
  updateStatus: (id: string, status: ConnectionStatus) => void;
  startSession: (cfg: ConnectionConfig) => number;
  endSession: (sessionId: number | null) => void;
}

/** 连接管理器：维护多个连接运行时，统一生命周期 */
export class ConnectionManager {
  private runtimes = new Map<string, ConnectionRuntime>();

  constructor(private deps: ManagerDeps) {}

  create(cfg: ConnectionConfig): ConnectionRuntime {
    const rt = new ConnectionRuntime(cfg, this.deps);
    this.runtimes.set(cfg.connectionId, rt);
    return rt;
  }

  get(id: string): ConnectionRuntime | undefined {
    return this.runtimes.get(id);
  }

  list(): ConnectionRuntime[] {
    return [...this.runtimes.values()];
  }

  async start(id: string): Promise<void> {
    const rt = this.runtimes.get(id) ?? this.create(this.deps.loadConfig(id));
    if (rt.status === 'running' || rt.status === 'starting') return;

    rt.status = 'starting';
    this.deps.updateStatus(id, 'starting');
    try {
      await rt.connector.connect(rt.config);
      rt.status = 'running';
      rt.sessionId = this.deps.startSession(rt.config);
      this.deps.updateStatus(id, 'running');
    } catch (e) {
      rt.status = 'error';
      this.deps.updateStatus(id, 'error');
      throw e;
    }
  }

  async stop(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    await rt.connector.disconnect();
    rt.context.clear();
    rt.status = 'stopped';
    this.deps.endSession(rt.sessionId);
    rt.sessionId = null;
    this.deps.updateStatus(id, 'stopped');
  }

  async remove(id: string): Promise<void> {
    await this.stop(id);
    this.runtimes.delete(id);
  }

  async startAll(): Promise<void> {
    for (const rt of this.runtimes.values()) {
      if (rt.status === 'stopped' || rt.status === 'error') {
        try {
          await this.start(rt.connectionId);
        } catch {
          /* 单连接失败不影响其他连接 */
        }
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const rt of this.runtimes.values()) {
      try {
        await this.stop(rt.connectionId);
      } catch {
        /* ignore */
      }
    }
  }

  /** 服务启动时恢复上次 running 的连接（失败置 error，不阻塞整体启动） */
  async resumeAll(): Promise<void> {
    for (const id of this.deps.listRunning()) {
      try {
        const cfg = this.deps.loadConfig(id);
        const rt = this.create(cfg);
        await rt.connector.connect(cfg);
        rt.status = 'running';
        rt.sessionId = this.deps.startSession(cfg);
        this.deps.updateStatus(id, 'running');
      } catch (e) {
        this.deps.updateStatus(id, 'error');
        this.deps.emit({
          kind: 'log',
          connectionId: id,
          level: 'WARN',
          source: 'server',
          msg: `恢复连接失败：${(e as Error).message}`,
        });
      }
    }
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { Database } from './db';
import { loadMigrations, migrate } from './db/migrate';
import {
  AbuseRepo,
  BanwordRepo,
  ConnectionEventRepo,
  ConnectionRepo,
  LlmCallRepo,
  MessageRepo,
  PersonaRepo,
  SnapshotRepo,
  StickerRepo,
  TokenBudgetRepo,
} from './db/repos';
import { SecretStore } from './secret/secret-store';
import { ConfigService } from './services/config.service';
import { PersonaService } from './services/persona.service';
import { LogService } from './services/log.service';
import { StatsService } from './services/stats.service';
import { HistoryService } from './services/history.service';
import { UpdateService } from './services/update.service';
import { ConnectionService } from './services/connection.service';
import { StickerService } from './services/sticker.service';
import { TtsService } from './services/tts.service';
import { ConnectionManager } from './manager/connection-manager';
import { bus, emit } from './events/bus';
import { buildApp } from './server/app';
import { ensureDir, paths, resolveAppRoot, resolveDataDir, resolveResourceDir } from './config';
import { dayStr } from './utils/time';

async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  ensureDir(dataDir);
  const p = paths(dataDir);

  // 1) 数据库 + 迁移（启动早期，失败即退出）
  const db = Database.open(p.dbFile);
  const migrationsDir = fs.existsSync(path.join(__dirname, 'db', 'migrations'))
    ? path.join(__dirname, 'db', 'migrations')
    : path.join(resolveAppRoot(), 'src', 'db', 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`未找到数据库迁移脚本：${migrationsDir}`);
  }
  migrate(db, loadMigrations(migrationsDir), p.dbFile);

  // 2) 仓储
  const repos = {
    connection: new ConnectionRepo(db),
    persona: new PersonaRepo(db),
    banword: new BanwordRepo(db),
    message: new MessageRepo(db),
    llmCall: new LlmCallRepo(db),
    connectionEvent: new ConnectionEventRepo(db),
    abuse: new AbuseRepo(db),
    tokenBudget: new TokenBudgetRepo(db),
    snapshot: new SnapshotRepo(db),
  };

  // 3) 配置 / 密钥 / 日志 / 人格
  const secret = new SecretStore(p.secretsFile);
  const configService = new ConfigService(p.configFile, secret, repos.snapshot);
  const globalCfg = configService.load();
  const logService = new LogService(p.logDir);
  const personaService = new PersonaService(
    repos.persona,
    repos.connection,
    configService,
    resolveResourceDir()
  );
  personaService.ensureDefaults();
  repos.banword.load();

  // 2.1) 表情包仓储（内存倒排索引）
  ensureDir(p.stickerDir);
  const stickerRepo = new StickerRepo(db, p.stickerDir);
  stickerRepo.load();
  const stickerService = new StickerService(stickerRepo, p.stickerDir);

  // 2.2) TTS 服务（语音落盘目录）
  const ttsService = new TtsService(p.ttsDir);

  // 4) 事件消费者
  bus.on('message', (e) => repos.message.insert(e));
  bus.on('llm_call', (e) => repos.llmCall.insert(e));
  bus.on('connection', (e) =>
    repos.connectionEvent.insert(e.connectionId, e.event, e.connectorType, e.detail)
  );
  bus.on('abuse', (e) => repos.abuse.insert(e.connectionId, e.fromHash, e.reason, e.abuseKind));
  bus.on('log', (e) => logService.ingest(e));

  // 5) 连接管理器（loadConfig 延迟引用 connectionService）
  let connectionService: ConnectionService;
  const manager = new ConnectionManager({
    personaRepo: repos.persona,
    banwordRepo: repos.banword,
    tokenBudgetRepo: repos.tokenBudget,
    getGlobalLlm: () => configService.load().llm,
    emit,
    getStickerTags: (setId) => stickerRepo.getTags(setId),
    getStickerIndex: () => stickerRepo.getCache(),
    getGlobalTts: () => configService.load().tts,
    synthesizeVoice: (text, cfg) => ttsService.synthesizeToSegment(text, cfg),
    loadConfig: (id) => {
      const cfg = connectionService.get(id);
      if (!cfg) throw new Error(`连接不存在：${id}`);
      return cfg;
    },
    listRunning: () => repos.connection.listByStatus('running').map((r) => r.connection_id),
    updateStatus: (id, s) => repos.connection.updateStatus(id, s),
    startSession: (cfg) => {
      const r = db
        .prepare(
          'INSERT INTO run_session(connection_id,start_at,connector_type,persona,model,status) VALUES(?,?,?,?,?,?)'
        )
        .run(
          cfg.connectionId,
          Date.now(),
          cfg.type,
          cfg.personaId,
          (cfg.llmOverride ?? globalCfg.llm).model,
          'running'
        );
      return Number(r.lastInsertRowid);
    },
    endSession: (sid) => {
      if (sid) {
        db.prepare('UPDATE run_session SET end_at=?, status=? WHERE id=?').run(Date.now(), 'stopped', sid);
      }
    },
  });

  connectionService = new ConnectionService(
    db,
    repos.connection,
    repos.persona,
    manager,
    secret,
    configService
  );

  // 6) 其余服务
  const statsService = new StatsService(db, configService);
  const historyService = new HistoryService(db, repos.message);
  const updateService = new UpdateService(configService, dataDir);

  // 7) HTTP 服务
  const app = await buildApp(
    {
      config: configService,
      connection: connectionService,
      persona: personaService,
      log: logService,
      stats: statsService,
      history: historyService,
      update: updateService,
      banword: repos.banword,
      sticker: stickerService,
      tts: ttsService,
    },
    { allowLan: globalCfg.server.allowLan, accessToken: globalCfg.server.accessToken }
  );

  const port = Number(process.env.QQAICHATBOT_PORT) || globalCfg.server.port;
  const host = globalCfg.server.allowLan ? '0.0.0.0' : '127.0.0.1';
  await app.listen({ host, port });
  logService.info('server', `服务已启动：http://${host}:${port}`);

  // 8) 恢复上次 running 的连接（失败不阻塞）
  await manager.resumeAll().catch((e) => {
    logService.warn('server', `恢复连接失败：${(e as Error).message}`);
  });

  // 9) 上下文定时清理
  const gcTimer = setInterval(() => {
    for (const rt of manager.list()) rt.context.gc();
  }, 60_000);
  gcTimer.unref();

  // 9.1) 数据保留清理（每小时）
  const retentionTimer = setInterval(() => {
    try {
      const cfg = configService.load();
      const now = Date.now();
      if (cfg.storage.historyRetentionDays > 0) {
        const cutoff = now - cfg.storage.historyRetentionDays * 86400_000;
        repos.message.cleanupBefore(cutoff);
        repos.llmCall.cleanupBefore(cutoff);
      }
      // token_budget 保留 90 天
      repos.tokenBudget.cleanupBeforeDay(dayStr(now - 90 * 86400_000));
    } catch (e) {
      logService.warn('server', `数据清理失败：${(e as Error).message}`);
    }
  }, 3600_000);
  retentionTimer.unref();

  // 10) 更新检测（静默，不阻塞）
  if (globalCfg.update.autoCheck) {
    updateService
      .check()
      .then((info) => {
        if (info?.version) logService.info('server', `检测到最新版本：${info.version}`);
      })
      .catch(() => undefined);
  }

  // 11) 优雅退出
  const shutdown = async (): Promise<void> => {
    logService.info('server', '正在关闭服务...');
    await manager.stopAll().catch(() => undefined);
    await app.close().catch(() => undefined);
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});

import React, { useEffect, useState } from 'react';
import { Card, Col, Row, Segmented, Space, Statistic, Table, message } from 'antd';
import ReactECharts from 'echarts-for-react';
import { api } from '../api/client';
import { useAppStore } from '../store';

interface Overview {
  messages: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  activeObjects: number;
  avgLatencyMs: number;
  errorRate: number;
  blocked: number;
  connectionCount: number;
  runningCount: number;
  cost: number;
}

interface SeriesPoint {
  bucket: string;
  messages: number;
  prompt: number;
  completion: number;
}
interface HourPoint {
  hour: string;
  prompt: number;
  completion: number;
}

const axisStyle = { axisLine: { lineStyle: { color: '#555' } }, axisLabel: { color: '#aaa' } };
const splitStyle = { splitLine: { lineStyle: { color: '#2a2a2a' } } };

export default function StatsPage() {
  const { activeConnectionId } = useAppStore();
  const [ov, setOv] = useState<Overview | null>(null);
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [hourly, setHourly] = useState<HourPoint[]>([]);
  const [lat, setLat] = useState<{ p50: number; p95: number; p99: number; hist: number[] }>({
    p50: 0,
    p95: 0,
    p99: 0,
    hist: [],
  });
  const [dist, setDist] = useState<Record<string, number>>({});
  const [top, setTop] = useState<Array<{ fromHash: string; messages: number; tokens: number }>>([]);
  const [perConn, setPerConn] = useState<
    Array<{ connectionId: string; name: string; messages: number; tokens: number; cost: number }>
  >([]);
  const [gran, setGran] = useState<'day' | 'hour'>('day');

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnectionId, gran]);

  async function load() {
    const q = activeConnectionId ? `?connectionId=${activeConnectionId}` : '';
    const qg = `${q}${q ? '&' : '?'}granularity=${gran}&days=7`;
    try {
      const [o, s, h, l, d, t, pc] = await Promise.all([
        api.get<Overview>(`/api/stats/overview${q}`),
        api.get<SeriesPoint[]>(`/api/stats/timeseries${qg}`),
        api.get<HourPoint[]>(`/api/stats/hourly-tokens${q}`),
        api.get<{ p50: number; p95: number; p99: number; hist: number[] }>(`/api/stats/latency${q}`),
        api.get<Record<string, number>>(`/api/stats/result-dist${q}`),
        api.get<Array<{ fromHash: string; messages: number; tokens: number }>>(`/api/stats/top-objects${q}`),
        api.get<Array<{ connectionId: string; name: string; messages: number; tokens: number; cost: number }>>(
          '/api/stats/per-connection'
        ),
      ]);
      setOv(o);
      setSeries(s);
      setHourly(h);
      setLat(l);
      setDist(d);
      setTop(t);
      setPerConn(pc);
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        <Col span={4}><Card><Statistic title="今日消息" value={ov?.messages ?? 0} /></Card></Col>
        <Col span={4}><Card><Statistic title="今日 Token" value={ov?.totalTokens ?? 0} /></Card></Col>
        <Col span={4}><Card><Statistic title="今日费用" value={ov?.cost ?? 0} precision={4} prefix="¥" /></Card></Col>
        <Col span={4}><Card><Statistic title="活跃对象" value={ov?.activeObjects ?? 0} /></Card></Col>
        <Col span={4}><Card><Statistic title="错误率" value={(ov?.errorRate ?? 0) * 100} precision={1} suffix="%" /></Card></Col>
        <Col span={4}><Card><Statistic title="连接（运行/总）" value={`${ov?.runningCount ?? 0}/${ov?.connectionCount ?? 0}`} /></Card></Col>
      </Row>

      <Space>
        <span style={{ color: '#aaa' }}>时间粒度：</span>
        <Segmented value={gran} onChange={(v) => setGran(v as 'day' | 'hour')} options={[{ value: 'day', label: '按天' }, { value: 'hour', label: '按小时' }]} />
      </Space>

      <Card title="消息 / Token 趋势">
        <ReactECharts
          style={{ height: 320 }}
          option={{
            backgroundColor: 'transparent',
            tooltip: { trigger: 'axis' },
            legend: { data: ['消息数', '输入 Token', '输出 Token'], textStyle: { color: '#aaa' } },
            grid: { left: 50, right: 30, top: 40, bottom: 30 },
            xAxis: { type: 'category', data: series.map((x) => x.bucket), ...axisStyle },
            yAxis: { type: 'value', ...axisStyle, ...splitStyle },
            series: [
              { name: '消息数', type: 'line', smooth: true, data: series.map((x) => x.messages) },
              { name: '输入 Token', type: 'line', smooth: true, data: series.map((x) => x.prompt) },
              { name: '输出 Token', type: 'line', smooth: true, data: series.map((x) => x.completion) },
            ],
          }}
        />
      </Card>

      <Row gutter={[16, 16]}>
        <Col span={12}>
          <Card title="时段 Token 消耗（今日）">
            <ReactECharts
              style={{ height: 280 }}
              option={{
                backgroundColor: 'transparent',
                tooltip: { trigger: 'axis' },
                grid: { left: 50, right: 20, top: 20, bottom: 30 },
                xAxis: { type: 'category', data: hourly.map((x) => `${x.hour}:00`), ...axisStyle },
                yAxis: { type: 'value', ...axisStyle, ...splitStyle },
                series: [{ type: 'bar', name: 'Token', data: hourly.map((x) => x.prompt + x.completion) }],
              }}
            />
          </Card>
        </Col>
        <Col span={12}>
          <Card title={`延迟分布（P50 ${lat.p50}ms / P95 ${lat.p95}ms / P99 ${lat.p99}ms）`}>
            <ReactECharts
              style={{ height: 280 }}
              option={{
                backgroundColor: 'transparent',
                tooltip: { trigger: 'axis' },
                grid: { left: 50, right: 20, top: 20, bottom: 30 },
                xAxis: {
                  type: 'category',
                  data: ['0-1s', '1-2s', '2-3s', '3-4s', '4-5s', '5-6s', '6-7s', '7-8s', '8-9s', '9s+'],
                  ...axisStyle,
                },
                yAxis: { type: 'value', ...axisStyle, ...splitStyle },
                series: [{ type: 'bar', name: '次数', data: lat.hist }],
              }}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col span={12}>
          <Card title="结果分布">
            <ReactECharts
              style={{ height: 300 }}
              option={{
                backgroundColor: 'transparent',
                tooltip: { trigger: 'item' },
                legend: { textStyle: { color: '#aaa' } },
                series: [
                  {
                    type: 'pie',
                    radius: '62%',
                    data: Object.entries(dist).map(([k, v]) => ({ name: k, value: v })),
                    label: { color: '#ccc' },
                  },
                ],
              }}
            />
          </Card>
        </Col>
        <Col span={12}>
          <Card title="Top 消耗对象（脱敏）">
            <ReactECharts
              style={{ height: 300 }}
              option={{
                backgroundColor: 'transparent',
                tooltip: { trigger: 'axis' },
                grid: { left: 90, right: 20, top: 20, bottom: 30 },
                xAxis: { type: 'value', ...axisStyle, ...splitStyle },
                yAxis: { type: 'category', data: top.map((x) => x.fromHash), ...axisStyle },
                series: [{ type: 'bar', data: top.map((x) => x.tokens) }],
              }}
            />
          </Card>
        </Col>
      </Row>

      <Card title="分连接对比（今日）">
        <ReactECharts
          style={{ height: 300 }}
          option={{
            backgroundColor: 'transparent',
            tooltip: { trigger: 'axis' },
            legend: { data: ['消息数', 'Token'], textStyle: { color: '#aaa' } },
            grid: { left: 60, right: 60, top: 40, bottom: 40 },
            xAxis: { type: 'category', data: perConn.map((x) => x.name), ...axisStyle },
            yAxis: [
              { type: 'value', name: '消息', ...axisStyle, ...splitStyle },
              { type: 'value', name: 'Token', ...axisStyle, ...splitStyle },
            ],
            series: [
              { name: '消息数', type: 'bar', data: perConn.map((x) => x.messages) },
              { name: 'Token', type: 'bar', yAxisIndex: 1, data: perConn.map((x) => x.tokens) },
            ],
          }}
        />
      </Card>

      <Card title="对象明细">
        <Table
          size="small"
          rowKey="fromHash"
          dataSource={top}
          pagination={false}
          columns={[
            { title: '对象（哈希）', dataIndex: 'fromHash' },
            { title: '消息数', dataIndex: 'messages' },
            { title: 'Token', dataIndex: 'tokens' },
          ]}
        />
      </Card>
    </Space>
  );
}

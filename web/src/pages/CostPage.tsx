import React, { useEffect, useState } from 'react';
import { Card, Col, Row, Space, Statistic, message } from 'antd';
import ReactECharts from 'echarts-for-react';
import { api } from '../api/client';
import { useAppStore } from '../store';
import { useChartStyle } from '../theme';

interface CostSummary {
  today: number;
  week: number;
  month: number;
  monthEstimate: number;
}

export default function CostPage() {
  const { activeConnectionId } = useAppStore();
  const { axis: axisStyle, split: splitStyle, legend: legendStyle, text: textStyle } = useChartStyle();
  const [cost, setCost] = useState<CostSummary>({ today: 0, week: 0, month: 0, monthEstimate: 0 });
  const [hourly, setHourly] = useState<Array<{ hour: string; prompt: number; completion: number }>>([]);
  const [todayTokens, setTodayTokens] = useState(0);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnectionId]);

  async function load() {
    const q = activeConnectionId ? `?connectionId=${activeConnectionId}` : '';
    try {
      const [c, h, o] = await Promise.all([
        api.get<CostSummary>(`/api/stats/cost${q}`),
        api.get<Array<{ hour: string; prompt: number; completion: number }>>(`/api/stats/hourly-tokens${q}`),
        api.get<{ totalTokens: number }>(`/api/stats/overview${q}`),
      ]);
      setCost(c);
      setHourly(h);
      setTodayTokens(o.totalTokens);
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        <Col span={6}><Card><Statistic title="今日费用" value={cost.today} precision={4} prefix="¥" /></Card></Col>
        <Col span={6}><Card><Statistic title="近 7 天" value={cost.week} precision={4} prefix="¥" /></Card></Col>
        <Col span={6}><Card><Statistic title="近 30 天" value={cost.month} precision={4} prefix="¥" /></Card></Col>
        <Col span={6}><Card><Statistic title="月度预估" value={cost.monthEstimate} precision={4} prefix="¥" /></Card></Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col span={6}><Card><Statistic title="今日 Token" value={todayTokens} /></Card></Col>
        <Col span={18}>
          <Card title="费用说明">
            <p style={{ ...textStyle, margin: 0 }}>
              费用 = (输入 Token × 输入单价 + 输出 Token × 输出单价) / 1,000,000。
              单价在「核心配置 → 成本单价」中按模型填写（元 / 百万 token）。未配置单价的模型显示为「未计价」。
            </p>
          </Card>
        </Col>
      </Row>

      <Card title="时段 Token 消耗（今日）">
        <ReactECharts
          style={{ height: 360 }}
          option={{
            backgroundColor: 'transparent',
            tooltip: { trigger: 'axis' },
            legend: { data: ['输入 Token', '输出 Token'], textStyle: legendStyle },
            grid: { left: 60, right: 30, top: 40, bottom: 30 },
            xAxis: {
              type: 'category',
              data: hourly.map((x) => `${x.hour}:00`),
              ...axisStyle,
            },
            yAxis: {
              type: 'value',
              ...axisStyle,
              ...splitStyle,
            },
            series: [
              { name: '输入 Token', type: 'bar', stack: 'total', data: hourly.map((x) => x.prompt) },
              { name: '输出 Token', type: 'bar', stack: 'total', data: hourly.map((x) => x.completion) },
            ],
          }}
        />
      </Card>
    </Space>
  );
}

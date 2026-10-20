import React, { useEffect, useRef, useState } from 'react';
import { Button, Card, Empty, Image, Input, Modal, Popconfirm, Select, Space, Tag, message } from 'antd';
import { api } from '../api/client';
import type { Sticker, StickerSet } from '../types';

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    r.readAsDataURL(file);
  });
}

export default function StickerPage() {
  const [sets, setSets] = useState<StickerSet[]>([]);
  const [activeSet, setActiveSet] = useState<string>('');
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [newSetOpen, setNewSetOpen] = useState(false);
  const [newSetName, setNewSetName] = useState('');
  const [tagEdit, setTagEdit] = useState<Sticker | null>(null);
  const [tagText, setTagText] = useState('');
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function loadSets(preferred?: string) {
    const s = await api.get<StickerSet[]>('/api/stickers/sets');
    setSets(s);
    const next = preferred ?? activeSet ?? s[0]?.id ?? '';
    setActiveSet(next);
  }

  async function loadStickers(setId: string) {
    if (!setId) {
      setStickers([]);
      return;
    }
    setStickers(await api.get<Sticker[]>(`/api/stickers/sets/${setId}/stickers`));
  }

  useEffect(() => {
    loadSets().catch((e) => message.error((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeSet) loadStickers(activeSet).catch((e) => message.error((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSet]);

  async function createSet() {
    if (!newSetName.trim()) return;
    try {
      await api.post('/api/stickers/sets', { name: newSetName.trim() });
      message.success('已创建');
      setNewSetOpen(false);
      setNewSetName('');
      await loadSets();
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  async function removeSet(id: string) {
    try {
      await api.del(`/api/stickers/sets/${id}`);
      message.success('已删除');
      await loadSets('');
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  async function importFiles(files: FileList | null) {
    if (!files || !files.length || !activeSet) return;
    setImporting(true);
    try {
      const list: Array<{ name: string; data: string }> = [];
      for (const f of Array.from(files)) {
        list.push({ name: f.name, data: await readAsBase64(f) });
      }
      const r = await api.post<{ total: number; tagged: number; untagged: number; failed: string[] }>(
        '/api/stickers/import',
        { setId: activeSet, files: list }
      );
      message.success(`导入完成：共 ${r.total} 张，自动打标签 ${r.tagged}，待打标签 ${r.untagged}${r.failed.length ? `，失败 ${r.failed.length}` : ''}`);
      await loadStickers(activeSet);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function saveTags() {
    if (!tagEdit) return;
    try {
      const tags = tagText
        .split(/[,，、\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      await api.put(`/api/stickers/${tagEdit.id}/tags`, { tags });
      message.success('已保存标签');
      setTagEdit(null);
      await loadStickers(activeSet);
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  async function removeSticker(id: string) {
    try {
      await api.del(`/api/stickers/${id}`);
      message.success('已删除');
      await loadStickers(activeSet);
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  const activeIsDefault = sets.find((s) => s.id === activeSet)?.isDefault ?? false;

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          style={{ width: 220 }}
          value={activeSet || undefined}
          placeholder="选择表情包组"
          onChange={(v) => setActiveSet(v)}
          options={sets.map((s) => ({ value: s.id, label: s.isDefault ? `${s.name}（默认）` : s.name }))}
        />
        <Button onClick={() => setNewSetOpen(true)}>新建组</Button>
        <Button type="primary" loading={importing} onClick={() => fileRef.current?.click()} disabled={!activeSet}>
          导入表情
        </Button>
        <Popconfirm
          title="确认删除该表情包组？"
          onConfirm={() => removeSet(activeSet)}
          disabled={!activeSet || activeIsDefault}
        >
          <Button danger disabled={!activeSet || activeIsDefault}>
            删除组
          </Button>
        </Popconfirm>
        <span style={{ color: '#8c8c8c', fontSize: 12 }}>
          提示：文件命名「标签_任意.png」（如 开心_01.png）导入时自动打标签；也可导入后手动补标签。
        </span>
      </Space>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => importFiles(e.target.files)}
      />

      {stickers.length === 0 ? (
        <Empty description="该组暂无表情，点击「导入表情」批量上传" />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 16 }}>
          {stickers.map((s) => (
            <Card
              key={s.id}
              size="small"
              styles={{ body: { padding: 8 } }}
              actions={[
                <Button
                  key="tag"
                  type="link"
                  size="small"
                  onClick={() => {
                    setTagEdit(s);
                    setTagText((s.tags ?? []).join('，'));
                  }}
                >
                  标签
                </Button>,
                <Popconfirm key="del" title="确认删除该表情？" onConfirm={() => removeSticker(s.id)}>
                  <Button type="link" size="small" danger>
                    删除
                  </Button>
                </Popconfirm>,
              ]}
            >
              <Image src={`/api/stickers/file/${s.id}`} height={100} width="100%" style={{ objectFit: 'contain' }} />
              <div style={{ marginTop: 6, minHeight: 24 }}>
                {(s.tags ?? []).map((t) => (
                  <Tag key={t} style={{ marginBottom: 2 }}>
                    {t}
                  </Tag>
                ))}
                {!(s.tags ?? []).length && <span style={{ color: '#bbb', fontSize: 12 }}>未打标签</span>}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal title="新建表情包组" open={newSetOpen} onOk={createSet} onCancel={() => setNewSetOpen(false)} width={420}>
        <Input
          value={newSetName}
          onChange={(e) => setNewSetName(e.target.value)}
          placeholder="组名称，如「可爱风」「沙雕风」"
          onPressEnter={createSet}
        />
      </Modal>

      <Modal
        title={`编辑标签 · ${tagEdit?.fileName ?? ''}`}
        open={!!tagEdit}
        onOk={saveTags}
        onCancel={() => setTagEdit(null)}
        width={480}
      >
        <Input.TextArea
          rows={3}
          value={tagText}
          onChange={(e) => setTagText(e.target.value)}
          placeholder="多个标签用逗号分隔，如：开心，笑，哈哈"
        />
      </Modal>
    </div>
  );
}

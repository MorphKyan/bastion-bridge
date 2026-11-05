import React, { useState, useRef, useEffect } from 'react';
import type { Config } from '../src/shared';

export function ConfigEditor({
  initial,
  busy,
  save,
  assetIndex,
  close,
  closeRequest,
}: {
  initial: Config;
  busy: boolean;
  assetIndex?: number;
  close: () => void;
  closeRequest: number;
  save: (config: Config) => Promise<unknown>;
}) {
  const [config, setConfig] = useState(initial);
  const [error, setError] = useState('');
  const [removed, setRemoved] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const dirty = JSON.stringify(config) !== JSON.stringify(initial);
  function dismiss() {
    if (busy) return;
    if (!dirty) return close();
    setConfirmClose(true);
  }
  const [confirmClose, setConfirmClose] = useState(false);
  useEffect(() => {
    if (closeRequest) dismiss();
  }, [closeRequest]);
  return (
    <form
      ref={form}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          dismiss();
        }
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        setError('');
        try {
          await save(config);
        } catch (error) {
          setError(error instanceof Error ? error.message : '保存失败，请重试。');
        }
      }}
    >
      <p>
        连接参数修改后在下次连接生效；删除或重命名已连接资产前需关闭连接。密码通过“用户名与密码”单独设置。
      </p>
      {error && <p role="alert">{error}</p>}
      <fieldset hidden={assetIndex !== undefined} disabled={busy} className="config-fields">
        <legend>堡垒机</legend>
        {config.bastions.map((bastion, index) => (
          <fieldset key={index}>
            <legend>堡垒机 {index + 1}</legend>
            <div className="config-grid">
              {(['id', 'name', 'host', 'port', 'username', 'fingerprint'] as const).map((field) => (
                <label key={field}>
                  {
                    {
                      id: '标识',
                      name: '显示名称',
                      host: '主机地址',
                      port: 'SSH 端口',
                      username: '登录用户名',
                      fingerprint: 'SSH 指纹（可选）',
                    }[field]
                  }
                  <input
                    required={field !== 'fingerprint'}
                    type={field === 'port' ? 'number' : 'text'}
                    min={field === 'port' ? 1 : undefined}
                    max={field === 'port' ? 65535 : undefined}
                    value={bastion[field] ?? ''}
                    onChange={(event) =>
                      setConfig({
                        ...config,
                        bastions: config.bastions.map((b, i) =>
                          i === index
                            ? {
                                ...b,
                                [field]:
                                  field === 'port'
                                    ? Number(event.target.value)
                                    : event.target.value || undefined,
                              }
                            : b,
                        ),
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <button
              type="button"
              className="danger"
              onClick={() =>
                setConfig({ ...config, bastions: config.bastions.filter((_, i) => i !== index) })
              }
            >
              删除堡垒机 {index + 1}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          onClick={() =>
            setConfig({
              ...config,
              bastions: [
                ...config.bastions,
                { id: '', name: '', host: '', port: 22, username: '' },
              ],
            })
          }
        >
          添加堡垒机
        </button>
      </fieldset>
      <fieldset disabled={busy} className="config-fields">
        <legend>服务器</legend>
        {config.assets.map((asset, index) => (
          <fieldset
            key={index}
            hidden={removed || (assetIndex !== undefined && assetIndex !== index)}
          >
            <legend>服务器 {index + 1}</legend>
            <div className="config-grid">
              {(['name', 'ip', 'username', 'promptPattern'] as const).map((field) => (
                <label key={field}>
                  {
                    {
                      name: '服务器名称',
                      ip: 'IP 地址',
                      username: '服务器用户名（可选）',
                      promptPattern: 'Shell 提示符正则（可选）',
                    }[field]
                  }
                  <input
                    required={field === 'name' || field === 'ip'}
                    value={asset[field] ?? ''}
                    onChange={(event) =>
                      setConfig({
                        ...config,
                        assets: config.assets.map((a, i) =>
                          i === index ? { ...a, [field]: event.target.value || undefined } : a,
                        ),
                      })
                    }
                  />
                </label>
              ))}
              <label>
                所属堡垒机
                <select
                  required
                  value={asset.bastion}
                  onChange={(event) =>
                    setConfig({
                      ...config,
                      assets: config.assets.map((a, i) =>
                        i === index ? { ...a, bastion: event.target.value } : a,
                      ),
                    })
                  }
                >
                  <option value="">请选择堡垒机</option>
                  {config.bastions.map((b, i) => (
                    <option key={i} value={b.id}>
                      {b.name || b.id}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button
              type="button"
              className="danger"
              onClick={() => {
                setConfig({ ...config, assets: config.assets.filter((_, i) => i !== index) });
                if (assetIndex !== undefined) setRemoved(true);
              }}
            >
              删除服务器 {index + 1}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          hidden={assetIndex !== undefined}
          disabled={!config.bastions.length}
          onClick={() =>
            setConfig({
              ...config,
              assets: [...config.assets, { name: '', ip: '', bastion: config.bastions[0].id }],
            })
          }
        >
          添加服务器
        </button>
      </fieldset>
      <fieldset hidden={assetIndex !== undefined} disabled={busy} className="config-fields">
        <legend>后台设置</legend>
        <div className="config-grid">
          <label>
            占用时长（秒）
            <input
              required
              type="number"
              min={10}
              max={86400}
              value={config.leaseSeconds}
              onChange={(event) =>
                setConfig({ ...config, leaseSeconds: Number(event.target.value) })
              }
            />
          </label>
          <label>
            网页端口
            <input
              required
              type="number"
              min={1024}
              max={65535}
              value={config.port}
              onChange={(event) => setConfig({ ...config, port: Number(event.target.value) })}
            />
          </label>
        </div>
        <p>网页端口修改后需重启后台生效。</p>
      </fieldset>
      {confirmClose && (
        <div role="alert">
          <p>配置已修改，是否保存？</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setConfirmClose(false);
              form.current?.requestSubmit();
            }}
          >
            保存并关闭
          </button>
          <button type="button" disabled={busy} onClick={close}>
            不保存
          </button>
          <button type="button" onClick={() => setConfirmClose(false)}>
            继续编辑
          </button>
        </div>
      )}
      <div className="modal-actions">
        <button className="primary" disabled={busy}>
          保存配置
        </button>
      </div>
    </form>
  );
}

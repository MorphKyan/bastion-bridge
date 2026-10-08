import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import type {
  Config,
  SessionView,
  Batch,
  Operation,
  OperationResult,
  Binding,
} from '../src/shared';

type State = {
  config: Config;
  sessions: SessionView[];
  batches: Batch[];
  credentials: Record<string, boolean>;
  operations: Operation[];
  webUrl: string;
};
const labels: Record<string, string> = {
  connecting: '连接中',
  needs_host_verification: '核实主机',
  needs_password: '需要密码',
  waiting_code: '等待验证码',
  needs_username: '选择账号',
  ready: '已连接',
  recovering: '中断确认中',
  needs_attention: '待人工处理',
  target_closed: '目标连接结束',
  disconnected: '未连接',
  error: '连接失败',
  running: '执行中',
  completed: '已完成',
  interrupted: '已中断',
  unknown: '结果未知',
  paused: '已暂停',
  cancelled: '已取消',
};
async function call(action: string, args: unknown = {}): Promise<any> {
  const response = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args, owner: '网页用户' }),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.error.message);
  return result.result;
}
function WebTerminal({
  asset,
  token,
  report,
}: {
  asset: string;
  token?: string;
  report: (message: string) => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const resizeRef = useRef<() => void>(undefined);
  useEffect(() => {
    if (token) resizeRef.current?.();
  }, [token]);
  useEffect(() => {
    const terminal = new Terminal({
      fontSize: 13,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: '#101821',
        foreground: '#d7e0e9',
        cursor: '#78d6bd',
        selectionBackground: '#35536b',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(mount.current!);
    fit.fit();
    const socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/terminal/${encodeURIComponent(asset)}`,
    );
    const resize = () => {
      fit.fit();
      if (socket.readyState === 1 && tokenRef.current)
        socket.send(
          JSON.stringify({
            type: 'resize',
            leaseToken: tokenRef.current,
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
    };
    resizeRef.current = resize;
    socket.onopen = resize;
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'snapshot') {
        terminal.reset();
        terminal.write(message.text.replace(/\n\s*$/, '').replace(/\r?\n/g, '\r\n'));
      }
      if (message.type === 'output')
        terminal.write(message.text, () => {
          if (socket.readyState === 1)
            socket.send(
              JSON.stringify({ type: 'ack', bytes: new TextEncoder().encode(message.text).length }),
            );
        });
      if (message.type === 'error') report(message.message);
    };
    const subscription = terminal.onData((text) => {
      if (socket.readyState === 1 && tokenRef.current)
        socket.send(JSON.stringify({ type: 'input', text, leaseToken: tokenRef.current }));
    });
    const observer = new ResizeObserver(resize);
    observer.observe(mount.current!);
    return () => {
      observer.disconnect();
      subscription.dispose();
      socket.close();
      terminal.dispose();
    };
  }, [asset]);
  return <div className="terminal-container" ref={mount} data-testid="terminal" />;
}
function App() {
  const [state, setState] = useState<State>();
  const [asset, setAsset] = useState(new URLSearchParams(location.search).get('asset') ?? '');
  const [selected, setSelected] = useState<string[]>([]);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [online, setOnline] = useState(true);
  const [modal, setModal] = useState<'credentials' | 'config' | 'import' | undefined>();
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [configText, setConfigText] = useState('');
  const [discovered, setDiscovered] = useState<Binding[]>([]);
  const [importIndex, setImportIndex] = useState(0);
  const [command, setCommand] = useState('');
  const [cwd, setCwd] = useState('');
  const [subshell, setSubshell] = useState(false);
  const [result, setResult] = useState<OperationResult>();
  const batchRef = useRef('');
  useEffect(() => {
    const events = new EventSource('/api/events');
    events.onmessage = (event) => {
      setState(JSON.parse(event.data));
      setOnline(true);
    };
    events.onerror = () => setOnline(false);
    fetch('/api/state')
      .then((r) => r.json())
      .then(setState)
      .catch(() => setOnline(false));
    return () => events.close();
  }, []);
  useEffect(() => {
    if (state?.config.assets.length && !state.config.assets.some((a) => a.name === asset))
      setAsset(state.config.assets[0].name);
  }, [state, asset]);
  useEffect(() => {
    const b = state?.batches.find((b) => b.status === 'running' || b.status === 'paused');
    if (b) {
      const key = `${b.id}:${b.index}`;
      if (key !== batchRef.current && b.assets[b.index]) {
        batchRef.current = key;
        setAsset(b.assets[b.index]);
      }
    }
  }, [state?.batches]);
  useEffect(() => {
    const timer = setInterval(() => {
      for (const [name, token] of Object.entries(tokens))
        void call('renew', { asset: name, leaseToken: token }).catch(() =>
          setTokens((t) => {
            if (t[name] !== token) return t;
            const n = { ...t };
            delete n[name];
            return n;
          }),
        );
    }, 15000);
    return () => clearInterval(timer);
  }, [tokens]);
  useEffect(() => {
    if (result?.status !== 'running') return;
    let active = true;
    let waiting = false;
    const timer = setInterval(() => {
      if (waiting) return;
      waiting = true;
      void call('operation_wait', {
        operationId: result.id,
        waitMs: 0,
        leaseToken: result.leaseToken,
      })
        .then((next) => {
          if (active) setResult((r) => (r?.id === result.id && r.status === 'running' ? next : r));
        })
        .catch((e) => {
          if (!active) return;
          setNotice(e.message);
          setResult((r) =>
            r?.id === result.id && r.status === 'running'
              ? { ...r, status: 'unknown', message: e.message }
              : r,
          );
        })
        .finally(() => {
          waiting = false;
        });
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [result?.id, result?.status, result?.leaseToken]);
  const current = state?.sessions.find((s) => s.asset === asset);
  const configAsset = state?.config.assets.find((a) => a.name === asset);
  const bastion = state?.config.bastions.find((b) => b.id === configAsset?.bastion);
  const token = tokens[asset];
  const activeBatch = state?.batches.find((b) => b.status === 'running' || b.status === 'paused');
  async function perform(fn: () => Promise<any>) {
    setBusy(true);
    setNotice('');
    try {
      return await fn();
    } catch (e: any) {
      setNotice(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function sessionAction(action: string, extra = {}) {
    return perform(() => call(action, { asset, ...extra }));
  }
  async function credentialsOpen() {
    setUsername(bastion?.username ?? '');
    setPassword('');
    setRemember(Boolean(bastion && state?.credentials[bastion.id]));
    setModal('credentials');
  }
  async function run() {
    const response = await perform(() =>
      call(subshell ? 'subshell_exec' : 'exec', {
        asset,
        command,
        cwd: cwd || undefined,
        leaseToken: token,
        requestId: crypto.randomUUID(),
        waitMs: 30000,
      }),
    );
    if (response?.id) setResult(response);
    else if (response) setNotice(`需要人工完成连接：${labels[response.status] ?? response.status}`);
  }
  if (!state) return <main className="loading">正在连接本机会话后台…</main>;
  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="brand-icon">›_</span>
          <div>
            <strong>bastion bridge</strong>
            <span>堡垒机会话工作台</span>
          </div>
        </div>
        <div className="header-actions">
          <span className={`dot ${online ? 'on' : ''}`} />
          {online ? '本机后台在线' : '正在重新连接'}
          <button
            onClick={() => {
              setConfigText(JSON.stringify(state.config, null, 2));
              setModal('config');
            }}
          >
            配置
          </button>
        </div>
      </header>
      {notice && (
        <div className="notice" role="alert">
          {notice}
          <button onClick={() => setNotice('')}>关闭</button>
        </div>
      )}
      <div className="workspace">
        <aside>
          <div className="section-top">
            <h2>资产会话</h2>
            <span>{state.config.assets.length}</span>
          </div>
          <div className="select-tools">
            <button
              onClick={() =>
                setSelected(
                  selected.length === state.config.assets.length
                    ? []
                    : state.config.assets.map((a) => a.name),
                )
              }
            >
              全选 / 清空
            </button>
            <button
              className="primary"
              disabled={busy || !selected.length || Boolean(activeBatch)}
              onClick={() => perform(() => call('batch_start', { assets: selected }))}
            >
              串行登录 ({selected.length})
            </button>
          </div>
          <div className="assets">
            {state.config.assets.map((a) => {
              const s = state.sessions.find((s) => s.asset === a.name)!;
              return (
                <div className={`asset ${asset === a.name ? 'active' : ''}`} key={a.name}>
                  <input
                    type="checkbox"
                    aria-label={`选择 ${a.name}`}
                    checked={selected.includes(a.name)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, a.name]
                          : selected.filter((n) => n !== a.name),
                      )
                    }
                  />
                  <button
                    className="asset-body"
                    onClick={() => {
                      setAsset(a.name);
                      setCode('');
                    }}
                  >
                    <strong>{a.name}</strong>
                    <span>
                      {a.ip} · {a.username ?? '自动 / 待选择'}
                    </span>
                    <small>
                      <i className={`status-dot ${s.status}`} />
                      {labels[s.status]}
                      {s.lease ? ` · ${s.lease.owner}` : ''}
                    </small>
                  </button>
                </div>
              );
            })}
          </div>
          <div className="aside-note">
            连接保留在 tmux 中。关闭网页后连接继续保留，占用按超时规则回收。
          </div>
        </aside>
        <main>
          <div className="session-heading">
            <div>
              <div className="eyebrow">当前会话</div>
              <h1>{asset || '请选择资产'}</h1>
              <p>
                {configAsset?.ip} <span> / </span>
                {current?.connectedUsername ?? configAsset?.username ?? '等待确定账号'}
              </p>
            </div>
            <span className={`badge ${current?.status}`}>
              {labels[current?.status ?? 'disconnected']}
            </span>
          </div>
          {activeBatch && (
            <div className="batch-box">
              <div>
                <strong>
                  串行登录 · {activeBatch.index + 1} / {activeBatch.assets.length}
                </strong>
                <span>
                  {labels[activeBatch.status]} · {activeBatch.assets[activeBatch.index]}
                </span>
              </div>
              <div>
                {activeBatch.status === 'paused' && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      perform(() => call('batch_action', { id: activeBatch.id, action: 'retry' }))
                    }
                  >
                    继续 / 重试
                  </button>
                )}
                <button
                  disabled={busy}
                  onClick={() =>
                    perform(() => call('batch_action', { id: activeBatch.id, action: 'skip' }))
                  }
                >
                  跳过
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    perform(() => call('batch_action', { id: activeBatch.id, action: 'cancel' }))
                  }
                >
                  取消整批
                </button>
              </div>
            </div>
          )}
          {current?.message && <p className="session-message">{current.message}</p>}
          {current?.status === 'waiting_code' && (
            <form
              className="challenge"
              onSubmit={(e) => {
                e.preventDefault();
                const value = code;
                setCode('');
                void sessionAction('code', { code: value });
              }}
            >
              <div>
                <strong>本次登录需要验证码</strong>
                <span>每次新登录分别验证，验证码不会保存。</span>
              </div>
              <input
                aria-label="验证码"
                type="password"
                autoComplete="off"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="输入本次验证码"
                required
              />
              <button className="primary" disabled={busy}>
                提交验证码
              </button>
            </form>
          )}
          {current?.status === 'needs_username' && (
            <div className="challenge">
              <strong>选择此资产的默认账号</strong>
              {current.accounts.map((u) => (
                <button
                  key={u}
                  disabled={busy}
                  onClick={() => sessionAction('username', { username: u })}
                >
                  {u}
                </button>
              ))}
            </div>
          )}
          {current?.status === 'needs_host_verification' && (
            <div className="challenge host-key">
              <strong>核实 SSH 主机指纹</strong>
              <code>{current.fingerprint}</code>
              <button
                disabled={busy}
                onClick={() => sessionAction('verify_host', { fingerprint: current.fingerprint })}
              >
                确认此指纹并连接
              </button>
            </div>
          )}
          <div className="toolbar">
            <div>
              <button
                className="primary"
                disabled={busy || !asset}
                onClick={() => sessionAction('connect')}
              >
                {current?.status === 'target_closed' ? '重新选择资产' : '连接 / 复用'}
              </button>
              <button
                disabled={busy || current?.status === 'disconnected'}
                onClick={() => sessionAction('reconnect')}
                title="结束当前连接并重新登录，需要新的验证码"
              >
                重连
              </button>
              <button disabled={!bastion} onClick={credentialsOpen}>
                用户名与密码{bastion && state.credentials[bastion.id] ? ' · 已记住' : ''}
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  perform(async () => {
                    setDiscovered(await call('discover'));
                    setImportIndex(0);
                    setModal('import');
                  })
                }
              >
                导入已有连接
              </button>
            </div>
            <div>
              <button
                disabled={
                  busy ||
                  !['ready', 'needs_attention', 'recovering'].includes(current?.status ?? '')
                }
                onClick={() =>
                  perform(async () => {
                    const r = await call('takeover', { asset });
                    setTokens((t) => ({ ...t, [asset]: r.lease.token }));
                  })
                }
              >
                {token ? '重新接管' : current?.lease ? '接管并撤销占用' : '接管终端'}
              </button>
              <button
                disabled={busy || !token}
                onClick={() =>
                  perform(async () => {
                    await call('release', { asset, leaseToken: token });
                    setTokens((t) => {
                      const n = { ...t };
                      delete n[asset];
                      return n;
                    });
                  })
                }
              >
                释放
              </button>
              <button
                disabled={busy || !token}
                onClick={() => sessionAction('key', { leaseToken: token, key: 'Ctrl-C' })}
              >
                中断
              </button>
            </div>
          </div>
          <div className="terminal-shell">
            <div className="terminal-title">
              <span>● ● ●</span>
              <span>
                {token
                  ? '你已获得输入权'
                  : current?.lease
                    ? `只读监控 · ${current.lease.owner} 占用中`
                    : '只读监控 · 接管后可输入'}
              </span>
            </div>
            {asset && <WebTerminal key={asset} asset={asset} token={token} report={setNotice} />}
          </div>
          <div className="terminal-footer">
            <span>
              {current?.lease
                ? `占用到期 ${new Date(current.lease.expiresAt).toLocaleTimeString()}`
                : '当前无占用'}
              {current?.activeOperation ? ' · 命令运行中' : ''}
            </span>
            <div>
              <button
                disabled={busy || !['needs_attention', 'ready'].includes(current?.status ?? '')}
                onClick={() =>
                  perform(async () => {
                    await call('confirm', { asset });
                    setTokens((t) => {
                      const n = { ...t };
                      delete n[asset];
                      return n;
                    });
                  })
                }
              >
                确认终端可复用
              </button>
              <button
                className="danger"
                disabled={busy || current?.status === 'disconnected'}
                onClick={() => sessionAction('close')}
              >
                关闭连接
              </button>
            </div>
          </div>
          <section className="command-panel">
            <div className="section-top">
              <h2>执行命令并返回结果</h2>
              <span>
                {subshell ? '独立子 Shell · 环境修改仅本次有效' : '当前 Shell · 目录和环境持续保留'}
              </span>
            </div>
            <textarea
              aria-label="命令"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="输入前台命令，例如 hostname 或 tail -n 30 /path/to/log"
              rows={3}
            />
            <div className="command-controls">
              <input
                aria-label="工作目录"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder={subshell ? '工作目录（仅本次有效）' : '工作目录（修改后持续保留）'}
              />
              <button
                className="primary"
                disabled={
                  busy || !command.trim() || current?.status !== 'ready' || (!subshell && !token)
                }
                onClick={run}
              >
                {busy ? '等待结果…' : '执行并获取结果'}
              </button>
            </div>
            <details>
              <summary>高级选项</summary>
              <label>
                <input
                  type="checkbox"
                  checked={subshell}
                  onChange={(e) => setSubshell(e.target.checked)}
                />
                独立子 Shell
              </label>
            </details>
            {!subshell && !token && <p>请先接管终端取得占用，再执行命令。</p>}
            {result && (
              <div className="result">
                <div>
                  <strong>
                    {labels[result.status]} ·{' '}
                    {result.executionMode === 'session' ? '当前 Shell' : '独立子 Shell'}
                    {result.exitCode !== null ? ` · 退出码 ${result.exitCode}` : ''}
                  </strong>
                  <small>{result.id}</small>
                </div>
                <pre>{result.output || '（暂无输出）'}</pre>
                {result.message && <p>{result.message}</p>}
                {result.truncated && (
                  <button
                    onClick={() =>
                      perform(async () => {
                        const next = await call('operation_read', {
                          operationId: result.id,
                          cursor: result.cursor,
                        });
                        setResult({ ...next, output: result.output + next.output });
                      })
                    }
                  >
                    读取后续输出
                  </button>
                )}
                {result.outputDropped && (
                  <p className="notice">本次输出超过 64 MiB 保存上限，后续内容未保存。</p>
                )}
              </div>
            )}
          </section>
          <details className="history">
            <summary>最近操作 ({state.operations.length})</summary>
            {state.operations.map((o) => (
              <button
                key={o.id}
                onClick={() =>
                  perform(async () =>
                    setResult(await call('operation_read', { operationId: o.id })),
                  )
                }
              >
                <span>{o.asset}</span>
                <code>{o.command.slice(0, 100)}</code>
                <span>
                  {labels[o.status]}
                  {o.exitCode !== null ? ` (${o.exitCode})` : ''}
                </span>
              </button>
            ))}
          </details>
          {state.batches
            .filter((b) => b.status === 'completed' || b.status === 'cancelled')
            .slice(-1)
            .map((b) => (
              <details className="history" key={b.id}>
                <summary>上次批量登录：{labels[b.status]}</summary>
                {b.results.map((r) => (
                  <p key={r.asset}>
                    {r.asset} · {r.outcome}
                  </p>
                ))}
              </details>
            ))}
        </main>
      </div>
      {modal && (
        <div className="modal-backdrop">
          <div className={`modal ${modal === 'config' ? 'wide' : ''}`}>
            <div className="section-top">
              <h2>
                {modal === 'credentials'
                  ? '堡垒机用户名与密码'
                  : modal === 'config'
                    ? '资产与连接配置'
                    : '导入已有 tmux 连接'}
              </h2>
              <button
                onClick={() => {
                  setModal(undefined);
                  setPassword('');
                }}
              >
                关闭
              </button>
            </div>
            {modal === 'credentials' && bastion && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void perform(async () => {
                    await call('credentials_save', {
                      bastion: bastion.id,
                      username,
                      password: password || undefined,
                      remember,
                    });
                    setPassword('');
                    setModal(undefined);
                  });
                }}
              >
                <p>
                  {bastion.name} · {bastion.host}:{bastion.port}
                </p>
                <label>
                  用户名
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    autoComplete="off"
                  />
                </label>
                <label>
                  密码
                  <input
                    aria-label="堡垒机密码"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    placeholder={
                      state.credentials[bastion.id] ? '已记住；输入新密码即可修改' : '输入密码'
                    }
                  />
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                  />
                  记住用户名密码（保存在本机私有文件）
                </label>
                <div className="modal-actions">
                  <button
                    type="button"
                    onClick={() =>
                      perform(() => call('credentials_forget', { bastion: bastion.id }))
                    }
                  >
                    忘记已保存密码
                  </button>
                  <button className="primary" disabled={busy}>
                    保存
                  </button>
                </div>
              </form>
            )}
            {modal === 'config' && (
              <>
                <p>
                  资产名称用于命名会话。修改已连接资产前请先关闭连接；缺少用户名时，可在登录账号菜单中选择并保存。
                </p>
                <textarea
                  aria-label="配置 JSON"
                  className="config-editor"
                  value={configText}
                  onChange={(e) => setConfigText(e.target.value)}
                />
                <div className="modal-actions">
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      perform(async () => {
                        await call('config_save', { config: JSON.parse(configText) });
                        setModal(undefined);
                      })
                    }
                  >
                    保存配置
                  </button>
                </div>
              </>
            )}
            {modal === 'import' && (
              <>
                <p>
                  登记到当前资产：<strong>{asset}</strong>。导入会将 tmux 会话命名为该资产，保留现有
                  SSH 连接。
                </p>
                <select
                  aria-label="已有连接"
                  value={importIndex}
                  onChange={(e) => setImportIndex(Number(e.target.value))}
                >
                  {discovered.map((b, i) => (
                    <option value={i} key={`${b.socket}:${b.pane}`}>
                      {b.name} · {b.socket}
                    </option>
                  ))}
                </select>
                {!discovered.length && <p>没有发现可导入的连接。</p>}
                <div className="modal-actions">
                  <button
                    className="primary"
                    disabled={busy || !discovered.length}
                    onClick={() =>
                      perform(async () => {
                        const b = discovered[importIndex];
                        await call('import', { asset, socket: b.socket, name: b.name });
                        setModal(undefined);
                      })
                    }
                  >
                    导入连接
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);

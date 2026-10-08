import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import type {
  Asset,
  Config,
  Binding,
  SessionView,
  SessionStatus,
  Lease,
  Operation,
  OperationResult,
  Batch,
  ExecutionMode,
} from '../shared.js';
import { ToolError } from '../shared.js';
import { Store } from './store.js';
import { Tmux, type Terminal, type TerminalBridge, scanHost, saveTrustedKeys } from './tmux.js';
import { CommandFrame, makeCommand, cleanOutput, shellQuote, OutputCleaner } from './framing.js';
import { Redactor } from './redactor.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_OUTPUT = 64 * 1024 * 1024;
type ExecuteArgs = {
  asset: string;
  command: string;
  cwd?: string;
  leaseToken?: string;
  requestId?: string;
  waitMs?: number;
};
type Job = {
  operation: Operation & { signature?: string; owner?: string };
  frame: CommandFrame;
  redactor: Redactor;
  cleaner: OutputCleaner;
  bytes: number;
  token: string;
  autoLease: boolean;
  ending: boolean;
};
type Session = {
  asset: string;
  status: SessionStatus;
  message?: string;
  accounts: string[];
  binding?: Binding;
  lease?: Lease;
  connectedUsername?: string;
  bridge?: TerminalBridge;
  activeJob?: Job;
  output: string;
  cursor: number;
  fingerprint?: string;
  extraSecrets: string[];
  passwordSubmitted: boolean;
  codeSubmitted: boolean;
  inspectTimer?: NodeJS.Timeout;
  loginTimer?: NodeJS.Timeout;
  inspectRunning?: boolean;
  redactor: Redactor;
  queuedAction?: string;
  submittedPrompt?: string;
};
export class Manager extends EventEmitter {
  readonly sessions = new Map<string, Session>();
  readonly operations = new Map<string, Operation & { signature?: string; owner?: string }>();
  private commandBatches = new Map<string, { token: string; autoLease: boolean }>();
  readonly batches = new Map<string, Batch>();
  private queues = new Map<string, Promise<unknown>>();
  private temporaryPasswords = new Map<string, string>();
  private knownSecrets = new Set<string>();
  private timer: NodeJS.Timeout;
  private disposed = false;
  private readonly runningPort: number;
  constructor(
    readonly store: Store,
    readonly terminal: Terminal = new Tmux(),
    private readonly hostScanner: typeof scanHost = scanHost,
  ) {
    super();
    this.runningPort = store.config().port;
    for (const c of Object.values(store.credentials())) this.knownSecrets.add(c.password);
    for (const o of store.operations()) {
      o.executionMode ??= 'subshell';
      if (o.status === 'running') {
        o.status = 'unknown';
        o.message = '后台重启，执行结果需要人工确认；不会自动重新执行。';
        store.saveOperation(o);
      }
      this.operations.set(o.id, o);
    }
    this.timer = setInterval(() => void this.expire(), 1000);
    this.timer.unref();
  }
  private newSession(asset: string): Session {
    const previous = this.sessions.get(asset);
    if (previous?.inspectTimer) clearTimeout(previous.inspectTimer);
    if (previous?.loginTimer) clearTimeout(previous.loginTimer);
    const s: Session = {
      asset,
      status: 'connecting',
      accounts: [],
      output: '',
      cursor: 0,
      extraSecrets: [],
      passwordSubmitted: false,
      codeSubmitted: false,
      redactor: null!,
    };
    s.redactor = new Redactor(() => this.secrets(s));
    this.sessions.set(asset, s);
    return s;
  }
  private secrets(s: Session) {
    return [
      ...Object.values(this.store.credentials()).map((c) => c.password),
      ...this.knownSecrets,
      ...this.temporaryPasswords.values(),
      ...s.extraSecrets,
    ];
  }
  private safe(s: Session, text: string) {
    return this.store.redact(text, [
      ...this.knownSecrets,
      ...this.temporaryPasswords.values(),
      ...s.extraSecrets,
    ]);
  }
  private change(s?: Session) {
    this.emit('change', s ? this.view(s) : undefined);
  }
  private view(s: Session): SessionView {
    const { token: _token, ...lease } = s.lease ?? ({} as Lease);
    return {
      asset: s.asset,
      status: s.status,
      message: s.message,
      accounts: s.accounts,
      connectedUsername: s.connectedUsername,
      lease: s.lease ? lease : undefined,
      activeOperation: s.activeJob?.operation.id,
      fingerprint: s.fingerprint,
    };
  }
  list(): SessionView[] {
    return this.store
      .config()
      .assets.map((a) =>
        this.sessions.has(a.name)
          ? this.view(this.sessions.get(a.name)!)
          : { asset: a.name, status: 'disconnected', accounts: [] },
      );
  }
  private asset(name: string): Asset {
    const a = this.store.config().assets.find((a) => a.name === name);
    if (!a) throw new ToolError('UNKNOWN_ASSET', '未找到配置的资产。');
    return a;
  }
  private session(name: string): Session {
    this.asset(name);
    const s = this.sessions.get(name);
    if (!s) throw new ToolError('NOT_CONNECTED', '会话尚未建立。');
    return s;
  }
  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.queues.set(key, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }
  }
  private saveBindings() {
    this.store.saveBindings(
      [...this.sessions.values()].flatMap((s) => (s.binding ? [s.binding] : [])),
    );
  }
  private setStatus(s: Session, status: SessionStatus, message?: string) {
    s.status = status;
    s.message = message;
    this.change(s);
    this.advanceBatches();
  }
  private async connectBridge(s: Session) {
    if (!s.binding) return;
    s.bridge?.close();
    const bridge = this.terminal.bridge(s.binding);
    s.bridge = bridge;
    bridge.on('data', (text: string) => {
      if (this.disposed || this.sessions.get(s.asset) !== s || s.bridge !== bridge) return;
      s.activeJob?.frame.push(text);
      if (s.status === 'ready' || s.status === 'recovering' || s.status === 'needs_attention') {
        const safe = s.redactor.push(text);
        if (safe) {
          s.output += safe;
          s.cursor += safe.length;
          if (s.output.length > 256 * 1024) s.output = s.output.slice(-256 * 1024);
          this.emit('output', s.asset, safe, s.cursor);
        }
      }
      this.scheduleInspect(s);
    });
    bridge.on('lost', () => {
      if (this.disposed || this.sessions.get(s.asset) !== s || s.bridge !== bridge) return;
      s.bridge = undefined;
      bridge.close();
      if (s.activeJob) this.endAbnormally(s, 'unknown', '终端输出连接中断，不能确认结果。');
      s.lease = undefined;
      this.setStatus(s, 'needs_attention', '终端输出连接中断，请确认或重连。');
    });
    let timeout: NodeJS.Timeout;
    try {
      await Promise.race([
        bridge.ready,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new ToolError('BRIDGE_TIMEOUT', '终端输出通道未就绪。')),
            3000,
          );
        }),
      ]);
    } catch (error) {
      if (s.bridge === bridge) s.bridge = undefined;
      bridge.close();
      throw error;
    } finally {
      clearTimeout(timeout!);
    }
  }
  private scheduleInspect(s: Session) {
    if (this.disposed || this.sessions.get(s.asset) !== s || s.inspectTimer) return;
    s.inspectTimer = setTimeout(() => {
      s.inspectTimer = undefined;
      const binding = s.binding;
      const bridge = s.bridge;
      void this.inspect(s).catch(() => {
        if (
          !this.disposed &&
          this.sessions.get(s.asset) === s &&
          s.binding === binding &&
          s.bridge === bridge
        )
          this.setStatus(s, 'disconnected', 'SSH 会话已断开。');
      });
    }, 100);
  }
  private armLoginTimeout(s: Session) {
    if (s.loginTimer) clearTimeout(s.loginTimer);
    s.loginTimer = setTimeout(() => {
      if (!this.disposed && this.sessions.get(s.asset) === s && s.status === 'connecting')
        this.setStatus(
          s,
          'needs_attention',
          '登录提示未能自动识别，请接管终端完成登录后确认可复用。',
        );
    }, 30000);
    s.loginTimer.unref();
  }
  async restore() {
    for (const b of this.store.bindings()) {
      if (!this.store.config().assets.some((a) => a.name === b.asset)) continue;
      const s = this.newSession(b.asset);
      s.binding = b;
      if (!(await this.terminal.exists(b))) {
        s.binding = undefined;
        s.status = 'disconnected';
        continue;
      }
      try {
        await this.connectBridge(s);
        const screen = await this.terminal.capture(b);
        if (this.isIdle(s, screen)) {
          s.status = 'ready';
          s.connectedUsername = this.promptUser(screen);
        } else {
          s.status = 'needs_attention';
          s.message = '后台重启，终端状态需要确认。';
        }
      } catch {
        s.status = 'needs_attention';
        s.message = '终端通道需要重新连接。';
      }
    }
    this.saveBindings();
  }
  private promptUser(screen: string) {
    return (
      screen
        .trimEnd()
        .split('\n')
        .at(-1)
        ?.match(/^\[([^@\]]+)@/u)?.[1] ??
      screen
        .trimEnd()
        .split('\n')
        .at(-1)
        ?.match(/^([^@\s]+)@/)?.[1]
    );
  }
  private isIdle(s: Session, screen: string): boolean {
    const a = this.asset(s.asset);
    const tail = screen.trimEnd().split('\n').at(-1) ?? '';
    const prompt = a.promptPattern
      ? new RegExp(a.promptPattern).test(tail)
      : /^(?:\[[^\]\n]+@[^\]\n]+\][#$]|[^\s]+@[^\s]+:[^\n]*[#$])\s*$/.test(tail);
    return prompt && (!a.username || this.promptUser(screen) === a.username);
  }
  async ensure(name: string): Promise<SessionView> {
    return this.locked(name, async () => {
      const a = this.asset(name);
      let s = this.sessions.get(name);
      if (s?.binding && (await this.terminal.exists(s.binding))) {
        if (s.status === 'target_closed') {
          s.queuedAction = 'resume';
          await this.terminal.key(s.binding, 'Enter');
          s.status = 'connecting';
          this.armLoginTimeout(s);
          this.scheduleInspect(s);
        }
        return this.view(s);
      }
      s?.bridge?.close();
      s = this.newSession(name);
      const bastion = this.store.config().bastions.find((b) => b.id === a.bastion)!;
      try {
        const scan = await this.hostScanner(bastion.host, bastion.port);
        const match = bastion.fingerprint ? scan.fingerprints.indexOf(bastion.fingerprint) : -1;
        if (match === -1) {
          s.fingerprint = scan.fingerprints[0];
          this.setStatus(s, 'needs_host_verification', '请在网页核实并确认 SSH 主机指纹。');
          return this.view(s);
        }
        saveTrustedKeys(
          this.store.knownHostsPath,
          bastion.host,
          bastion.port,
          scan.keys.trim().split('\n')[match] + '\n',
        );
        const args = [
          'ssh',
          '-tt',
          '-o',
          'StrictHostKeyChecking=yes',
          '-o',
          'UpdateHostKeys=no',
          '-o',
          'GlobalKnownHostsFile=/dev/null',
          '-o',
          `UserKnownHostsFile=${this.store.knownHostsPath}`,
          '-o',
          'ConnectTimeout=10',
          '-o',
          'ServerAliveInterval=30',
          '-o',
          'ServerAliveCountMax=3',
          '-o',
          'PubkeyAuthentication=no',
          '-o',
          'PreferredAuthentications=keyboard-interactive,password',
          '-p',
          String(bastion.port),
          `${bastion.username}@${bastion.host}`,
        ];
        s.binding = await this.terminal.create(
          'bastion-bridge',
          name,
          'exec ' + args.map(shellQuote).join(' '),
        );
        s.binding.asset = name;
        this.saveBindings();
        await this.connectBridge(s);
        this.armLoginTimeout(s);
        this.scheduleInspect(s);
        this.change(s);
      } catch (e) {
        this.setStatus(s, 'error', e instanceof ToolError ? e.message : '建立连接失败。');
      }
      return this.view(s);
    });
  }
  private async inspect(s: Session) {
    if (
      this.disposed ||
      this.sessions.get(s.asset) !== s ||
      !s.binding ||
      s.inspectRunning ||
      s.status === 'needs_attention' ||
      s.status === 'recovering'
    )
      return;
    s.inspectRunning = true;
    const job = s.activeJob;
    const binding = s.binding;
    const bridge = s.bridge;
    try {
      const screen = await this.terminal.capture(binding);
      if (
        this.disposed ||
        this.sessions.get(s.asset) !== s ||
        s.binding !== binding ||
        s.bridge !== bridge ||
        s.activeJob !== job
      )
        return;
      const tail = screen.trimEnd();
      if (s.status === 'ready') {
        if (/会话已结束。按下 ENTER/.test(tail.split('\n').at(-1) ?? '')) {
          if (job) this.endAbnormally(s, 'unknown', '目标连接已结束，未收到命令结束帧。');
          s.lease = undefined;
          this.setStatus(s, 'target_closed', '目标连接已结束，堡垒机认证连接仍可复用。');
        }
        return;
      }
      if (job) return;
      if (/2nd Password:\s*$/i.test(tail)) {
        if (s.codeSubmitted) {
          if (tail === s.submittedPrompt) return;
          s.codeSubmitted = false;
          this.setStatus(s, 'waiting_code', '验证码未通过，请输入本次有效验证码。');
        } else this.setStatus(s, 'waiting_code', '请输入本次验证码。');
      } else if (/Password:\s*$/i.test(tail)) {
        if (s.passwordSubmitted) {
          if (tail === s.submittedPrompt) return;
          this.setStatus(s, 'needs_password', '密码未通过，请修改密码后重试。');
          return;
        }
        const bastion = this.store
          .config()
          .bastions.find((b) => b.id === this.asset(s.asset).bastion)!;
        const password = this.temporaryPasswords.get(bastion.id) ?? this.store.password(bastion.id);
        if (!password) {
          this.setStatus(s, 'needs_password', '请在网页填写堡垒机密码。');
          return;
        }
        s.passwordSubmitted = true;
        s.submittedPrompt = tail;
        s.status = 'connecting';
        await this.terminal.send(s.binding, password, true);
        this.change(s);
      } else if (/请选择目标资产[：:]\s*$/.test(tail)) {
        if (s.queuedAction === 'asset') {
          if (tail === s.submittedPrompt) return;
          this.setStatus(s, 'error', '资产选择未成功，请核对配置的 IP。');
          return;
        }
        s.queuedAction = 'asset';
        s.submittedPrompt = tail;
        s.status = 'connecting';
        await this.terminal.send(s.binding, this.asset(s.asset).ip, true);
        this.change(s);
      } else if (/请选择登录账号[：:]\s*$/.test(tail)) {
        const menu = screen.slice(Math.max(0, screen.lastIndexOf('登录账号列表')));
        s.accounts = [...menu.matchAll(/^\s*\d+:\s*\*?\s*(\S+)\s*$/gm)].map((m) => m[1]);
        const username = this.asset(s.asset).username;
        if (!username || !s.accounts.includes(username)) {
          this.setStatus(
            s,
            'needs_username',
            username
              ? '配置的用户名不在账号菜单中，请修改配置。'
              : '请选择并记住此资产的登录账号。',
          );
          return;
        }
        if (s.queuedAction === 'username') {
          if (tail === s.submittedPrompt) return;
          this.setStatus(s, 'error', '账号选择未成功，请人工检查。');
          return;
        }
        s.queuedAction = 'username';
        s.submittedPrompt = tail;
        s.status = 'connecting';
        await this.terminal.send(s.binding, username, true);
        this.change(s);
      } else if (/会话已结束。按下 ENTER/.test(tail.split('\n').at(-1) ?? '')) {
        s.lease = undefined;
        this.setStatus(s, 'target_closed', '目标连接已结束，堡垒机认证连接仍可复用。');
      } else if (
        this.promptUser(screen) &&
        /[#$]\s*$/.test(tail.split('\n').at(-1) ?? '') &&
        this.asset(s.asset).username &&
        this.promptUser(screen) !== this.asset(s.asset).username
      ) {
        this.setStatus(s, 'needs_attention', '实际登录用户名与资产配置不符，请人工检查。');
      } else if (this.isIdle(s, screen)) {
        const lastConnection = [...screen.matchAll(/Connecting to ([^@\s]+)@([\d.]+)/g)].at(-1);
        if (lastConnection && lastConnection[2] !== this.asset(s.asset).ip) {
          this.setStatus(s, 'needs_attention', '实际连接 IP 与配置不符。');
          return;
        }
        s.connectedUsername = this.promptUser(screen);
        s.queuedAction = undefined;
        this.setStatus(s, 'ready');
      } else if (
        /Permission denied|Host key verification failed|Connection refused|Connection timed out/i.test(
          tail,
        )
      )
        this.setStatus(s, 'error', 'SSH 登录失败，请在网页检查凭据、指纹或网络。');
    } finally {
      s.inspectRunning = false;
    }
  }
  async submitCode(name: string, code: string) {
    if (!/^[A-Za-z0-9-]{3,32}$/.test(code))
      throw new ToolError('INVALID_CODE', '验证码格式不正确。');
    return this.locked(name, async () => {
      const s = this.session(name);
      if (s.status !== 'waiting_code' || !s.binding)
        throw new ToolError('NOT_WAITING_CODE', '当前会话没有等待验证码。');
      const tail = (await this.terminal.capture(s.binding)).trimEnd();
      if (!/2nd Password:\s*$/i.test(tail))
        throw new ToolError('PROMPT_CHANGED', '验证码提示已变化，请刷新状态。');
      s.extraSecrets.push(code);
      s.codeSubmitted = true;
      s.submittedPrompt = tail;
      s.queuedAction = undefined;
      s.status = 'connecting';
      await this.terminal.send(s.binding, code, true);
      this.armLoginTimeout(s);
      this.change(s);
      this.scheduleInspect(s);
      return this.view(s);
    });
  }
  async selectUsername(name: string, username: string) {
    const s = this.session(name);
    if (s.status !== 'needs_username' || !s.accounts.includes(username))
      throw new ToolError('INVALID_ACCOUNT', '请从当前账号菜单中选择。');
    const c = this.store.config();
    c.assets.find((a) => a.name === name)!.username = username;
    this.store.saveConfig(c);
    s.queuedAction = undefined;
    s.status = 'connecting';
    this.armLoginTimeout(s);
    await this.inspect(s);
    this.scheduleInspect(s);
    return this.view(s);
  }
  async verifyHost(name: string, fingerprint: string) {
    const a = this.asset(name);
    const c = this.store.config();
    const b = c.bastions.find((b) => b.id === a.bastion)!;
    const scan = await this.hostScanner(b.host, b.port);
    if (!scan.fingerprints.includes(fingerprint))
      throw new ToolError('HOST_KEY_CHANGED', '主机指纹与本次确认值不符。');
    b.fingerprint = fingerprint;
    this.store.saveConfig(c);
    return this.ensure(name);
  }
  async importSession(name: string, socket: string, tmuxName: string) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(socket) || !/^[A-Za-z0-9_-]{1,64}$/.test(tmuxName))
      throw new ToolError('INVALID_SESSION', 'Invalid tmux session or socket name.');
    return this.locked('$registry', () =>
      this.locked(name, async () => {
        this.asset(name);
        if (this.sessions.get(name)?.binding)
          throw new ToolError('ALREADY_CONNECTED', '资产已有登记连接，请先关闭。');
        const b = (await this.terminal.list(socket)).find((b) => b.name === tmuxName);
        if (!b) throw new ToolError('NOT_FOUND', '找不到对应 tmux 会话。');
        if (
          [...this.sessions.values()].some(
            (s) => s.binding?.socket === b.socket && s.binding?.pane === b.pane,
          )
        )
          throw new ToolError('ALREADY_REGISTERED', '该终端已登记。');
        const s = this.newSession(name);
        const screen = await this.terminal.capture(b);
        const lastConnection = [...screen.matchAll(/Connecting to ([^@\s]+)@([\d.]+)/g)].at(-1);
        if (
          !this.isIdle(s, screen) ||
          (lastConnection && lastConnection[2] !== this.asset(name).ip)
        ) {
          this.sessions.delete(name);
          throw new ToolError('IMPORT_MISMATCH', '终端未就绪或与配置的 IP、用户名不符。');
        }
        s.binding = await this.terminal.rename({ ...b, asset: name }, name);
        s.connectedUsername = this.promptUser(screen);
        s.status = 'ready';
        await this.connectBridge(s);
        this.saveBindings();
        this.change(s);
        return this.view(s);
      }),
    );
  }
  private checkLease(s: Session, token: string, kind?: Lease['kind'], touch = true) {
    if (
      !s.lease ||
      s.lease.token !== token ||
      s.lease.expiresAt <= Date.now() ||
      (kind && s.lease.kind !== kind)
    )
      throw new ToolError('LEASE_INVALID', '占用凭证已失效，请重新申请。');
    if (touch) s.lease.expiresAt = Date.now() + this.store.config().leaseSeconds * 1000;
    return s.lease;
  }
  private grant(s: Session, owner: string, kind: Lease['kind']): Lease {
    const lease: Lease = {
      token: randomUUID(),
      owner: owner.slice(0, 100),
      kind,
      expiresAt: Date.now() + this.store.config().leaseSeconds * 1000,
    };
    s.lease = lease;
    this.change(s);
    return lease;
  }
  async acquire(name: string, owner: string) {
    await this.ensure(name);
    return this.locked(name, async () => {
      const s = this.session(name);
      if (s.status !== 'ready')
        return { status: s.status, session: this.view(s), webUrl: this.webUrl(name) };
      if (s.lease) throw new ToolError('SESSION_BUSY', '会话正在被使用。', this.view(s).lease);
      if (
        s.activeJob ||
        !(await this.terminal.capture(s.binding!).then((x) => this.isIdle(s, x)))
      ) {
        this.setStatus(s, 'needs_attention', '终端尚有未完成操作。');
        throw new ToolError('TERMINAL_BUSY', '终端未回到命令提示符。');
      }
      return { status: 'acquired', lease: this.grant(s, owner, 'agent'), session: this.view(s) };
    });
  }
  renew(name: string, token: string) {
    const s = this.session(name);
    const lease = this.checkLease(s, token);
    this.change(s);
    return { ...lease };
  }
  async release(name: string, token: string) {
    return this.locked(name, async () => {
      const s = this.session(name);
      this.checkLease(s, token);
      if (s.activeJob || !s.binding || !this.isIdle(s, await this.terminal.capture(s.binding)))
        throw new ToolError('TERMINAL_BUSY', '请先结束操作，或中断后再释放。');
      s.lease = undefined;
      this.change(s);
      return { released: true };
    });
  }
  async takeover(name: string, owner: string) {
    return this.locked(name, async () => {
      const s = this.session(name);
      if (!s.binding || !['ready', 'needs_attention', 'recovering'].includes(s.status))
        throw new ToolError('NOT_READY', '该会话尚未进入可操作终端。');
      if (!s.bridge) await this.connectBridge(s);
      return { lease: this.grant(s, owner, 'human'), session: this.view(s) };
    });
  }
  async send(name: string, token: string, text: string, submit = false) {
    if (text === '\x03' && !submit) return this.key(name, token, 'Ctrl-C');
    if (Buffer.byteLength(text) > 128 * 1024)
      throw new ToolError('INPUT_TOO_LARGE', '单次输入不能超过 128 KiB。');
    return this.locked(name, async () => {
      const s = this.session(name);
      const lease = this.checkLease(s, token);
      if (!s.binding || !['ready', 'needs_attention'].includes(s.status))
        throw new ToolError('NOT_READY', '终端当前不可输入。');
      if (s.activeJob && lease.kind !== 'human')
        throw new ToolError('OPERATION_RUNNING', '请等待或中断当前命令。');
      await this.terminal.send(s.binding, text, submit);
      this.scheduleInspect(s);
      return { accepted: true };
    });
  }
  async key(name: string, token: string, key: string) {
    return this.locked(name, async () => {
      const s = this.session(name);
      const lease = this.checkLease(s, token);
      if (s.activeJob && lease.kind !== 'human' && !['Ctrl-C', 'C-c'].includes(key))
        throw new ToolError('OPERATION_RUNNING', '当前命令运行中，只允许中断。');
      await this.terminal.key(s.binding!, key);
      if (key === 'Ctrl-C' || key === 'C-c') await this.recover(s, false);
      return { accepted: true };
    });
  }
  async resize(name: string, token: string, cols: number, rows: number) {
    return this.locked(name, async () => {
      const s = this.session(name);
      this.checkLease(s, token, 'human');
      await this.terminal.resize(
        s.binding!,
        Math.max(20, Math.min(500, cols)),
        Math.max(5, Math.min(200, rows)),
      );
      return { resized: true };
    });
  }
  async snapshot(name: string): Promise<string> {
    const s = this.session(name);
    if (!s.binding || !['ready', 'recovering', 'needs_attention'].includes(s.status))
      return s.message ?? '等待连接';
    return this.safe(s, await this.terminal.capture(s.binding));
  }
  read(name: string, token: string, cursor?: number) {
    const s = this.session(name);
    this.checkLease(s, token);
    const base = s.cursor - s.output.length;
    const requested = cursor ?? base;
    return {
      output: cleanOutput(s.output.slice(Math.max(0, requested - base))),
      cursor: s.cursor,
      gap: requested < base,
      session: this.view(s),
    };
  }
  async confirm(name: string) {
    return this.locked(name, async () => {
      const s = this.session(name);
      if (!s.binding || !this.isIdle(s, await this.terminal.capture(s.binding)))
        throw new ToolError('TERMINAL_BUSY', '请先让终端返回配置用户名的命令提示符。');
      if (s.activeJob) this.endAbnormally(s, 'unknown', '人工确认终端可用，但此前结果无法确认。');
      if (!s.bridge) await this.connectBridge(s);
      s.lease = undefined;
      this.setStatus(s, 'ready');
      return this.view(s);
    });
  }
  private append(job: Job, text: string) {
    if (!text) return;
    const buffer = Buffer.from(text);
    const remaining = MAX_OUTPUT - job.bytes;
    if (remaining > 0) {
      fs.appendFileSync(this.store.outputPath(job.operation.id), buffer.subarray(0, remaining), {
        mode: 0o600,
      });
      job.bytes += Math.min(remaining, buffer.length);
    }
    if (buffer.length > remaining) job.operation.outputDropped = true;
  }
  private endAbnormally(
    s: Session,
    status: OperationStatusAlias,
    message: string,
    expectedJob?: Job,
  ) {
    const job = s.activeJob;
    if (!job || (expectedJob && job !== expectedJob)) return;
    job.frame.flush();
    this.append(job, job.cleaner.push(job.redactor.flush()));
    job.operation.status = status;
    job.operation.message = message;
    job.operation.finishedAt = Date.now();
    this.store.saveOperation(job.operation);
    s.activeJob = undefined;
    this.emit('operation', job.operation.id);
    this.change(s);
  }
  private async finish(s: Session, job: Job, code: number) {
    await this.locked(s.asset, async () => {
      if (s.activeJob !== job || job.ending) return;
      job.ending = true;
      this.append(job, job.cleaner.push(job.redactor.flush()));
      let idle = false;
      for (let i = 0; i < 10; i++) {
        if (s.binding && this.isIdle(s, await this.terminal.capture(s.binding))) {
          idle = true;
          break;
        }
        await sleep(50);
      }
      if (s.activeJob !== job || this.disposed) return;
      job.operation.status = 'completed';
      job.operation.exitCode = code;
      job.operation.finishedAt = Date.now();
      this.store.saveOperation(job.operation);
      s.activeJob = undefined;
      if (s.lease?.token === job.token) {
        if (idle && job.autoLease) s.lease = undefined;
        if (!idle) this.setStatus(s, 'needs_attention', '命令结束，但终端提示符未确认。');
      }
      this.emit('operation', job.operation.id);
      this.change(s);
    });
  }
  execute(args: ExecuteArgs & { leaseToken: string }, owner: string) {
    return this.executeCommand(args, owner, 'session');
  }
  executeSubshell(args: ExecuteArgs, owner: string, touchLease = true) {
    return this.executeCommand(args, owner, 'subshell', touchLease);
  }
  private async executeCommand(
    args: ExecuteArgs,
    owner: string,
    executionMode: ExecutionMode,
    touchLease = true,
  ) {
    if (executionMode === 'session') {
      if (!args.leaseToken)
        throw new ToolError('LEASE_REQUIRED', '请先 acquire 并传入 leaseToken。');
      this.checkLease(this.session(args.asset), args.leaseToken, undefined, touchLease);
    }
    const signature = createHash('sha256')
      .update(JSON.stringify([args.asset, args.command, args.cwd ?? null]))
      .digest('hex');
    if (args.requestId) {
      const old = [...this.operations.values()].find(
        (o) => o.asset === args.asset && o.requestId === args.requestId,
      );
      if (old) {
        if (old.signature !== signature || (old.executionMode ?? 'subshell') !== executionMode)
          throw new ToolError('REQUEST_CONFLICT', '同一请求标识对应不同命令。');
        const s = this.sessions.get(args.asset);
        const activeToken =
          old.owner === owner &&
          s?.activeJob?.operation.id === old.id &&
          s.lease?.token === s.activeJob.token
            ? s.activeJob.token
            : undefined;
        return this.wait(old.id, args.waitMs ?? 30000, args.leaseToken ?? activeToken);
      }
    }
    await this.ensure(args.asset);
    const created = await this.locked(args.asset, async () => {
      const s = this.session(args.asset);
      // Repeat deduplication under the session lock, including concurrent retries.
      const old = args.requestId
        ? [...this.operations.values()].find(
            (o) => o.asset === args.asset && o.requestId === args.requestId,
          )
        : undefined;
      if (old) {
        if (old.signature !== signature || (old.executionMode ?? 'subshell') !== executionMode)
          throw new ToolError('REQUEST_CONFLICT', '同一请求标识对应不同命令。');
        return {
          id: old.id,
          token:
            args.leaseToken ??
            (old.owner === owner &&
            s.activeJob?.operation.id === old.id &&
            s.lease?.token === s.activeJob.token
              ? s.activeJob.token
              : undefined),
        };
      }
      if (s.status !== 'ready')
        return {
          pending: { status: s.status, session: this.view(s), webUrl: this.webUrl(args.asset) },
        };
      let token = args.leaseToken;
      if (token) this.checkLease(s, token, undefined, touchLease);
      else {
        if (s.lease) throw new ToolError('SESSION_BUSY', '会话正在被使用。', this.view(s).lease);
        token = this.grant(s, owner, 'agent').token;
      }
      if (s.activeJob) throw new ToolError('OPERATION_RUNNING', '会话已有命令运行中。');
      if (!this.isIdle(s, await this.terminal.capture(s.binding!))) {
        if (!args.leaseToken) s.lease = undefined;
        this.setStatus(s, 'needs_attention', '终端尚有未完成操作。');
        throw new ToolError('TERMINAL_BUSY', '终端未就绪。');
      }
      // Capture yields; expiry or takeover must not authorize a stale write.
      this.checkLease(s, token!, undefined, false);
      const id = randomUUID();
      const operation = {
        id,
        executionMode,
        asset: args.asset,
        command: this.safe(s, args.command),
        cwd: args.cwd,
        status: 'running' as const,
        exitCode: null,
        createdAt: Date.now(),
        requestId: args.requestId,
        outputDropped: false,
        signature,
        owner,
      };
      const framing = makeCommand(args.command, args.cwd, executionMode);
      const job: Job = {
        operation,
        token: token!,
        autoLease: !args.leaseToken,
        bytes: 0,
        redactor: new Redactor(() => this.secrets(s)),
        cleaner: new OutputCleaner(),
        ending: false,
        frame: null!,
      };
      job.frame = new CommandFrame(
        framing.begin,
        framing.end,
        (text) => this.append(job, job.cleaner.push(job.redactor.push(text))),
        (code) => {
          void this.finish(s, job, code).catch(() => {
            if (s.activeJob !== job) return;
            this.endAbnormally(s, 'unknown', '无法确认命令结束状态。', job);
            if (s.lease?.token === job.token) this.setStatus(s, 'needs_attention');
          });
        },
      );
      this.operations.set(id, operation);
      this.store.saveOperation(operation);
      fs.writeFileSync(this.store.outputPath(id), '', { mode: 0o600 });
      s.activeJob = job;
      this.change(s);
      try {
        await this.terminal.send(s.binding!, framing.line, true);
      } catch {
        this.endAbnormally(s, 'unknown', '发送结果无法确认，不会自动重试。', job);
        if (s.lease?.token === job.token) this.setStatus(s, 'needs_attention');
      }
      return { id, token };
    });
    if ('pending' in created) return created.pending;
    return this.wait(created.id!, args.waitMs ?? 30000, created.token, touchLease);
  }
  result(id: string, cursor = 0, maxBytes = 65536): OperationResult {
    const o = this.operations.get(id);
    if (!o) throw new ToolError('UNKNOWN_OPERATION', '找不到操作记录。');
    const file = this.store.outputPath(id);
    let buf = Buffer.alloc(0);
    let total = 0;
    if (fs.existsSync(file)) {
      const fd = fs.openSync(file, 'r');
      try {
        total = fs.fstatSync(fd).size;
        cursor = Math.max(0, Math.min(total, cursor));
        buf = Buffer.alloc(Math.min(Math.max(1, Math.min(maxBytes, 1024 * 1024)), total - cursor));
        fs.readSync(fd, buf, 0, buf.length, cursor);
        if (cursor + buf.length < total) {
          let end = buf.length;
          while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end--;
          if (end > 0 && buf[end - 1] >= 0xc0) end--;
          if (end > 0) buf = buf.subarray(0, end);
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    const { signature: _signature, owner: _owner, ...publicOperation } = o;
    const result: OperationResult = {
      ...publicOperation,
      output: cleanOutput(this.store.redact(buf.toString('utf8'))),
      cursor: cursor + buf.length,
      truncated: cursor + buf.length < total,
    };
    if (o.kind === 'batch')
      result.results = (o.steps ?? []).map((step) =>
        this.result(step, 0, Math.max(16, Math.floor(65536 / Math.max(1, o.steps!.length)))),
      );
    return result;
  }
  async wait(
    id: string,
    waitMs: number,
    token?: string,
    touchLease = true,
  ): Promise<OperationResult> {
    if (!this.operations.has(id)) throw new ToolError('UNKNOWN_OPERATION', '找不到操作记录。');
    waitMs = Math.max(0, Math.min(60000, waitMs));
    const s = this.sessions.get(this.operations.get(id)!.asset);
    if (
      token &&
      s &&
      (s.activeJob?.operation.id === id || this.commandBatches.get(id)?.token === token)
    )
      this.checkLease(s, token, undefined, touchLease);
    if (this.operations.get(id)!.status === 'running' && waitMs)
      await new Promise<void>((resolve) => {
        const cleanup = () => {
          clearTimeout(timer);
          clearInterval(heartbeat);
          this.off('operation', done);
          resolve();
        };
        const done = (finished: string) => {
          if (finished === id) cleanup();
        };
        const heartbeat = setInterval(
          () => {
            if (
              touchLease &&
              token &&
              s &&
              (s.activeJob?.operation.id === id || this.commandBatches.has(id))
            ) {
              try {
                this.checkLease(s, token);
              } catch {
                clearInterval(heartbeat);
              }
            }
          },
          Math.max(1000, Math.min(10000, (this.store.config().leaseSeconds * 1000) / 3)),
        );
        const timer = setTimeout(cleanup, waitMs);
        this.on('operation', done);
      });
    const result = this.result(id);
    if (
      (s?.activeJob?.operation.id === id || this.commandBatches.has(id)) &&
      token &&
      s?.lease?.token === token
    )
      result.leaseToken = token;
    return result;
  }
  async executeSubshellBatch(
    args: {
      asset: string;
      commands: string[];
      cwd?: string;
      leaseToken?: string;
      requestId?: string;
      stopOnError?: boolean;
      waitMs?: number;
    },
    owner: string,
  ) {
    if (!args.commands.length || args.commands.length > 100)
      throw new ToolError('INVALID_BATCH', '批量命令数量须为 1–100。');
    const signature = createHash('sha256')
      .update(JSON.stringify([args.asset, args.commands, args.cwd, args.stopOnError !== false]))
      .digest('hex');
    await this.ensure(args.asset);
    const created = await this.locked(args.asset, async () => {
      const old = args.requestId
        ? [...this.operations.values()].find(
            (o) => o.asset === args.asset && o.requestId === args.requestId,
          )
        : undefined;
      if (old) {
        if (old.signature !== signature || (old.executionMode ?? 'subshell') !== 'subshell')
          throw new ToolError('REQUEST_CONFLICT', '同一请求标识对应不同批量命令。');
        return {
          id: old.id,
          token:
            args.leaseToken ??
            (old.owner === owner ? this.commandBatches.get(old.id)?.token : undefined),
          existing: true,
        };
      }
      const s = this.session(args.asset);
      if (s.status !== 'ready')
        return {
          pending: { status: s.status, session: this.view(s), webUrl: this.webUrl(args.asset) },
        };
      let token = args.leaseToken;
      if (token) this.checkLease(s, token);
      else {
        if (s.lease) throw new ToolError('SESSION_BUSY', '会话正在被使用。', this.view(s).lease);
        token = this.grant(s, owner, 'agent').token;
      }
      if (s.activeJob || !this.isIdle(s, await this.terminal.capture(s.binding!))) {
        if (!args.leaseToken) s.lease = undefined;
        throw new ToolError('TERMINAL_BUSY', '终端未就绪。');
      }
      this.checkLease(s, token!, undefined, false);
      const operation: Operation & { owner: string; signature: string } = {
        id: randomUUID(),
        executionMode: 'subshell',
        asset: args.asset,
        command: this.safe(s, args.commands.join('\n')),
        cwd: args.cwd,
        kind: 'batch',
        steps: [],
        status: 'running',
        exitCode: null,
        createdAt: Date.now(),
        requestId: args.requestId,
        outputDropped: false,
        owner,
        signature,
      };
      this.operations.set(operation.id, operation);
      this.commandBatches.set(operation.id, { token: token!, autoLease: !args.leaseToken });
      this.store.saveOperation(operation);
      fs.writeFileSync(this.store.outputPath(operation.id), '', { mode: 0o600 });
      this.change(s);
      return { id: operation.id, token, existing: false };
    });
    if ('pending' in created) return created.pending;
    if (!created.existing) void this.runCommandBatch(created.id!, args, owner);
    return this.wait(created.id!, args.waitMs ?? 30000, created.token);
  }
  private async runCommandBatch(
    id: string,
    args: { asset: string; commands: string[]; cwd?: string; stopOnError?: boolean },
    owner: string,
  ) {
    const operation = this.operations.get(id)!;
    const group = this.commandBatches.get(id)!;
    const s = this.session(args.asset);
    try {
      let failed = 0;
      for (let i = 0; i < args.commands.length; i++) {
        if (this.disposed) return;
        this.checkLease(s, group.token, undefined, false);
        let child = (await this.executeSubshell(
          {
            asset: args.asset,
            command: args.commands[i],
            cwd: args.cwd,
            leaseToken: group.token,
            requestId: `${id}:${i}`,
            waitMs: 0,
          },
          owner,
          false,
        )) as OperationResult;
        if (!child.id) throw new ToolError('NOT_READY', '会话不可用，后续命令未执行。');
        operation.steps!.push(child.id);
        this.store.saveOperation(operation);
        this.change(s);
        while (child.status === 'running') {
          if (this.disposed) return;
          this.checkLease(s, group.token, undefined, false);
          child = await this.wait(child.id, 1000);
        }
        const header = `\n[${i + 1}/${args.commands.length}] ${this.safe(s, args.commands[i])}\n`;
        this.appendBatchOutput(operation, Buffer.from(header));
        const fd = fs.openSync(this.store.outputPath(child.id), 'r');
        try {
          const chunk = Buffer.alloc(65536);
          let read;
          while ((read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0)
            this.appendBatchOutput(operation, chunk.subarray(0, read));
        } finally {
          fs.closeSync(fd);
        }
        if (child.outputDropped) operation.outputDropped = true;
        if (child.status !== 'completed') {
          operation.status = child.status;
          operation.message = '当前步骤未正常结束，后续命令未执行。';
          break;
        }
        if (child.exitCode !== 0) failed ||= child.exitCode ?? 1;
        operation.exitCode = failed;
        if (failed && args.stopOnError !== false) {
          operation.message = '遇到非零退出码，后续命令未执行。';
          break;
        }
      }
      if (operation.status === 'running') operation.status = 'completed';
    } catch {
      operation.status = 'unknown';
      operation.message = '占用失效或执行状态不能确认；后续命令未执行，不会自动重试。';
    } finally {
      if (this.disposed) return;
      operation.finishedAt = Date.now();
      this.store.saveOperation(operation);
      if (group.autoLease && s.lease?.token === group.token) {
        try {
          await this.release(args.asset, group.token);
        } catch {}
      }
      this.commandBatches.delete(id);
      this.emit('operation', id);
      this.change(s);
    }
  }
  private appendBatchOutput(operation: Operation, buffer: Buffer) {
    const file = this.store.outputPath(operation.id);
    const bytes = fs.statSync(file).size;
    const remaining = MAX_OUTPUT - bytes;
    if (remaining > 0) fs.appendFileSync(file, buffer.subarray(0, remaining));
    if (buffer.length > remaining) operation.outputDropped = true;
  }
  private async recover(s: Session, release: boolean) {
    this.setStatus(s, 'recovering', '正在确认中断结果。');
    let idle = false;
    for (let i = 0; i < 30; i++) {
      if (s.binding && this.isIdle(s, await this.terminal.capture(s.binding))) {
        idle = true;
        break;
      }
      await sleep(100);
    }
    if (s.activeJob)
      this.endAbnormally(
        s,
        idle ? 'interrupted' : 'unknown',
        idle ? '命令已中断并返回提示符。' : '中断结果无法确认。',
      );
    if (release) s.lease = undefined;
    this.setStatus(
      s,
      idle ? 'ready' : 'needs_attention',
      idle ? undefined : '不能确认远端命令已停止，请人工处理。',
    );
  }
  async expire() {
    for (const s of this.sessions.values()) {
      const expired = s.lease;
      if (!expired || expired.expiresAt > Date.now()) continue;
      await this.locked(s.asset, async () => {
        if (s.lease?.token !== expired.token || s.lease.expiresAt > Date.now()) return;
        s.lease = undefined;
        if (!s.binding) return;
        try {
          await this.terminal.key(s.binding, 'Ctrl-C');
          await this.recover(s, true);
        } catch {
          this.endAbnormally(s, 'unknown', '占用超时，连接状态无法确认。');
          this.setStatus(s, 'needs_attention', '占用超时，无法确认中断结果。');
        }
      });
    }
  }
  async close(name: string) {
    return this.locked(name, async () => {
      const s = this.session(name);
      if (s.inspectTimer) clearTimeout(s.inspectTimer);
      if (s.loginTimer) clearTimeout(s.loginTimer);
      s.inspectTimer = undefined;
      s.loginTimer = undefined;
      s.bridge?.close();
      s.bridge = undefined;
      if (s.binding) {
        try {
          await this.terminal.close(s.binding);
        } catch {}
      }
      this.endAbnormally(s, 'unknown', '连接被人工关闭。');
      s.binding = undefined;
      s.lease = undefined;
      this.setStatus(s, 'disconnected');
      this.saveBindings();
      return this.view(s);
    });
  }
  async startBatch(assets: string[]) {
    if ([...this.batches.values()].some((b) => b.status === 'running' || b.status === 'paused'))
      throw new ToolError('BATCH_BUSY', '已有批量登录任务。');
    const selected = this.store
      .config()
      .assets.filter((a) => assets.includes(a.name))
      .map((a) => a.name);
    if (!selected.length) throw new ToolError('EMPTY_BATCH', '请先选择资产。');
    const b: Batch = {
      id: randomUUID(),
      assets: selected,
      index: 0,
      status: 'running',
      results: [],
    };
    this.batches.set(b.id, b);
    this.advanceBatches();
    return b;
  }
  private batchAdvancing = false;
  private advanceBatches() {
    if (this.batchAdvancing) return;
    this.batchAdvancing = true;
    queueMicrotask(() => {
      void (async () => {
        for (const b of this.batches.values()) {
          if (b.status !== 'running') continue;
          while (b.index < b.assets.length) {
            const name = b.assets[b.index];
            let s = this.sessions.get(name);
            if (!s || s.status === 'disconnected' || s.status === 'target_closed') {
              await this.ensure(name);
              s = this.sessions.get(name);
            }
            if (b.status !== 'running') break;
            if (s?.status === 'ready') {
              b.results.push({
                asset: name,
                outcome: s.lease ? '复用已有连接（占用中）' : '已连接',
              });
              b.index++;
              continue;
            }
            if (
              s &&
              [
                'error',
                'needs_attention',
                'needs_username',
                'needs_host_verification',
                'needs_password',
              ].includes(s.status)
            )
              b.status = 'paused';
            break;
          }
          if (b.index === b.assets.length) b.status = 'completed';
        }
      })()
        .catch(() => {
          for (const b of this.batches.values()) if (b.status === 'running') b.status = 'paused';
        })
        .finally(() => {
          this.batchAdvancing = false;
          this.change();
        });
    });
  }
  async batchAction(id: string, action: 'retry' | 'skip' | 'cancel') {
    const b = this.batches.get(id);
    if (!b || !['running', 'paused'].includes(b.status))
      throw new ToolError('UNKNOWN_BATCH', '批量登录任务不可操作。');
    if (action === 'cancel') {
      b.status = 'cancelled';
      const s = this.sessions.get(b.assets[b.index]);
      if (s && s.status !== 'ready') await this.close(s.asset);
    } else if (action === 'skip') {
      b.results.push({ asset: b.assets[b.index], outcome: '已跳过' });
      const s = this.sessions.get(b.assets[b.index]);
      if (s && s.status !== 'ready') await this.close(s.asset);
      b.index++;
      b.status = 'running';
    } else {
      const s = this.sessions.get(b.assets[b.index]);
      if (s && s.status !== 'ready' && !['connecting', 'waiting_code'].includes(s.status))
        await this.close(s.asset);
      b.status = 'running';
    }
    this.advanceBatches();
    this.change();
    return b;
  }
  saveConfig(value: unknown): Config {
    const before = this.store.config();
    for (const s of this.sessions.values())
      if (s.binding) {
        const next = (value as Config).assets?.find((a) => a.name === s.asset);
        if (JSON.stringify(next) !== JSON.stringify(before.assets.find((a) => a.name === s.asset)))
          throw new ToolError('CONFIG_IN_USE', '修改已连接资产前，请先关闭其连接。');
      }
    const c = this.store.saveConfig(value);
    this.change();
    return c;
  }
  async credentials(id: string, password: string | undefined, username?: string, remember = true) {
    const c = this.store.config();
    const b = c.bastions.find((b) => b.id === id);
    if (!b) throw new ToolError('UNKNOWN_BASTION', '找不到堡垒机。');
    if (username) {
      if (!/^[A-Za-z0-9_.@-]+$/.test(username))
        throw new ToolError('INVALID_USERNAME', '用户名格式不正确。');
      b.username = username;
      this.store.saveConfig(c);
    }
    if (password !== undefined) {
      if (password.length > 4096 || /[\r\n\0]/.test(password))
        throw new ToolError('INVALID_PASSWORD', '密码格式不正确。');
      if (password) this.knownSecrets.add(password);
      this.store.savePassword(id, remember ? password || undefined : undefined);
      if (!remember && password) this.temporaryPasswords.set(id, password);
      else this.temporaryPasswords.delete(id);
    } else if (!remember) {
      const old = this.store.password(id);
      if (old) this.temporaryPasswords.set(id, old);
      this.store.savePassword(id);
    } else if (this.temporaryPasswords.has(id)) {
      this.store.savePassword(id, this.temporaryPasswords.get(id));
      this.temporaryPasswords.delete(id);
    }
    for (const s of this.sessions.values())
      if (s.status === 'needs_password' && this.asset(s.asset).bastion === id) {
        s.passwordSubmitted = false;
        await this.inspect(s);
      }
    this.change();
    return { saved: Boolean(this.store.password(id)) };
  }
  webUrl(asset?: string) {
    return `http://127.0.0.1:${this.runningPort}${asset ? '/?asset=' + encodeURIComponent(asset) : ''}`;
  }
  state() {
    const config = this.store.config();
    const credentials = this.store.credentials();
    return {
      config,
      sessions: this.list(),
      batches: [...this.batches.values()],
      credentials: Object.fromEntries(
        config.bastions.map((b) => [b.id, Boolean(credentials[b.id]?.password)]),
      ),
      webUrl: this.webUrl(),
      operations: [...this.operations.values()]
        .slice(-100)
        .reverse()
        .map(({ signature: _signature, owner: _owner, ...operation }) => operation),
    };
  }
  async call(action: string, args: any = {}, owner = 'Agent'): Promise<unknown> {
    switch (action) {
      case 'state':
        return this.state();
      case 'config_save':
        return this.saveConfig(args.config);
      case 'credentials_save':
        return this.credentials(args.bastion, args.password, args.username, args.remember);
      case 'credentials_forget':
        this.store.savePassword(args.bastion);
        this.temporaryPasswords.delete(args.bastion);
        this.change();
        return { saved: false };
      case 'list':
        return this.list();
      case 'connect':
        return this.ensure(args.asset);
      case 'reconnect':
        if (this.sessions.has(args.asset)) await this.close(args.asset);
        return this.ensure(args.asset);
      case 'import':
        return this.importSession(args.asset, args.socket, args.name);
      case 'discover':
        return [
          ...(await this.terminal.list('bastion-bridge')),
          ...(await this.terminal.list('bastion-bridge-inspect')),
        ];
      case 'verify_host':
        return this.verifyHost(args.asset, args.fingerprint);
      case 'code':
        return this.submitCode(args.asset, args.code);
      case 'username':
        return this.selectUsername(args.asset, args.username);
      case 'acquire':
        return this.acquire(args.asset, owner);
      case 'renew':
        return this.renew(args.asset, args.leaseToken);
      case 'release':
        return this.release(args.asset, args.leaseToken);
      case 'takeover':
        return this.takeover(args.asset, owner);
      case 'send':
        return this.send(args.asset, args.leaseToken, args.text, args.submit);
      case 'key':
        return this.key(args.asset, args.leaseToken, args.key);
      case 'read':
        return this.read(args.asset, args.leaseToken, args.cursor);
      case 'resize':
        return this.resize(args.asset, args.leaseToken, args.cols, args.rows);
      case 'confirm':
        return this.confirm(args.asset);
      case 'close':
        return this.close(args.asset);
      case 'exec':
        return this.execute(args, owner);
      case 'subshell_exec':
        return this.executeSubshell(args, owner);
      case 'subshell_batch':
        return this.executeSubshellBatch(args, owner);
      case 'operation_wait':
        return this.wait(args.operationId, args.waitMs ?? 30000, args.leaseToken);
      case 'operation_read':
        return this.result(args.operationId, args.cursor, args.maxBytes);
      case 'batch_start':
        return this.startBatch(args.assets);
      case 'batch_action':
        return this.batchAction(args.id, args.action);
      default:
        throw new ToolError('UNKNOWN_ACTION', '未知工具调用。');
    }
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    for (const s of this.sessions.values()) {
      if (s.inspectTimer) clearTimeout(s.inspectTimer);
      if (s.loginTimer) clearTimeout(s.loginTimer);
      this.endAbnormally(s, 'unknown', '后台停止，SSH 保留；操作结果需重新确认。');
      s.lease = undefined;
      s.bridge?.close();
    }
    for (const id of this.commandBatches.keys()) {
      const o = this.operations.get(id)!;
      o.status = 'unknown';
      o.message = '后台停止，后续批量命令未执行。';
      this.store.saveOperation(o);
      this.emit('operation', id);
    }
    this.commandBatches.clear();
  }
}
type OperationStatusAlias = 'interrupted' | 'unknown';

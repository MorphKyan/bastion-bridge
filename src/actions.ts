import { z } from 'zod';
const asset = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const token = z.string().uuid();
const waitMs = z.number().int().min(0).max(60000).optional();
const requestId = z.string().min(1).max(200).optional();
const lease = { asset, leaseToken: token };
export const actions = {
  state: z.object({}),
  config_save: z.object({ config: z.unknown() }),
  credentials_save: z.object({
    bastion: asset,
    username: z.string().optional(),
    password: z.string().max(4096).optional(),
    remember: z.boolean().optional(),
  }),
  credentials_forget: z.object({ bastion: asset }),
  list: z.object({}),
  discover: z.object({}),
  connect: z.object({ asset }),
  reconnect: z.object({ asset }),
  import: z.object({ asset, socket: asset, name: asset }),
  verify_host: z.object({ asset, fingerprint: z.string().max(100) }),
  code: z.object({ asset, code: z.string().max(32) }),
  username: z.object({ asset, username: z.string().max(100) }),
  acquire: z.object({ asset }),
  renew: z.object(lease),
  release: z.object(lease),
  takeover: z.object({ asset }),
  send: z.object({
    ...lease,
    text: z.string().max(128 * 1024),
    submit: z.boolean().optional(),
  }),
  key: z.object({ ...lease, key: z.string().max(20) }),
  read: z.object({ ...lease, cursor: z.number().int().min(0).optional() }),
  resize: z.object({
    ...lease,
    cols: z.number().int().min(20).max(500),
    rows: z.number().int().min(5).max(200),
  }),
  confirm: z.object({ asset }),
  close: z.object({ asset }),
  exec: z.object({
    asset,
    command: z.string().min(1).max(65536),
    cwd: z.string().max(4096).optional(),
    leaseToken: token,
    requestId,
    waitMs,
  }),
  subshell_exec: z.object({
    asset,
    command: z.string().min(1).max(65536),
    cwd: z.string().max(4096).optional(),
    leaseToken: token.optional(),
    requestId,
    waitMs,
  }),
  subshell_batch: z.object({
    asset,
    commands: z.array(z.string().min(1).max(65536)).min(1).max(100),
    cwd: z.string().max(4096).optional(),
    leaseToken: token.optional(),
    requestId,
    waitMs,
    stopOnError: z.boolean().optional(),
  }),
  operation_wait: z.object({ operationId: token, waitMs, leaseToken: token.optional() }),
  operation_read: z.object({
    operationId: token,
    cursor: z.number().int().min(0).optional(),
    maxBytes: z
      .number()
      .int()
      .min(16)
      .max(1024 * 1024)
      .optional(),
  }),
  batch_start: z.object({ assets: z.array(asset).min(1) }),
  batch_action: z.object({ id: token, action: z.enum(['retry', 'skip', 'cancel']) }),
} as const;
export type Action = keyof typeof actions;
export const agentActions: Action[] = [
  'list',
  'acquire',
  'renew',
  'release',
  'send',
  'key',
  'read',
  'exec',
  'subshell_exec',
  'subshell_batch',
  'operation_wait',
  'operation_read',
];
export const descriptions: Partial<Record<Action, string>> = {
  list: '列出配置资产、登录状态和占用者。不会读取终端内容。',
  acquire:
    '按资产名称复用或建立连接并申请独占输入。等待密码/验证码时返回网页地址；已占用时返回 SESSION_BUSY。保存返回的 lease.token 用于交互调用。',
  renew: '续期占用；长时间思考或运行任务时在 5 分钟默认期限内续期。',
  release:
    '终端返回提示符后释放占用，保留 SSH 和当前 Shell 环境。运行中的任务须先中断；后续使用者会继承目录和环境。',
  send: '凭占用令牌发送交互输入；submit=true 追加 Enter。此调用只表示输入已提交。',
  key: '发送控制键，例如 Ctrl-C 中断、Enter、Tab。Ctrl-C 后确认命令停止；无法确认则标记待人工处理。',
  read: '凭占用令牌读取终端增量输出。保存 cursor 用于下次读取；读取不会消耗其他调用者的输出。',
  exec: '默认：先 acquire，再凭 leaseToken 在当前 Bash Shell 中执行前台命令。目录、变量、函数和 Shell 选项持续保留；cwd 会修改当前目录。每次返回独立的操作 ID、输出、退出码和状态，完成后仍保留占用，最后显式 release。使用稳定 requestId 去重。默认等待 30 秒；running 时用 operation_wait 续期并等待。交互程序使用 send/read/key。',
  subshell_exec:
    '高级：每条命令在独立 Bash 子 Shell 中执行，继承当前目录和已导出的环境；cwd 及环境修改只影响本条命令。自动申请/释放占用，也可传已有 leaseToken。使用稳定 requestId 去重；running 时保存操作 ID 和 leaseToken，用 operation_wait 等待。',
  subshell_batch:
    '高级：在同一个占用下顺序执行 commands，每条使用独立子 shell，默认遇非零退出码停止。一次返回各步骤结果；整批默认等待 30 秒。running 时返回批量操作 ID 和 leaseToken，使用 operation_wait 续期并等待整批完成。稳定 requestId 防止重试重新执行。',
  operation_wait:
    '等待某次命令完成，直接返回结果；最长等待 60 秒。运行中请传 leaseToken 续期。不会重新执行命令。',
  operation_read:
    '按 operationId 只读取该命令的结果，可用 cursor 分段读取长输出；不会读取整个终端历史。',
};

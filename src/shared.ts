export interface Bastion {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  fingerprint?: string;
}
export interface Asset {
  name: string;
  ip: string;
  username?: string;
  bastion: string;
  promptPattern?: string;
}
export interface Config {
  bastions: Bastion[];
  assets: Asset[];
  leaseSeconds: number;
  port: number;
}
export type SessionStatus =
  | 'connecting'
  | 'needs_host_verification'
  | 'needs_password'
  | 'waiting_code'
  | 'needs_username'
  | 'ready'
  | 'recovering'
  | 'needs_attention'
  | 'target_closed'
  | 'disconnected'
  | 'error';
export interface Lease {
  token: string;
  owner: string;
  kind: 'agent' | 'human';
  expiresAt: number;
}
export interface SessionView {
  asset: string;
  status: SessionStatus;
  message?: string;
  accounts: string[];
  connectedUsername?: string;
  lease?: Omit<Lease, 'token'>;
  activeOperation?: string;
  attached?: boolean;
  fingerprint?: string;
}
export interface Binding {
  asset: string;
  socket: string;
  name: string;
  pane: string;
}
export type OperationStatus = 'running' | 'completed' | 'interrupted' | 'unknown';
export type ExecutionMode = 'session' | 'subshell';
export interface Operation {
  executionMode?: ExecutionMode;
  id: string;
  asset: string;
  command: string;
  cwd?: string;
  status: OperationStatus;
  exitCode: number | null;
  createdAt: number;
  finishedAt?: number;
  requestId?: string;
  outputDropped: boolean;
  message?: string;
  kind?: 'batch';
  steps?: string[];
}
export interface OperationResult extends Operation {
  output: string;
  truncated: boolean;
  cursor: number;
  leaseToken?: string;
  results?: OperationResult[];
}
export interface Batch {
  id: string;
  assets: string[];
  index: number;
  status: 'running' | 'paused' | 'completed' | 'cancelled';
  results: { asset: string; outcome: string }[];
}
export class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

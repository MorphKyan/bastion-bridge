import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config, Binding, Operation } from '../shared.js';
import { ToolError } from '../shared.js';

const name = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const assetSchema = z.object({
  name,
  ip: z.ipv4(),
  username: z
    .string()
    .regex(/^[A-Za-z0-9_.@-]+$/)
    .optional(),
  bastion: name,
  promptPattern: z.string().max(256).optional(),
});
export const configSchema = z
  .object({
    bastions: z.array(
      z.object({
        id: name,
        name: z.string().min(1),
        host: z.string().regex(/^[A-Za-z0-9_.-]+$/),
        port: z.number().int().min(1).max(65535),
        username: z.string().regex(/^[A-Za-z0-9_.@-]+$/),
        fingerprint: z
          .string()
          .regex(/^SHA256:[A-Za-z0-9+/]+$/)
          .optional(),
      }),
    ),
    assets: z.array(assetSchema),
    leaseSeconds: z.number().int().min(10).max(86400),
    port: z.number().int().min(1024).max(65535),
  })
  .superRefine((c, ctx) => {
    if (
      new Set(c.assets.map((a) => a.name)).size !== c.assets.length ||
      new Set(c.bastions.map((b) => b.id)).size !== c.bastions.length
    )
      ctx.addIssue({ code: 'custom', message: 'Names must be unique.' });
    for (const a of c.assets) {
      if (!c.bastions.some((b) => b.id === a.bastion))
        ctx.addIssue({ code: 'custom', message: `Unknown bastion for ${a.name}.` });
      if (a.promptPattern)
        try {
          new RegExp(a.promptPattern);
        } catch {
          ctx.addIssue({ code: 'custom', message: `Invalid prompt pattern for ${a.name}.` });
        }
    }
    const keys = c.assets.map((a) => `${a.bastion}:${a.ip}:${a.username ?? ''}`);
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Duplicate asset connection identities are not allowed.',
      });
  });
export function defaultConfig(): Config {
  return {
    port: 8765,
    leaseSeconds: 300,
    bastions: [],
    assets: [],
  };
}
export class Store {
  readonly configDir: string;
  readonly stateDir: string;
  readonly socketPath: string;
  constructor(base?: string) {
    this.configDir = base
      ? path.join(base, 'config')
      : path.join(
          process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
          'bastion-bridge',
        );
    this.stateDir = base
      ? path.join(base, 'state')
      : path.join(
          process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'),
          'bastion-bridge',
        );
    for (const dir of [this.configDir, this.stateDir, this.operationDir]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    }
    this.socketPath = path.join(this.stateDir, 'daemon.sock');
    if (!fs.existsSync(this.configPath)) this.write(this.configPath, defaultConfig());
  }
  get configPath() {
    return path.join(this.configDir, 'config.json');
  }
  get operationDir() {
    return path.join(this.stateDir, 'operations');
  }
  get knownHostsPath() {
    return path.join(this.configDir, 'known_hosts');
  }
  read<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e: any) {
      if (e.code === 'ENOENT') return fallback;
      throw new ToolError('STORE_INVALID', 'A private state file is invalid; inspect it locally.');
    }
  }
  write(file: string, value: unknown) {
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
      fs.chmodSync(file, 0o600);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  }
  config(): Config {
    return configSchema.parse(this.read(this.configPath, defaultConfig()));
  }
  saveConfig(value: unknown): Config {
    const c = configSchema.parse(value);
    this.write(this.configPath, c);
    return c;
  }
  credentials(): Record<string, { password: string }> {
    return this.read(path.join(this.configDir, 'credentials.json'), {});
  }
  password(id: string): string | undefined {
    return this.credentials()[id]?.password;
  }
  savePassword(id: string, password?: string) {
    const c = this.credentials();
    if (password === undefined) delete c[id];
    else c[id] = { password };
    this.write(path.join(this.configDir, 'credentials.json'), c);
  }
  redact(text: string, extra: string[] = []): string {
    for (const secret of [...Object.values(this.credentials()).map((c) => c.password), ...extra]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length))
      text = text.split(secret).join('[REDACTED]');
    return text;
  }
  bindings(): Binding[] {
    return this.read(path.join(this.stateDir, 'sessions.json'), []);
  }
  saveBindings(b: Binding[]) {
    this.write(path.join(this.stateDir, 'sessions.json'), b);
  }
  saveOperation(o: Operation) {
    this.write(path.join(this.operationDir, `${o.id}.json`), o);
  }
  operations(): Operation[] {
    return fs
      .readdirSync(this.operationDir)
      .filter((f) => /^[a-f0-9-]+\.json$/.test(f))
      .map((f) => this.read<Operation>(path.join(this.operationDir, f), null!))
      .filter(Boolean);
  }
  outputPath(id: string) {
    if (!/^[a-f0-9-]+$/.test(id)) throw new ToolError('INVALID_OPERATION', 'Invalid operation ID.');
    return path.join(this.operationDir, `${id}.output`);
  }
}

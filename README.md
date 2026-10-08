# bastion bridge

本机堡垒机会话工具：tmux 保留 SSH，网页负责登录、验证码和终端操作，CLI / MCP 供 Agent 调用。所有终端输入由同一后台进程检查占用令牌。

## 启动与配置

需要 Linux / WSL、Node.js 24+、tmux 3.x、OpenSSH 和 util-linux 的 `flock`。

```bash
npm ci
npm run build
node dist/cli.js start
```

打开 **http://127.0.0.1:8765**。网页仅监听本机，无登录或访问令牌，并校验请求来源。`serve` 前台启动，`stop` 停止后台并保留 SSH；CLI / MCP 也会自动启动后台。启动失败时检查私有状态目录的 `daemon.log`。安装命令入口后可用 `bastion-bridge` 代替 `node dist/cli.js`。

首次启动生成空配置。参照 [config.example.json](config.example.json) 在私有配置中填写堡垒机和资产，按 IP 选择目标；示例不会自动加载，也不要覆盖已有配置。

| 内容                     | 默认位置                                   |
| ------------------------ | ------------------------------------------ |
| 连接配置                 | `~/.config/bastion-bridge/config.json`     |
| 保存的凭据、SSH 主机记录 | 同目录的 `credentials.json`、`known_hosts` |
| 会话状态、操作结果、日志 | `~/.local/state/bastion-bridge/`           |

支持 `XDG_CONFIG_HOME`、`XDG_STATE_HOME`；`BASTION_BRIDGE_HOME` 可指定独立目录，其下使用 `config/` 和 `state/`。改名升级时，将新目录链接到原私有目录，保留配置、凭据及 `sessions.json` 中的 tmux socket 记录，已有 SSH 可继续复用。项目所在目录无需改名。

真实配置、凭据和运行状态应放在仓库外。私有目录权限为 `700`，配置、凭据、操作文件和 Unix socket 为 `600`。密码和验证码通过网页或私有文件输入，不要放进命令行参数；网页不使用 localStorage 保存凭据。

## 网页使用

1. 选择资产，填写堡垒机用户名与密码；勾选“记住”保存到本机私有文件。
2. 点击“连接 / 复用”，提交本次验证码；账号菜单无法自动匹配时人工选择。首次连接须核实 SSH 指纹。
3. 默认只读监控；点击“接管”撤销旧 Agent 令牌后输入命令，回到 Shell 提示符后“释放”。命令面板也需先接管。
4. 多资产可“串行登录”；失败可重试、跳过或取消，成功连接保留。

“导入已有连接”发现默认 `bastion-bridge` / `bastion-bridge-inspect` socket 的终端；其他 socket 用 CLI `import`。导入前核实目标资产，导入保留 SSH。“确认终端可复用”仅在已回到配置的 Shell 提示符时恢复待确认终端。

## Agent：CLI / MCP

默认流程为 `acquire → exec → release`。保存 `acquire` 返回的 `lease.token`，每次写入传入当前令牌：

```bash
node dist/cli.js acquire example-asset
node dist/cli.js exec example-asset 'cd /path/to/app' --lease LEASE_TOKEN --request-id UNIQUE_ID_1
node dist/cli.js exec example-asset 'pwd' --lease LEASE_TOKEN --request-id UNIQUE_ID_2
node dist/cli.js release example-asset --lease LEASE_TOKEN
```

`exec` 在当前远端 Bash 中运行，目录、变量和函数持续保留；可选 `--cwd` 修改当前目录。`release` 保留 SSH 和环境。`subshell-exec` / `subshell-batch` 使用独立子 Shell，可自动申请和释放占用，环境修改不传到下一步。交互程序使用 `send/read/key`；完整 CLI 参数见 `node dist/cli.js --help`。

执行结果包含操作 ID、状态、退出码、输出和字节游标；唯一输出帧确定完成，stdout / stderr 合并返回。默认等待 30 秒，最多 60 秒；返回 `running` 后继续等待，长时间闲置时续期：

```bash
node dist/cli.js wait OPERATION_ID --lease LEASE_TOKEN --wait-ms 30000
node dist/cli.js result OPERATION_ID --cursor NEXT_CURSOR
node dist/cli.js renew example-asset --lease LEASE_TOKEN
```

重试同一请求须保留 `requestId`，只查询原操作；结果游标使用返回值，不能用文本长度代替。结果为 `unknown` 时不要自动重跑。提示符只用于确认终端可复用；占用超时会中断并检查提示符，不能确认时等待网页处理。默认占用 300 秒，可配置 `leaseSeconds`；特殊 Shell 提示符可配置资产的 `promptPattern`。

在 MCP 客户端添加 stdio 服务，绝对路径按实际安装位置填写：

```json
{
  "mcpServers": {
    "bastion-bridge": {
      "command": "node",
      "args": ["/path/to/project/dist/mcp.js"]
    }
  }
}
```

工具：`list`、`acquire`、`exec`、`renew`、`release`、`send`、`read`、`key`、`operation_wait`、`operation_read`、`subshell_exec`、`subshell_batch`。需要验证码时返回状态和网页地址。升级后重启后台及 MCP 客户端刷新接口；后台停止保留 SSH，未完成操作标为未知，旧令牌失效。网络断开或本机重启后需重新登录。

## 开发与验证

`npm run dev` 启动后台，另一个终端运行 `npm run web:dev`，访问 `http://127.0.0.1:5173`。

```bash
npm run check
npm test
npx playwright install chromium
npm run build && npm run test:web
```

测试使用临时私有状态目录、模拟堡垒机及独立 tmux socket，不连接真实资产。

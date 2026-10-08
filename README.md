# AI Term

独立的本机堡垒机会话工具。tmux 保留 SSH 连接；网页负责人工登录、验证码和终端操作；MCP/CLI 负责 Agent 调用。所有工具输入经过同一后台进程的占用检查。

## 启动

需要 Linux/WSL、Node.js 24+、tmux 3.x、OpenSSH 和 util-linux 的 `flock`。

```bash
npm ci
npm run build
node dist/cli.js start
```

打开 **http://127.0.0.1:8765**。网页仅监听本机，不设置登录、访问令牌或用户权限。对跨站请求和不匹配的网页来源做请求校验。

`node dist/cli.js serve` 前台启动；`node dist/cli.js stop` 停止后台并保留 SSH。MCP 和其他 CLI 命令也会自动启动后台。后台启动失败时检查本机私有状态目录中的 `daemon.log`。

开发：`npm run dev` 启动后台，另一个终端运行 `npm run web:dev`，打开 `http://127.0.0.1:5173`。

## 网页操作

1. 选择资产，在“用户名与密码”中输入堡垒机凭据。勾选“记住”保存到本机私有文件；取消勾选时密码只在当前后台进程的内存中保留。保存后可再次打开并替换密码，密码字段不会回填保存的内容。
2. 点击“连接 / 复用”。新登录停在验证码输入框，提交本次代码后按配置 IP 进入资产。
3. 出现账号菜单时自动选择配置用户名；未配置或找不到该账号时，网页要求人工选择。选择后记入资产配置。
4. 默认只读监控。点击“接管”使旧 Agent 凭证失效，然后直接输入命令、粘贴或使用 Ctrl-C。“释放”要求终端已回到提示符。
5. 命令面板默认在当前 Shell 中执行，需先接管取得占用，目录和环境修改会持续保留。“高级选项”中的“独立子 Shell”仅让环境修改在本次有效，允许自动申请和释放占用。
6. 勾选多台资产，点击“串行登录”。按配置顺序逐个验证，已有健康连接直接复用。失败暂停，可重试、跳过或取消；已成功的连接保留。

“导入已有连接”可登记默认工具 socket 或本次检查使用的 `ai-term-inspect` socket 中的终端。导入会重命名 tmux 会话并保持现有 SSH；其他 socket 可以通过 CLI 导入。导入前须明确核实该终端属于所选资产，工具检查可见连接提示和当前用户名。

“确认终端可复用”是人工恢复操作：只在当前终端符合配置的 shell 提示符时解除待确认状态，并撤销原占用。

## Agent：默认连续操作

默认流程为 `acquire → exec → release`。先申请占用，保存返回的 `lease.token`，每次 `exec` 都传入该令牌：

```bash
node dist/cli.js acquire example-asset
node dist/cli.js exec example-asset 'cd /path/to/app' --lease LEASE_TOKEN --request-id enter-app-1
node dist/cli.js exec example-asset 'source env.sh' --lease LEASE_TOKEN --request-id load-env-1
node dist/cli.js exec example-asset 'whoami; pwd' --lease LEASE_TOKEN --request-id inspect-environment-1
node dist/cli.js release example-asset --lease LEASE_TOKEN
```

`exec` 在当前远端 Bash Shell 中执行，不启动新的 Shell。目录、变量、函数和 Shell 选项持续保留；`cwd` 可选，指定时修改当前目录，切换失败不执行正文。每次执行完成后仍持有占用，最后显式释放。`release` 保留 SSH 和环境，下一位使用者会继承这些状态；可用 `exec 'pwd'` 检查当前目录。重连后不保证恢复之前的环境。

每次执行返回独立结果：

```json
{
  "id": "<operation-id>",
  "executionMode": "session",
  "status": "completed",
  "exitCode": 0,
  "output": "appuser\n/home/appuser\n",
  "truncated": false,
  "cursor": 25
}
```

输入和输出使用唯一开始/结束标记，不混入历史、回显或提示符。读取原始 tmux 控制流，结果文件按流清理 ANSI，stdout/stderr 合并返回。后台进程同时向终端打印的内容仍可能混入本次输出。`exec` 面向前台非交互命令；交互程序使用 `send/read/key`。`send` 只确认输入已提交，`read` 返回终端增量输出，不提供逐命令结果。

默认等待 30 秒，上限 60 秒。返回 `running` 表示等待时间结束，命令继续执行。使用操作 ID 和占用令牌继续等待：

```bash
node dist/cli.js wait OPERATION_ID --lease LEASE_TOKEN --wait-ms 30000
node dist/cli.js result OPERATION_ID --cursor NEXT_CURSOR
node dist/cli.js renew example-asset --lease LEASE_TOKEN
```

`operation_wait` 等待结果并续期；长时间思考时主动 `renew`。`operation_read` 只读取该操作的结果。默认每页最多 64 KiB，完整输出最多保存 64 MiB，超过保存上限明确返回 `outputDropped`。游标按保存文件的 UTF-8 字节计算，不能用返回文本长度代替它。

同一资产和 `requestId` 重试只查询原操作，换了命令、工作目录或执行模式则报冲突。请求标识应全局唯一，例如 UUID；不要为一次重试生成新的标识。`exec` 的重试同样需要有效占用令牌，失效后可用 `operation_read` 查询原操作。CLI 的调用者固定为 `CLI`，MCP 每个进程有独立的调用者标识。

`exit`、`exec` 替换 Shell、Shell 选项、trap 或永久重定向可能使结束标记无法输出。仅超时仍返回 `running`；连接关闭时结果为 `unknown`，`exitCode` 为 `null`。中断或人工确认可恢复终端，但不会猜测此前结果或自动重新执行命令。提示符仅用于确认终端可以复用。

## 高级：独立子 Shell

`subshell_exec` 每次在独立 Bash 子 Shell 中运行，继承当前目录和已导出的环境。目录、变量和选项修改只影响本次子 Shell；文件等外部修改仍会保留。自动申请占用，完成且终端可复用后自动释放；传入已有令牌时保留占用。结果的 `executionMode` 为 `subshell`。

`subshell_batch` 在同一次占用下顺序执行命令列表，每一步使用独立子 Shell，默认遇非零退出码停止，返回各步骤结果。步骤之间不能传递 Shell 环境修改。长任务返回整批操作 ID，继续等待即可。

```bash
node dist/cli.js subshell-exec example-asset 'tail -n 30 application.log' --cwd /path/to/app
# FILE 是只包含命令字符串数组的 JSON 文件。
node dist/cli.js subshell-batch example-asset --commands-file FILE --request-id investigation-1
```

交互流程：`acquire ASSET` → 保存 `lease.token` → `send/read/key` → `release`。CLI 的 `list` 列出会话，`--help` 列出完整命令。

## 命名迁移

这是不保留旧别名的接口调整：

| 旧接口 / CLI                                        | 新接口 / CLI                                          |
| --------------------------------------------------- | ----------------------------------------------------- |
| `session_*` 动作                                    | 去掉 `session_` 前缀，如 `list/acquire/send/read/key` |
| 原子 Shell `exec` / CLI `exec`                      | `subshell_exec` / CLI `subshell-exec`                 |
| `exec_batch` / CLI `exec-batch`                     | `subshell_batch` / CLI `subshell-batch`               |
| 新默认执行                                          | `exec`，必须传入占用令牌，在当前 Shell 中执行         |
| `operation_wait/operation_read` / CLI `wait/result` | 名称和结果读取方式保留                                |

历史操作缺少执行模式字段时按 `subshell` 解释。升级后重启后台和 MCP 客户端以刷新工具列表；后台停止保留 SSH，未完成操作标为未知。

## MCP 配置

在 Agent 客户端的 MCP 配置中添加 stdio 工具，路径按实际安装目录填写：

```json
{
  "mcpServers": {
    "ai-term": {
      "command": "node",
      "args": ["/root/ai-term/dist/mcp.js"]
    }
  }
}
```

默认工具：`list`、`acquire`、`exec`、`renew`、`release`、`send`、`read`、`key`；通用结果工具：`operation_wait`、`operation_read`；高级工具：`subshell_exec`、`subshell_batch`。工具返回结构化结果；需要验证码时返回状态与网页地址。

## 配置、凭据与生命周期

默认配置：`~/.config/ai-term/config.json`；凭据：同目录 `credentials.json`；工具自己的 SSH 主机记录：`known_hosts`。状态及操作输出：`~/.local/state/ai-term/`。支持 `XDG_CONFIG_HOME`、`XDG_STATE_HOME`；`AI_TERM_HOME` 可将配置和状态放在指定目录的 `config/` 和 `state/` 子目录中。

真实配置只保存在上述本机私有目录，不随仓库提交。首次启动生成空的 `bastions` 和 `assets`，不会预置真实连接信息，也不会覆盖已有配置。仓库中的 `config.example.json` 仅用于说明格式，地址使用文档专用网段，账号为虚构示例；不会自动加载。首次使用时将示例复制到 `~/.config/ai-term/config.json`（不要覆盖已有配置），再替换为实际堡垒机和资产信息；主机指纹通过网页核实后保存。密码仍须通过网页或私有文件单独提供。真实配置和状态目录应放在仓库之外。

私有目录权限为 `700`，配置、凭据、操作文件和 Unix socket 为 `600`。密码和验证码经标准输入进入 tmux 临时缓冲区，粘贴后删除；不出现在进程参数中。网页不使用 localStorage 保存凭据。密码和验证码不写入 Git 或运行日志。

`config.json` 中 `assets` 包含 `name`、`ip`、可选 `username` 和 `bastion`；`bastions` 包含地址、端口、用户名和已确认的指纹。`leaseSeconds` 默认 300；`port` 默认 8765，修改端口后重启后台。特殊提示符可在资产的 `promptPattern` 配置正则。修改已连接资产须先关闭其连接，避免绑定到错误的目标。

可以通过私有文件提供凭据，不要在命令行参数中填密码：

```bash
node dist/cli.js credentials --bastion qizhi --username bastion-user --password-file /path/outside/repo/password
node dist/cli.js import example-asset --socket ai-term-inspect --name qizhi-bastion-inspect
```

占用超时先撤销凭证，发送 Ctrl-C 并确认提示符；不能确认则阻止复用，等待网页处理。后台执行批量命令本身不会给失联调用者持续续期。有效工具调用、正在等待的调用和网页心跳会续期。后台停止后不再维持占用，重启使旧令牌失效，并将未完成操作标为未知。

tmux 保留连接不保证网络或堡垒机永不超时。网络断开、本机重启或认证连接失效后，重新登录仍需新的验证码。Ctrl-C 针对前台任务，不能保证脱离终端的后台进程停止。通过本机其他程序直接操作 tmux 会绕过工具占用；Agent 应统一使用本工具接口。

## 验证

```bash
npm run check
npm test
npx playwright install chromium
npm run build && npm run test:web
```

测试使用模拟堡垒机及独立 socket 的本机 Bash/tmux，不连接真实资产。覆盖可选账号菜单、串行验证码与重试、输出边界与分片、退出码、持久 Shell 与独立子 Shell、长输出、请求去重、并发占用、接管、超时中断、重启、网页终端、凭据修改及本机来源校验。

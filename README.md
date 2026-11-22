# Python 环境管理器

在 DSH Web 界面**输入框左侧工具栏**点「Python」按钮，为**当前对话**选择 Python 解释器。选择按对话隔离：每个对话（包括它的子代理任务）使用自己选定的解释器，**互不影响**；其他对话不会继承本对话的选择。

选择保存在 `~/.dsh/python-env-manager/state.json` 的 `sessions.<会话ID>` 下。子代理跟随它所属的根对话。未选择的对话不会自动使用任何解释器：Python 执行会明确报错，提示你在该对话的工具栏里选择，而不是回退到系统 `python`。

## 本地环境发现

面板列出两类候选：

- **本机解释器**（conda / venv / PATH），包括 **Termux（Android）**：Termux 前缀 `$PREFIX`（`/data/data/com.termux/files/usr`）会显式探测，检测只读文件系统、不执行任何解释器；
- **SSH 远程解释器**：从 `~/.ssh/config` 读取主机（跳过通配符模式，跟随 `Include`，最多 16 台），用 `ssh -o BatchMode=yes` 批量探测远端的 `python3` / `python`（含 Termux 固定路径）。**没有任何主机、主机不可达或远端没有 Python 时，SSH 分组显示为不可选的灰色条目**，不会发送任何请求的选择；选择一旦存在，形如 `ssh://user@host[:port]/绝对路径/python3`。

SSH 探测使用密钥认证（BatchMode 永不等待密码输入），结果缓存 60 秒，「刷新」按钮强制重新探测。探测只远端执行 `command -v` 风格的查询，不写任何文件。

选择后：

- 该对话及其子代理的 Python 任务通过插件提供的 `python_env_run` 工具执行，使用你选定的解释器，仍受 DSH 沙箱和权限审批约束；
- 选择 `ssh://` 条目时，`python_env_run` 通过本机 `ssh` 客户端在远端执行该解释器，每个参数都为远端 shell 单引号转义（远端工作目录为登录 home 目录）；
- 该对话的模型终端里还会得到 `DSH_PYTHON`（选定解释器的绝对路径或 `ssh://` URI），可在已获准的沙箱 shell 中显式调用：PowerShell `& $env:DSH_PYTHON --version`，Bash `"$DSH_PYTHON" --version`；
- 系统 `PATH`、IDE、已有终端和已经运行的进程**不会**被修改；终端里的裸 `python` 命令仍走系统 PATH。

工具入口（智能体也可用，均作用于**当前对话**）：

| 你想做什么 | 工具调用 |
| --- | --- |
| 执行 Python | `python_env_run`：`{"argv":["-c","print(1)"]}`，参数逐字传给解释器，不是 shell |
| 查看本对话环境与选择 | `python_env_manager`：`{"action":"list"}` |
| 保存本对话选择 | `python_env_manager`：`{"action":"select","path":"列表中的完整路径或 ssh:// URI"}` |
| 取消本对话选择 | `python_env_manager`：`{"action":"clear"}` |

本机接口（供按钮使用）：`GET /python-env/api/state?sessionId=...`、`GET /python-env/api/ssh?sessionId=...[&force=1]`、`POST /python-env/api/select`、`POST /python-env/api/clear`、`POST /python-env/api/refresh`（后三者 JSON body 带 `sessionId`）。

限制与说明：

- 环境发现只表示存在候选解释器路径，不保证其依赖、健康或可信；运行前由沙箱约束文件访问。
- 插件无法安全地全局改写终端里的 `python` 命令；Python 任务请使用 `python_env_run` 或 `DSH_PYTHON`。
- 若你在项目里说「列出 Python 环境」，工具会额外扫描当前会话目录的 `.venv`/`venv`；工具栏面板固定列出默认工作区可见的环境。
- 本机接口仅随 DSH 的 127.0.0.1 监听提供，并拒绝带跨域 `Origin` 的请求；本地选择只接受已发现或合法的 `python`/`python3`/`python.exe` 绝对路径，SSH 选择必须是合法的 `ssh://[user@]host[:port]/绝对路径` 且以 python 结尾。
- 不创建、下载、激活或删除环境，不修改系统 PATH，不影响 IDE 或已有终端；SSH 探测不保存任何凭据。
- 若要移除本对话的选择，点按钮里的「清除选择」。禁用插件会移除工具、提醒和按钮，不会卸载任何 Python。

此目录是可从 **Plugins → Add plugin** 选择的本地 bundle；选择前可检查源码，无需构建。

## 许可

[MIT](LICENSE) © 2026 hawkqiang
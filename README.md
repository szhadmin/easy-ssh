# Easy SSH

Windows 桌面端的 SSH / SFTP / Docker 可视化管理工具。面向"不想背命令但要把服务器管明白"的人：连上服务器就有图形界面看负载、传文件、改权限、开终端、管容器。

<p>
  <a href="https://github.com/szhadmin/easy-ssh/releases"><img alt="release" src="https://img.shields.io/github/v/release/szhadmin/easy-ssh?color=blue"></a>
  <a href="https://github.com/szhadmin/easy-ssh/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/github/license/szhadmin/easy-ssh?color=green"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6">
  <img alt="electron" src="https://img.shields.io/badge/Electron-33-47848F">
  <img alt="typescript" src="https://img.shields.io/badge/TypeScript-5.6-3178C6">
</p>

- **仓库地址**：<https://github.com/szhadmin/easy-ssh>
- **问题反馈**：<https://github.com/szhadmin/easy-ssh/issues>
- **下载安装包**：<https://github.com/szhadmin/easy-ssh/releases>
- **联系方式**：571545079@qq.com

> **免责声明**：本工具会以你提供的凭据登录远程服务器并执行命令（包括删除、结束进程、`docker` 操作等）。
> 请在测试环境先行验证，生产环境操作前确认命令与目标机。因使用本工具造成的任何数据丢失或服务中断，由使用者自行承担。

---

## 一、技术选型

| 方案 | 终端体验 | Docker / SFTP 生态 | 安装包体积 | 交叉打包难度 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **Electron + TS + React**（本方案） | xterm.js，等同 VS Code 终端 | `ssh2`（纯 JS）+ 复用远端 docker CLI | ~85 MB | 低，`electron-builder` 一条命令出 NSIS | ✅ 采用 |
| Python + PySide6 | 需 pyte/QTermWidget，交互与尺寸适配坑多 | paramiko 成熟 | ~90 MB（含 Qt） | 中，PyInstaller + Inno Setup 两段式 | 备选 |
| C# WPF | 需自己实现 VT 解析 | SSH.NET 成熟 | ~40 MB | 需 .NET SDK 与目标机运行时 | 备选 |
| Go + Fyne | 无成熟终端控件 | golang.org/x/crypto/ssh 成熟 | ~25 MB | Fyne 界面质感偏弱 | 不推荐 |

**为什么选 Electron**：这个工具 70% 的体验取决于「终端 + 文件表格 + 图表」，这三样在前端的成熟度碾压其它方案。xterm.js 直接给你一个和 VS Code 同源的终端；`electron-builder` 原生支持生成带向导、桌面快捷方式、卸载入口的 NSIS 安装包，不需要再手写 Inno Setup 脚本。

**为什么 Docker 可视化不引 `dockerode`**：目标机的 docker 只能通过 SSH 访问，`dockerode` 需要暴露 `2375/tcp`（危险，等于把 root 权限挂在公网）。本方案直接在 SSH 会话里跑 `docker ... --format '{{json .}}'`，零额外端口、零远端改动、权限沿用登录账号。

---

## 二、功能清单

### 连接管理
- 密码 / 私钥（含 passphrase）/ SSH Agent 三种认证方式
- 凭据用 Electron `safeStorage`（底层 Windows DPAPI，按当前用户加密）落盘，**不写明文**；降级时会在「关于」里标注
- 新建前可「测试连接」，失败给出中文根因（认证失败 / 端口非 SSH / 超时 / 无法到达主机 …）
- 连接配置可导出为 JSON（**不含密码**）用于备份迁移

### 概览（可视化）
- CPU 使用率 / 内存 / 负载 / 网络吞吐四张指标卡 + 实时折线图（保留最近 60 个采样点）
- 分区磁盘占用表（带进度条与配色告警）
- 进程 Top 16，可切换「按 CPU / 按内存」排序，支持一键结束进程（二次确认）
- 采集全部基于 `/proc` + `ps`，**不需要远端装任何东西**，Alpine / BusyBox 也能用（PS 不支持 `--sort` 时自动退化到 `top -bn1`）

### 终端
- 完整 VT 终端（xterm.js）：真彩色、滚动回看 8000 行、窗口自适应、链接可点
- **上下文补全（新手友好）**：**任意位置**按 `Tab` 都弹候选 —— 命令名 / 子命令 / 选项 / 路径 / 容器名 / 镜像名 / 服务名 / 用户名 / 分支名都能补；`↑↓` 选择、`Tab/Enter` 补全、`Esc` 关闭
  - **会跟着命令一路往下走**：`docker` 补出 `ps/exec/logs/...`；`docker ps` 再按 `Tab` 补出 `-a/--filter/--format`；`docker ps --filter ` 直接给 `status=running`、`name=web` 这类取值，不用背参数
  - **路径能一路钻进去**：`cd /var/lo` → `cd /var/log/`（目录候选自动带 `/`）→ 接着按 `Tab` 继续钻到 `/var/log/nginx/`；`~` 与相对路径都按远端当前目录解析
  - **接真实远端数据**：容器名、镜像名、systemd 服务、用户名 / 组、git 分支 / remote 都是连上后按需拉取（8 秒缓存，拉不到就空着、不报错、不卡终端）
  - **候选太多不刷屏**：默认只展开 8 条，底部提示「还有 N 条没显示」；按 `→` 展开全部、`←` 收起
  - **包装命令也认**：`sudo` / `watch` / `env` / `xargs` 后面跟的命令照样补（`sudo systemctl restart ` 会补服务名）
  - 每行候选都带中文说明和类型标签（命令 / 选项 / 目录 / 容器 …），不认识也能看着选
  - 命令名候选 = 内置中文词典（90+ 高频命令）+ 连上后从 `/bin /sbin /usr/bin …` 扫出来的真实命令表
- **命令手册**：按分类浏览全部命令，带中文说明、示例参数、危险标记，点击即插入终端
- **危险命令拦截**：`rm -rf` / `mkfs` / `dd of=/dev/…` / `shutdown` / `docker system prune` 等命中时，回车前弹二次确认
- 常用命令快捷条，鼠标点一下就把命令打到命令行（不自动执行）
- 查找（SearchAddon）、复制、粘贴、清屏、重开会话
- **目录跟踪**：连上后终端会静默注入一段提示符钩子，远端 shell 每次打印提示符都会用标准 OSC 7 序列上报当前工作目录 —— 工具条上实时显示 `当前目录`，右侧文件面板跟着 `cd` 走（见下一节）
- 工具条可一键收起 / 展开右侧文件面板

### 终端 + 文件 联动（本次重点）

**布局**：切到「终端」标签，左边终端、右边文件面板，中间是可拖动的分隔条（双击恢复默认比例）。比例、跟随开关、面板开合都会记住。

**目录同步**：在终端里 `cd 到哪`，右侧文件列表就 `刷新到哪`。

实现方式（也是 FinalShell / Tabby / VS Code 这类工具的做法）：连上后向远端交互式 shell 注入一段**只读的提示符钩子**，让它在打印提示符前用 OSC 7 序列（`ESC ] 7 ; file://<host><path> ST`）上报当前目录，客户端解析后驱动文件面板。

- 不装任何服务端插件、不改远端任何文件，只在当前会话的 shell 里挂一个函数
- 只在**当前会话**生效，断开即消失
- 已适配 bash（挂 `PROMPT_COMMAND`，保留用户原有的）/ zsh（挂 `precmd_functions`）/ dash·ash（改写 `PS1`），幂等，重复注入不会叠加
- 注入分两步：先 `stty -echo` 关掉回显，再发脚本，最后用 ANSI 擦掉那行临时输出并恢复回显 —— 屏幕上不会留下痕迹
- 命令都带前导空格，Debian / Ubuntu 默认的 `HISTCONTROL=ignoreboth` 会让它们不进 history
- 若你已经开始敲键，注入会自动放弃，不会打断输入
- 远端 shell 不支持时会静默降级：终端照常可用，只是文件面板不再自动跟随（可手动点面包屑 / 「跳到终端目录」）

**反向操作**：文件面板工具条最右侧的终端图标，可以一键让终端 `cd` 到文件面板当前目录。

### 文件管理（SFTP）
- 两种形态：终端页右侧的**紧凑分栏**（工具栏收成图标、表格去掉时间列、操作按钮悬停浮在行尾），以及「文件」标签页的**全宽视图**
- **跟随终端**开关：`跟随终端` = 跟着终端目录自动刷新；`已锁定` = 停在当前目录（此时旁边会出现「跳到终端目录」按钮）
- 路径面包屑（可点击跳转）+ 直接输入路径 + 当前目录名筛选
- 上传文件（多选）/ 上传整个文件夹（递归）/ 下载（单文件走「另存为」，多选或目录走「选择保存目录」并递归拉取）
- 传输进度条：按文件显示已传 / 总量
- 新建目录、重命名（行内编辑）、删除（目录递归，二次确认，说明不可恢复）
- **权限编辑**：9 个位勾选框 + 八进制直填 + 644/755/600/700/777 快捷预设，实时预览 `rwxr-xr-x (755)`
- **在线编辑**：按扩展名自动识别语法（shell / Dockerfile / JSON / JS / TS / Python / YAML / ini），Ctrl+S 保存回服务器，带「未保存」标记；超过 8 MB 的文件拒绝打开，提示先下载

### Docker
- 自动检测 docker 是否可用；不可用时给「未安装 / 权限不足 / 守护进程没起」三档中文引导与重试
- 容器列表：状态标签、名称镜像、端口映射、运行时长、启停重启删除
- 镜像列表
- 点击容器 → 右侧抽屉：
  - **详情**：容器 ID / 镜像 / 重启策略 / IP / 网络 / 启动命令 / 端口映射 / 挂载卷 / 环境变量
  - **快捷诊断**：在容器内执行「查看进程 / 环境变量 / 工作目录 / 磁盘占用 / 监听端口」等，输出直接落到日志页
  - **日志**：100/300/1000/3000 行可选、自动跟随、复制
  - **进入容器**：抽屉内直接开一个容器内 shell（自动 bash → sh 降级）

### 连接稳定性（长时间挂机不掉线）
- **SFTP 通道复用**：一条 SSH 连接只维持 **一条** SFTP 通道，所有文件操作共用它。旧写法是每次列目录 / 读属性 / 改权限都新开一条通道且从不关闭，而 OpenSSH 的 `MaxSessions`（默认 10）限制的是「单条连接上同时打开的通道数」—— 浏览十几个目录就把名额用光，之后终端、文件、Docker 一起报 `(SSH) Channel open failure: open failed`。现在同样的操作全程只用 1 条通道（回归测试实测 90 次文件操作后 `sftpChannels=1`）
- **意外掉线自动重连**：非用户主动断开时，按 1.5s → 4s → 8s → 15s → 25s 退避重试；恢复后终端面板会自动重开一个 shell，顶部状态与 Toast 同步提示
- **心跳与死亡检测**：`keepaliveInterval: 15s` × `keepaliveCountMax: 3`，约 45 秒内就能发现「连接其实已经死了」，比默认的 6 × 90s 快得多
- **选中不会重复建连**：切连接时自动连接与手动连接会互相挤掉，已改成幂等（同一条连接只会建一个 SSH 会话，回归测试断言 `connections=1`）
- **错误中文化**：把 ssh2 的原始错误翻成人话 —— 通道打满会提示「通道数已达服务器上限（OpenSSH MaxSessions 默认 10）」而不是甩一个英文 `open failed`

### AI 助手（Linux / 运维 专家）
- 终端工具栏打开右侧 AI 抽屉，6 个内置角色：**Linux 专家 / 运维 SRE / Docker 容器 / Shell 脚本 / 安全加固 / 网络排障**；每个角色都能再加一段「补充要求」（比如「我们统一 Ubuntu 22.04、Nginx 只改 conf.d」）
- **只认 OpenAI 兼容协议**，所以一套配置通吃：内置 DeepSeek / 通义千问（百炼兼容模式）/ 智谱 GLM / Moonshot / OpenAI / 本地 Ollama / 自定义网关（one-api、new-api 之类的中转也能填）
- 配置项：`Base URL` + `API Key` + `模型名` + `temperature`；「测试连接」发一条最短请求，一次把**地址 / Key / 模型**三件事全验掉
- **API Key 不落明文**：走和连接密码同一套 `safeStorage`（Windows DPAPI）加密，界面上只显示 `sk-a…3f9c` 这样的脱敏串；明文 Key 只存在于主进程内存，**不进渲染进程**
- **流式输出**：逐字上屏，带「停止」按钮可随时中断；推理模型（DeepSeek-R1 / QwQ 等）的思维链会被单独识别并折叠展示，不混进正文
- **自动带上服务器环境**：每次提问自动附上当前连接的系统 / 内核 / CPU / 内存 / Docker 版本 / 终端所在目录 / 最近一次采样，并明确告诉模型「可直接采信、不要反问」（开关可关）
- **模型可自动获取**：模型配置里点「获取模型」会调用 OpenAI 兼容的 `GET /v1/models` 并提供下拉候选；部分中转服务未实现这个接口时仍可手动填写模型名
- **系统提示词不对用户展示**：界面只保留「补充要求」供你填写环境约束；内置角色规则和实际拼接的系统提示词不会显示
- **Markdown 渲染**：支持标题、列表、引用、代码块、行内代码、加粗、删除线、链接；不解析原始 HTML，避免模型输出注入界面
- **终端 Agent 用原生 tool calling**（基于 [Vercel AI SDK](https://ai-sdk.dev) 的 `streamText` + `stopWhen`）：终端工具栏点「AI 助手」在右侧打开抽屉，左侧终端始终可见。执行模式分为「手动执行 / 受限授权 / 完全信任（高级）」。模型通过 `run_command({ intent, command })` 工具**一次只申请一条单行命令**，由当前真实 PTY 执行后把输出与退出码回传，模型才决定下一步或收尾 —— 不再解析一整段回复后批量执行代码块
- **命令始终跑在你看得见的那个终端里**：命令由渲染层注入当前可见 PTY（不走后台 `ssh.exec`），回显、实时输出、`Ctrl+C` 都与手工输入一致。输出边界靠**纯 ASCII 行哨兵**标定（`__EASYSSH_AGENT_<token>_START__` / `_END__<code>`）—— 不能用 OSC，因为哨兵是拼进「键入的命令行」的，而 `ESC` 是 readline 的 meta 前缀会被连同后一字符一起吞掉，那样命令早就跑完了 Agent 却只能干等到超时
- **一步多条命令会串行排队**：模型偶尔会在同一回合里一次给出两条命令。终端只有一个，多给的命令按顺序依次注入、一条跑完再跑下一条 —— 并发注入会让后一条把前一条的**输出边界**覆盖掉，表现就是「命令早跑完了，Agent 却一直显示等待终端结果」。回灌前还会剥掉终端输出的 ANSI 色码，免得 `[1m` 这类残渣既费 token 又干扰阅读
- **多轮时间线**：每一轮任务是一个独立回合，新的对话**只追加、不覆盖**上一轮的展示；每轮里能看到「目标 → 每步的判断 / 命令 / 终端输出 / 退出码 → 结论」，可单独「重新发送」或整体「清空对话」
- 上游错误翻译成人话：401 → Key 无效或过期、404 → 地址少了 `/v1`、429 → 限流/配额用尽、5xx → 上游异常，并附上服务商返回的原因

---

## 三、目录结构

```
esay-ssh/
├── package.json                     # 依赖与脚本
├── LICENSE                          # MIT 开源协议
├── .gitignore                       # 忽略依赖 / 产物 / 临时文件
├── .npmrc                           # npm 镜像 + 缓存目录（不占 C 盘）
├── electron.vite.config.ts          # main / preload / renderer 三段构建配置
├── electron-builder.yml             # 打包配置（NSIS 向导 + 快捷方式 + 卸载）
├── tsconfig.json / .node / .web     # 分端 TS 配置
├── build/
│   ├── icon.ico                     # 应用图标（7 种尺寸，脚本生成）
│   └── installer.nsh                # 自定义 NSIS 脚本（卸载时可选保留配置）
├── scripts/
│   ├── make-icon.mjs                # 纯 Node 生成多尺寸 .ico，零依赖
│   ├── check-integration.mjs        # 注入脚本自检（bash/sh 语法 + 真实 OSC 输出）
│   ├── check-osc.mjs                # OSC 7 解析器 + Agent 哨兵扫描器自检（36 条用例，覆盖分片切法 + ANSI 剥离）
│   ├── check-complete.cjs           # 补全引擎自检（88 条用例，纯逻辑、不起 Electron）
│   ├── check-channels.cjs           # SSH 通道泄漏回归（37 条断言，含"旧写法必然被拒"的灵敏度自检）
│   ├── check-agent.cjs              # AI 助手回归（65 条断言，配一个假 OpenAI 兼容服务 + 自建反向桥）
│   ├── tsconfig.check.json          # 补全自检的 TS→CJS 编译配置
│   ├── tsconfig.ssh.json            # ssh-manager 自检的 TS→CJS 编译配置
│   ├── tsconfig.agent.json          # agent.ts / agent-bridge.ts 自检的 TS→CJS 编译配置
│   ├── mock-ssh-server.mjs          # 本地 Mock SSH（pty 回显 + 内存 SFTP + MaxSessions 模拟 + 统计/杀连接端口）
│   ├── smoke-cwd-sync.js            # 端到端冒烟（注入 → 目录同步 → 分栏断言）
│   ├── smoke-completion.js          # 端到端冒烟（真实远端数据 → 补全链路 + 面板断言）
│   ├── smoke-channels.js            # 端到端冒烟（40 次文件操作 + 终端存活 + 通道计数）
│   ├── smoke-agent.js               # 端到端冒烟（AI 面板 → 工具调用 → 可见 PTY 执行 → 多轮时间线）
│   ├── check-channels-ui.cjs        # 用打包产物跑通道冒烟并核对 Mock 统计（12 条断言）
│   └── check-agent-ui.cjs           # 用打包产物 + 假 LLM 跑终端 Agent 全链路（81 条断言，含一步多命令）
├── src/
│   ├── shared/                      # 主/渲染进程共用
│   │   ├── types.ts                 # 数据模型
│   │   ├── agent-roles.ts           # AI 角色模板（6 个专家人设）+ 供应商预设
│   │   ├── agent-tools.ts           # 终端 Agent 的公共约定：工具名、命令校验、ASCII 哨兵、输出截断
│   │   ├── channels.ts              # IPC 通道名 + 事件名
│   │   └── api.ts                   # window.api 类型契约
│   ├── main/                        # 主进程（Node 侧，持有 SSH 连接）
│   │   ├── index.ts                 # 应用入口、窗口、事件广播
│   │   ├── ipc.ts                   # 全部 IPC handler（统一 try/catch → IpcResult）
│   │   ├── ssh-manager.ts           # 会话管理、终端通道、SFTP 通道复用、自动重连
│   │   ├── shell-integration.ts     # 目录跟踪：向远端 shell 注入 OSC 7 提示符钩子
│   │   ├── monitor.ts               # /proc 指标采集与解析
│   │   ├── docker.ts                # docker CLI 封装
│   │   ├── complete.ts              # 补全的动态数据源（容器名 / 服务名 / 用户 / 分支 … 带缓存）
│   │   ├── agent.ts                 # 终端 Agent：配置存储 + Vercel AI SDK 工具调用循环（streamText + stopWhen）
│   │   ├── agent-bridge.ts          # 工具执行的反向通道：主进程 ↔ 渲染层可见 PTY（挂起等待 + 超时兜底）
│   │   └── store.ts                 # 连接配置 + safeStorage 凭据加密
│   ├── preload/
│   │   ├── index.ts                 # contextBridge 暴露 window.api
│   │   └── index.d.ts               # Window 全局类型声明
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── main.tsx / App.tsx   # 入口与外壳（侧边栏 + 欢迎页）
│           ├── store.ts             # zustand 全局状态
│           ├── styles.css           # 全量样式（浅色主题）
│           ├── lib/
│           │   ├── utils.ts         # 格式化、路径、权限位等
│           │   ├── osc.ts           # OSC 7 解析器 + Agent 哨兵扫描器（都容忍网络分片切断）
│           │   ├── complete.ts      # 上下文补全引擎（分词 → 命令规格表 → 光标处该补什么）
│           │   └── commands.ts      # 命令词典（中文说明 + 危险标记）
│           └── components/
│               ├── ui.tsx           # 图标 / 按钮 / 弹窗 / Toast 等基础件
│               ├── ConnectionDialog.tsx
│               ├── Workspace.tsx    # 顶栏 + 标签页 + 终端/文件左右分栏 + 传输进度
│               ├── OverviewPanel.tsx
│               ├── TerminalPanel.tsx
│               ├── FilesPanel.tsx   # 全宽 / 紧凑两种形态，含权限弹窗与 CodeMirror 编辑器
│               ├── DockerPanel.tsx  # 含容器抽屉与容器内终端
│               ├── AgentPanel.tsx   # 终端 Agent 时间线（多轮累积）、Markdown、授权确认
│               └── AgentSettings.tsx # LLM 配置、角色提示词、连接测试
└── out/                             # 构建产物（main / preload / renderer）
```

---

## 四、开发运行

```bash
# 1) 安装依赖（首次会下载 Electron 运行时，约 90 MB）
npm install

# 2) 生成图标（仅首次或改设计后需要）
npm run icon

# 3) 类型检查（可选，提交前建议跑一遍）
npm run typecheck

# 4) 开发模式：热更新 + 自动打开窗口
npm run dev
```

Windows 上如果 `npm install` 卡在下载 Electron：

```bash
npm config set registry https://registry.npmmirror.com
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install
```

---

## 五、打包

### 5.1 便携版单文件 exe（免安装）

```bash
npm run dist:portable
# 产物：dist/EasySSH-Portable-1.0.0.exe
```

### 5.2 标准安装包（推荐，带向导 + 桌面快捷方式 + 卸载入口）

```bash
npm run dist
# 产物：dist/EasySSH-Setup-1.0.0.exe
```

安装包做了什么：
- 图形化安装向导，**可自选安装目录**（默认装到当前用户目录，无需管理员权限）
- 自动创建**桌面快捷方式**与开始菜单项（名称：Easy SSH）
- 在「设置 → 应用」或开始菜单里可**正常卸载**
- 卸载时**询问**是否一并删除本地连接配置与加密凭据，默认保留（`build/installer.nsh` 控制）

只想要免打包的目录版（调试用）：

```bash
npm run dist:dir
# 产物：dist/win-unpacked/EasySSH.exe
```

> 若报 `remove ... app.asar: The process cannot access the file because it is being used by another process`，
> 说明上一次的 `EasySSH.exe` 还活着（或杀软正在扫刚生成的大文件）。
> 关掉进程后重跑，或换个输出目录绕开：
> `npx electron-builder --win nsis --config electron-builder.yml -c.directories.output=dist-out`

### 5.3 打包后的冒烟自检（可选）

设置环境变量后运行，程序会在界面渲染完成后自己截图并退出，用来验证「打包产物真的能起来」：

```bash
set EASYSSH_SMOKE=D:\smoke.png
set EASYSSH_SMOKE_CLICK=新建连接      # 可选：截图前先点击某个按钮，用于验证弹窗
dist\win-unpacked\EasySSH.exe
```

再加上 `EASYSSH_SMOKE_JS=<js 文件>` 可以在渲染进程里跑一段脚本，把界面摆到指定状态、顺便做断言，脚本的返回值会被打印出来。配合仓库里的 Mock SSH 服务，就能在没有真实服务器的前提下把「连接 → 注入 → 目录同步」整条链路验完：

```bash
# 1) 起本地 Mock SSH（带 pty 回显模拟 + 内存 SFTP，监听 127.0.0.1:2222）
node scripts/mock-ssh-server.mjs

# 2) 用打包产物跑端到端冒烟（--user-data-dir 让它用一次性配置目录，不动你本机的连接）
set EASYSSH_SMOKE=%CD%\smoke.png
set EASYSSH_SMOKE_JS=%CD%\scripts\smoke-cwd-sync.js
dist\win-unpacked\EasySSH.exe --user-data-dir=%CD%\.tmp-userdata
```

换 `scripts\smoke-completion.js` 就能验补全那条链路（连上 Mock 后拉真实远端数据跑补全、再模拟键盘敲 `cd /var/lo` + `Tab` 断言面板的标题 / 候选 / 折叠展开）：

```bash
set EASYSSH_SMOKE=%CD%\smoke-completion.png
set EASYSSH_SMOKE_JS=%CD%\scripts\smoke-completion.js
dist\win-unpacked\EasySSH.exe --user-data-dir=%CD%\.tmp-ud-c
```

### 5.4 纯逻辑自检（不需要启动 Electron）

```bash
node scripts/check-osc.mjs           # OSC 7 解析器 + Agent 哨兵扫描器：36 条用例，覆盖分片切法与 ANSI 剥离
node scripts/check-integration.mjs   # 注入脚本：bash/sh 语法检查 + 真实 OSC 输出 + 状态机顺序
# 注：这两个脚本读 .tmp-check/ 下的编译产物，需先执行
#   npx tsc src/renderer/src/lib/osc.ts src/main/shell-integration.ts \
#     --outDir .tmp-check --target es2022 --module esnext --moduleResolution bundler --skipLibCheck
```

补全引擎也能脱离 Electron 单测（88 条用例，覆盖分词 / 路径拆分 / 子命令 / 选项 / 选项取值 / 包装命令透传 / 目录下钻 / 引号处理）：

```bash
npx tsc -p scripts/tsconfig.check.json   # 把 complete.ts 编成 CommonJS 到 .tmp-check-cjs/
node scripts/check-complete.cjs          # === 88 passed, 0 failed ===

# SSH 通道复用 / 自动重连纯逻辑回归：12 条 UI + Mock SSH 统计断言
node scripts/check-channels-ui.cjs       # === 12 passed, 0 failed ===

# 终端 Agent 主进程逻辑：Key 加密、配置、探测、原生 tool calling、反向桥、
# 非法命令拦下、用户拒绝、步数上限、中止与错误翻译
npx tsc -p scripts/tsconfig.agent.json
node scripts/check-agent.cjs              # === 65 passed, 0 failed ===

# 终端 Agent 全链路：真实打包产物 + Mock SSH + 假 OpenAI 兼容服务
node scripts/check-agent-ui.cjs            # === 81 passed, 0 failed ===
```

> ⚠️ `ai` / `@ai-sdk/openai-compatible` / `zod` 都是 **ESM-only** 包，而 Electron 33 内置的
> Node 20.18 **不支持 `require(ESM)`**。所以这三个包必须放在 `devDependencies` 里，
> 让 `electron-vite build` 把它们**打进主进程产物**；一旦挪回 `dependencies`，
> `externalizeDepsPlugin` 会把它们留在外部，打包后启动时直接抛 `ERR_REQUIRE_ESM`
> （表现是「窗口不出来、也没有任何日志」）。`ssh2` 是 CJS，保持 externalize 不动。

> `check-channels-ui.cjs` 与 `check-agent-ui.cjs` 会启动本地 Mock 服务，并拉起
> `dist/win-unpacked/EasySSH.exe`；运行前请先关闭已打开的 EasySSH 实例。
>
> ⚠️ 在 CI / 自动化环境里启动 Electron 前，务必清掉 `ELECTRON_RUN_AS_NODE`，
> 否则 Electron 会以纯 Node 模式启动，报 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`。
>
> ⚠️ 用 Git Bash 跑冒烟时，`EASYSSH_SMOKE` / `EASYSSH_SMOKE_JS` 要写 **Windows 路径**
> （`F:/project/esay-ssh/...`）。Git Bash 的 `$PWD` 是 `/f/project/...`，
> 直接拼给原生 exe 会被解析成 `F:\f\project\...` → `ENOENT`。
>
> ⚠️ 改完源码要重新出产物，请走 `npm run dist:dir` / `npm run dist`（内含 `electron-vite build`）。
> 直接调 `npx electron-builder --win --dir` 只是重新打包**上一次**的 `out/`，会出现「源码改了但产物没变」。

---

## 六、测试与排错

### 6.1 自测清单

| 场景 | 预期 |
| --- | --- |
| 新建连接 → 填错密码 → 测试连接 | 提示「认证失败：用户名 / 密码 / 密钥不正确…」 |
| 目标端口填成 80 | 提示「SSH 握手失败：目标端口可能不是 SSH 服务」 |
| 内网未通的 IP | 提示「连接超时…检查网络 / 防火墙 / 安全组」 |
| 连上后看概览 | 3 秒内出 CPU / 内存 / 磁盘 / 进程数据 |
| 连上后切「终端」标签 | 左边终端、右边文件面板，中间有可拖动分隔条；工具条显示当前目录 |
| 在终端里 `cd /var/log` | 右侧文件列表自动刷成 `/var/log` 的内容，面包屑同步 |
| 在终端里 `cd /tmp && cd ..` | 文件面板跟到 `/`，不会来回跳 |
| 在文件面板手动点进 `/etc` 后，终端再 `cd /root` | 文件面板跟着跳到 `/root`（跟随只在目录真的变化时触发） |
| 点文件面板的「已锁定」，再在终端 `cd` | 面板不再跟随，出现「跳到终端目录」按钮 |
| 点最右侧终端图标 | 终端里自动 `cd` 到文件面板当前目录 |
| 断线重连 | 重新注入钩子，目录同步恢复 |
| 终端输入 `doc` 后按 Tab | 弹出候选，选中 `docker` 后补全 |
| 终端输入 `cd /var/lo` 后按 Tab | 面板标题显示「cd 的路径」，候选是 `local / lock / log / lost+found`，选中后补成 `cd /var/log/`（带 `/`） |
| 接上一步再按 Tab | 继续往下钻，补出 `/var/log/nginx/` |
| 终端输入 `docker ps -` 后按 Tab | 补出 `-a / -q -s --filter --format …`；已用过的 `-a` 不再重复出现 |
| 终端输入 `docker ps --filter ` 后按 Tab | 补出 `status=running`、`status=exited` … |
| 终端输入 `docker exec ` 后按 Tab | 列出服务器上真实的容器名（含已停止的） |
| 终端输入 `sudo systemctl restart ` 后按 Tab | 穿过 `sudo` 补出真实服务名（`nginx`、`sshd` …） |
| 终端输入 `docker logs --tail ` 后按 Tab | 收起不猜（数值型选项不瞎给候选） |
| 任意位置按 Tab，候选超过 8 条 | 只展示 8 条 + 底部「还有 N 条没显示」；按 `→` 展开全部、`←` 收起 |
| 断开服务器后按 Tab | 命令名 / 路径这类本地候选照常给；容器名等远端候选为空，终端不卡不报错 |
| 终端输入 `rm -rf /` 回车 | 弹危险命令二次确认，不直接执行 |
| 上传一个 200 MB 文件 | 进度条推进，完成后目录自动刷新 |
| 改一个文件权限为 600 | 列表刷新后权限列显示 `rw-------` |
| 在线编辑 `/etc/nginx/nginx.conf` | 有语法高亮，Ctrl+S 保存成功 |
| 非 root 账号点 Docker 标签 | 提示「当前账号无 Docker 权限，请加入 docker 组」 |
| 容器点「进入容器」 | 抽屉内出现容器内 shell 提示符 |
| 卸载程序 | 询问是否删除配置，选「否」则重装后配置还在 |

### 6.2 Windows Defender / 杀软误报

这是**所有未签名 exe 的共同问题**，不是本程序特有行为。成因：NSIS 自解压 + Electron 首次释放 `node.dll` 的行为与部分木马特征重合。

处理方式（按推荐度排序）：
1. **代码签名**（根治）：买一张 OV/EV 代码签名证书，在 `electron-builder.yml` 的 `win` 段加 `certificateFile` / `certificatePassword`，之后 SmartScreen 与杀软都会放行，还能去掉「未知发布者」。
2. **加白名单**：在 Windows 安全中心 → 病毒和威胁防护 → 排除项，添加安装目录。
3. **上报误报**：向 Microsoft 提交误报申诉（WDSI），一般 24–48 小时处理。
4. 便携版比安装版更容易被拦，正式分发请用安装包 + 签名。

### 6.3 其它常见坑

| 现象 | 原因 / 解法 |
| --- | --- |
| 双击 exe 一闪而过 | 用 `npm run dist:dir` 出目录版，进 `dist/win-unpacked` 直接跑 `EasySSH.exe` 看报错 |
| 中文路径下的私钥读不到 | 已在主进程用 Node `fs` 读原始字节，不经过命令行；若仍失败，把私钥复制到纯英文路径重试 |
| 连上瞬间终端闪一下 | 目录跟踪钩子的注入过程（先 `stty -echo` 再发脚本，最后擦掉那行）。正常应在一瞬间完成且不留痕迹；如果注入了却还残留一行 `stty -echo`，说明该 shell 不支持 `stty`，不影响使用 |
| 文件面板不跟随终端 | 目标 shell 可能把 `PROMPT_COMMAND` / `PS1` 覆盖掉了（例如某些加固过的环境）。终端完全不受影响，可手动点面包屑浏览，或用「跳到终端目录」 |
| 想把跟随改成默认关闭 | 「跟随终端」开关的状态会记住；也可清掉 `localStorage` 里的 `easyssh.prefs.v1` |
| 非 root 账号 SFTP 报「权限不足」 | 目标目录属于 root。改用 root 账号，或先用终端 `chown` / `chmod` 调整归属 |
| 概览无数据 | 极简容器（无 `/proc/stat` 或 `ps`）会缺字段；本程序会降级展示，不报错 |
| 进入容器报 TTY 错误 | 目标镜像里没有 `sh`（如纯 scratch 镜像），此时无法进容器，属正常 |
| 多开程序 | 已加单实例锁，第二次启动会聚焦已有窗口 |
| 凭据存储位置 | `%APPDATA%\EasySSH\data\connections.json`，密码字段是 DPAPI 密文，拷到别的机器无法解密（设计如此） |

---

## 七、安全说明

- 凭据**只在**主进程内存与 DPAPI 密文里出现，渲染进程拿不到（`contextIsolation: true` + 无 `nodeIntegration`）
- 目录跟踪钩子：只在**当前 SSH 会话**的交互式 shell 里定义一个函数并挂到提示符钩子上，不写远端文件、不改远端配置、不额外开端口；断开即消失，重连会重新注入（幂等）。它只做一件事：把 `$PWD` 通过标准 OSC 7 序列发回本机
- 所有 SFTP 路径、容器 ID 在拼进远端命令前做白名单校验，容器 ID 正则 `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`，避免命令注入
- 容器内一次性执行的诊断命令通过 **base64 转码**后再交给远端 shell，规避引号 / 转义注入
- 从文件面板反向 `cd` 时，路径里的单引号会按 shell 规则转义后再发送
- 不监听任何端口、不联网上传任何数据；只在用户点击时向目标服务器发起 SSH 连接
- 外部链接一律交给系统浏览器打开，应用内不导航、不开新窗口

---

## 八、开源协议

本项目以 **MIT License** 开源，全文见 [LICENSE](LICENSE)。

```
Copyright (c) 2026 szhadmin <571545079@qq.com>
```

MIT 允许你自由地：**商用、修改、分发、私有使用、再授权**。
唯一的要求是：在你分发本软件或其衍生作品时，**保留原始版权声明与这份许可声明**。

软件按「原样」提供，不含任何明示或暗示的担保；因使用本软件产生的任何损失，作者不承担责任。

### 联系方式

| 用途 | 地址 |
| --- | --- |
| 仓库 / Star | <https://github.com/szhadmin/easy-ssh> |
| Bug 反馈 / 功能建议 | <https://github.com/szhadmin/easy-ssh/issues> |
| 邮箱 | 571545079@qq.com |

### 参与贡献

1. Fork 本仓库并新建分支：`git checkout -b feat/your-feature`
2. 改完先跑自检（见 5.4 节），确保 `check-*.cjs` 全绿
3. 提交信息写清楚「改了什么、为什么」，然后提 Pull Request

### 第三方许可

| 组件 | 协议 |
| --- | --- |
| [ssh2](https://github.com/mscdex/ssh2) | MIT |
| [@xterm/xterm](https://github.com/xtermjs/xterm.js) | MIT |
| [CodeMirror 6](https://github.com/codemirror/dev) | MIT |
| [React](https://github.com/facebook/react) | MIT |
| [Recharts](https://github.com/recharts/recharts) | MIT |
| [Zustand](https://github.com/pmndrs/zustand) | MIT |
| [Electron](https://github.com/electron/electron) | MIT |


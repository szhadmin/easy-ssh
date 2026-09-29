import type { CommandHint } from '@shared/types'

/**
 * 常用命令词典：用于「新手提示条」和自动补全的描述。
 * danger = true 的命令在插入前会二次确认，避免新手误操作。
 */
export interface CommandEntry extends CommandHint {
  group: string
  /** 是否附一个示例参数 */
  example?: string
}

export const COMMAND_DICT: CommandEntry[] = [
  // ---------------- 目录与文件
  { cmd: 'pwd', desc: '显示当前所在目录', group: '目录与文件' },
  { cmd: 'ls', desc: '列出目录内容', group: '目录与文件' },
  { cmd: 'ls -alh', desc: '列出全部文件（含隐藏）并显示人类可读大小', group: '目录与文件' },
  { cmd: 'cd', desc: '切换目录', group: '目录与文件', example: '/var/log' },
  { cmd: 'cd ..', desc: '返回上一级目录', group: '目录与文件' },
  { cmd: 'cd ~', desc: '回到当前用户的家目录', group: '目录与文件' },
  { cmd: 'tree -L 2', desc: '以树状展示两层目录结构', group: '目录与文件' },
  { cmd: 'mkdir -p', desc: '递归创建目录', group: '目录与文件', example: '/data/app/logs' },
  { cmd: 'cp -r', desc: '递归复制目录', group: '目录与文件', example: 'src dst' },
  { cmd: 'mv', desc: '移动或重命名', group: '目录与文件', example: 'old new' },
  { cmd: 'rm -rf', desc: '强制递归删除，不可恢复', group: '目录与文件', danger: true, example: '/path' },
  { cmd: 'chmod 755', desc: '设置文件权限为 rwxr-xr-x', group: '权限与归属', example: '/path/file' },
  { cmd: 'chmod -R 644', desc: '递归设置目录内文件为 rw-r--r--', group: '权限与归属', example: '/path' },
  { cmd: 'chown -R', desc: '递归修改文件所有者', group: '权限与归属', danger: true, example: 'www-data:www-data /var/www' },
  { cmd: 'stat', desc: '查看文件详细属性（权限/大小/时间）', group: '权限与归属', example: '/etc/hosts' },
  { cmd: 'find / -name', desc: '按文件名全盘搜索', group: '目录与文件', example: 'nginx.conf 2>/dev/null' },

  // ---------------- 查看与编辑
  { cmd: 'cat', desc: '输出文件全部内容', group: '查看与编辑', example: '/etc/hosts' },
  { cmd: 'less', desc: '分页查看文件（q 退出，/ 搜索）', group: '查看与编辑', example: '/var/log/syslog' },
  { cmd: 'head -n 50', desc: '查看文件前 50 行', group: '查看与编辑', example: '/etc/nginx/nginx.conf' },
  { cmd: 'tail -f', desc: '实时跟踪日志输出（Ctrl+C 退出）', group: '查看与编辑', example: '/var/log/nginx/access.log' },
  { cmd: 'tail -n 200', desc: '查看文件最后 200 行', group: '查看与编辑', example: '/var/log/messages' },
  { cmd: 'grep -rn', desc: '递归搜索文本内容', group: '查看与编辑', example: '"error" /var/log' },
  { cmd: 'wc -l', desc: '统计文件行数', group: '查看与编辑', example: '/var/log/syslog' },
  { cmd: 'diff', desc: '比较两个文件的差异', group: '查看与编辑', example: 'a.conf b.conf' },
  { cmd: 'sed -i', desc: '就地替换文件内容', group: '查看与编辑', danger: true, example: "'s/old/new/g' /path/file" },

  // ---------------- 系统状态
  { cmd: 'top', desc: '实时进程与负载监控（q 退出）', group: '系统状态' },
  { cmd: 'uptime', desc: '查看运行时长与平均负载', group: '系统状态' },
  { cmd: 'free -h', desc: '查看内存与 swap 使用情况', group: '系统状态' },
  { cmd: 'df -h', desc: '查看各分区磁盘占用', group: '系统状态' },
  { cmd: 'du -sh *', desc: '统计当前目录下各子项占用', group: '系统状态' },
  { cmd: 'du -sh /* 2>/dev/null', desc: '找出根目录下最占空间的目录', group: '系统状态' },
  { cmd: 'iostat -x 1', desc: '查看磁盘 IO 负载', group: '系统状态' },
  { cmd: 'vmstat 1', desc: '查看内存/IO/CPU 综合指标', group: '系统状态' },
  { cmd: 'ss -tulnp', desc: '列出所有监听端口及对应进程', group: '网络' },
  { cmd: 'netstat -anp', desc: '查看所有网络连接', group: '网络' },
  { cmd: 'ip addr', desc: '查看网卡与 IP 地址', group: '网络' },
  { cmd: 'ping -c 4', desc: '测试网络连通性', group: '网络', example: '114.114.114.114' },
  { cmd: 'curl -I', desc: '只取 HTTP 响应头', group: '网络', example: 'https://example.com' },
  { cmd: 'curl -s ifconfig.me', desc: '查看本机公网出口 IP', group: '网络' },
  { cmd: 'dig +short', desc: '解析域名得到 IP', group: '网络', example: 'example.com' },
  { cmd: 'traceroute', desc: '跟踪到目标的路由路径', group: '网络', example: '8.8.8.8' },
  { cmd: 'iptables -L -n', desc: '查看防火墙规则', group: '网络' },
  { cmd: 'ufw status', desc: '查看 ufw 防火墙状态', group: '网络' },

  // ---------------- 进程与服务
  { cmd: 'ps aux', desc: '列出所有进程', group: '进程与服务' },
  { cmd: 'ps aux --sort=-%mem | head -20', desc: '按内存占用排序取前 20', group: '进程与服务' },
  { cmd: 'pgrep -a', desc: '按名称查找进程 PID', group: '进程与服务', example: 'nginx' },
  { cmd: 'kill -15', desc: '优雅结束进程', group: '进程与服务', danger: true, example: '1234' },
  { cmd: 'kill -9', desc: '强制杀死进程', group: '进程与服务', danger: true, example: '1234' },
  { cmd: 'systemctl status', desc: '查看 systemd 服务状态', group: '进程与服务', example: 'nginx' },
  { cmd: 'systemctl restart', desc: '重启服务', group: '进程与服务', danger: true, example: 'nginx' },
  { cmd: 'systemctl reload', desc: '热加载服务配置（不断连接）', group: '进程与服务', example: 'nginx' },
  { cmd: 'journalctl -u', desc: '查看服务日志（-f 实时跟随）', group: '进程与服务', example: 'nginx -n 200' },
  { cmd: 'journalctl -xe', desc: '查看本次启动的系统错误日志', group: '进程与服务' },
  { cmd: 'systemctl list-units --type=service --state=running', desc: '列出正在运行的服务', group: '进程与服务' },

  // ---------------- Docker
  { cmd: 'docker ps', desc: '查看运行中的容器', group: 'Docker' },
  { cmd: 'docker ps -a', desc: '查看全部容器（含已停止）', group: 'Docker' },
  { cmd: 'docker images', desc: '查看本地镜像列表', group: 'Docker' },
  { cmd: 'docker stats', desc: '容器资源占用（Ctrl+C 退出）', group: 'Docker' },
  { cmd: 'docker logs -f --tail 200', desc: '实时跟随容器日志', group: 'Docker', example: 'my-container' },
  { cmd: 'docker exec -it', desc: '进入容器交互式 shell', group: 'Docker', example: 'my-container bash' },
  { cmd: 'docker inspect', desc: '查看容器完整配置 JSON', group: 'Docker', example: 'my-container' },
  { cmd: 'docker restart', desc: '重启容器', group: 'Docker', example: 'my-container' },
  { cmd: 'docker stop', desc: '停止容器', group: 'Docker', example: 'my-container' },
  { cmd: 'docker compose ps', desc: '查看 compose 项目容器状态', group: 'Docker' },
  { cmd: 'docker compose up -d', desc: '后台启动 compose 项目', group: 'Docker' },
  { cmd: 'docker compose logs -f', desc: '跟随 compose 项目日志', group: 'Docker' },
  { cmd: 'docker system df', desc: '查看镜像/容器/卷占用磁盘情况', group: 'Docker' },
  { cmd: 'docker system prune -a', desc: '清理所有未使用镜像与资源', group: 'Docker', danger: true },

  // ---------------- 打包与传输
  { cmd: 'tar -czvf', desc: '打包并 gzip 压缩', group: '打包与传输', example: 'backup.tar.gz /data' },
  { cmd: 'tar -xzvf', desc: '解压 tar.gz', group: '打包与传输', example: 'backup.tar.gz' },
  { cmd: 'zip -r', desc: 'zip 递归压缩', group: '打包与传输', example: 'site.zip /var/www' },
  { cmd: 'unzip', desc: '解压 zip', group: '打包与传输', example: 'site.zip' },
  { cmd: 'scp -r', desc: '从本机/本机到远端复制（本工具已内置上传下载）', group: '打包与传输', example: 'dir user@host:/path' },

  // ---------------- 用户与安全
  { cmd: 'whoami', desc: '显示当前登录用户名', group: '用户与安全' },
  { cmd: 'id', desc: '查看当前用户 UID / GID / 所属组', group: '用户与安全' },
  { cmd: 'who', desc: '查看当前在线登录用户', group: '用户与安全' },
  { cmd: 'last -n 20', desc: '查看最近 20 次登录记录', group: '用户与安全' },
  { cmd: 'passwd', desc: '修改当前用户密码', group: '用户与安全' },
  { cmd: 'sudo -i', desc: '切换到 root 交互 shell', group: '用户与安全', danger: true },
  { cmd: 'crontab -l', desc: '查看当前用户的定时任务', group: '用户与安全' },
  { cmd: 'history', desc: '查看命令历史', group: '用户与安全' },

  // ---------------- 软件包
  { cmd: 'apt update && apt upgrade -y', desc: 'Debian/Ubuntu 更新软件源并升级', group: '软件包', danger: true },
  { cmd: 'apt install -y', desc: 'Debian/Ubuntu 安装软件包', group: '软件包', example: 'htop' },
  { cmd: 'yum install -y', desc: 'CentOS/RHEL 安装软件包', group: '软件包', example: 'htop' },
  { cmd: 'dnf install -y', desc: 'Fedora/RHEL8+ 安装软件包', group: '软件包', example: 'htop' }
]

/** 常用于「新手快捷条」的命令（每组挑几个高频的） */
export const QUICK_COMMANDS = [
  'ls -alh',
  'pwd',
  'df -h',
  'free -h',
  'uptime',
  'top',
  'docker ps',
  'tail -f /var/log/syslog'
]

const DICT_MAP: Map<string, CommandEntry> = new Map(COMMAND_DICT.map((e) => [e.cmd, e]))

export function describe(cmd: string): string | undefined {
  return DICT_MAP.get(cmd)?.desc ?? DICT_MAP.get(cmd.split(' ')[0])?.desc
}

export function isDangerous(cmd: string): boolean {
  const line = cmd.trim()
  const base = line.split(/\s+/)[0]
  if (DICT_MAP.get(line)?.danger) return true
  // 与终端 Enter 前的二次确认保持同一危险面；AI 执行不能绕开这些判断。
  return (
    /(^|\s)rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/.test(line) ||
    /(^|\s)rm\s+-[a-zA-Z]*f/.test(line) ||
    /(^|\s)mkfs(\.|\s|$)/.test(line) ||
    /(^|\s)dd\s+.*of=\/dev\//.test(line) ||
    /(^|\s)(shutdown|reboot|halt|poweroff)\b/.test(line) ||
    /(^|\s)(docker\s+system\s+prune|docker\s+volume\s+prune)/.test(line) ||
    />\s*\/dev\/sd/.test(line) ||
    /(^|\s)chmod\s+-R\s+777/.test(line) ||
    /(^|\s)chown\s+-R\s+.*\s+\/\s*$/.test(line) ||
    /^(rm|mkfs|dd|shutdown|reboot|halt|poweroff|init)$/.test(base)
  )
}

export function groupedDict(): Array<{ group: string; items: CommandEntry[] }> {
  const map = new Map<string, CommandEntry[]>()
  for (const e of COMMAND_DICT) {
    if (!map.has(e.group)) map.set(e.group, [])
    map.get(e.group)!.push(e)
  }
  return [...map.entries()].map(([group, items]) => ({ group, items }))
}

/*
 * 注：原来这里有个 buildSuggestions()，只会在「行内没有空格」时补命令名。
 * 现在补全统一走 lib/complete.ts 的上下文感知引擎（命令名 → 子命令 → 选项 → 参数），
 * 所以那个函数已经删掉，词典本身继续作为「命令名候选 + 中文说明」的数据源。
 */

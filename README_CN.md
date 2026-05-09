<div align="right"><sub><a href="./README.md">English</a> · <b>中文</b></sub></div>

<p align="center">
  <img src="https://img.shields.io/badge/_-claudex-cc785c?style=for-the-badge&labelColor=faf9f5" alt="claudex" />
</p>

<h1 align="center">claudex</h1>

<p align="center"><em><a href="https://docs.anthropic.com/zh-CN/docs/claude-code/overview">Claude Code</a> 的远程遥控器 —— 在任何浏览器里驱动你本机的 <code>claude</code> CLI。移动优先。</em></p>

<p align="center">
  <img alt="node" src="https://img.shields.io/badge/node-20%2B-3f9142?style=flat-square">
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-9%2B-cc785c?style=flat-square">
  <img alt="typescript" src="https://img.shields.io/badge/typescript-strict-1f1e1d?style=flat-square">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-9a968e?style=flat-square">
  <img alt="platform" src="https://img.shields.io/badge/platform-mac%20%7C%20linux-6b6862?style=flat-square">
</p>

---

## 为什么要 claudex

你已经为 Claude Code 付了费。它的权限模型、memory 文件、MCP 服务、插件体系你也信得过。工具本身好得不得了 —— 唯一的问题是：一离开键盘，它就凉了。

**claudex 不替代 Claude Code，它是围绕 Claude Code 的一个驾驶舱。** 一个跑得很久的编码任务不应该把你钉在办公桌前。掏出手机随时随地把会话接上：等咖啡时批一个权限请求、通勤路上排队三条新 prompt、笔记本盖着也能看最后一次 build 跑完。

所有执行仍在本机。你的 API 用量、`~/.claude/` 配置、`CLAUDE.md`、MCP 服务 —— 全部免费继承，因为 claudex 做的是把真实的 `claude` CLI 作为子进程拉起来。它是**驾驶员**，从不是 agent。

## 具体能给你什么

<table>
<tr><td width="50%">
🧠 <b>一个 agent，多条通路</b><br>
<sub>聊天记录、subagent 监控、队列、定时任务、diff 审阅 —— 全部通过一条 WebSocket 实时联动。</sub>
</td><td width="50%">
📱 <b>按 390px 手机优先设计</b><br>
<sub>桌面端是手机的自适应扩展，不是反过来。底部抽屉、safe-area 感知、iOS 键盘调优。</sub>
</td></tr>
<tr><td>
🔐 <b>认证没掉链子</b><br>
<sub>每次新会话都是用户名 + 密码 + TOTP。初始化时打印 10 个一次性恢复码。httpOnly JWT，限速。</sub>
</td><td>
🔍 <b>全文搜索覆盖一切</b><br>
<sub>SQLite FTS5 覆盖会话标题和每一条消息正文。⌘K 随时呼出。</sub>
</td></tr>
<tr><td>
🌿 <b>真 git worktree</b><br>
<sub>新会话在隔离 worktree 的独立分支里起步。创建时自动 rebase，归档时自动 prune。</sub>
</td><td>
🪞 <b>权限申请像样渲染</b><br>
<sub>不是一个弹窗糊脸 —— 专用卡片展示影响范围摘要、内联 diff 预览、跳转到全量 Review 页的深链。</sub>
</td></tr>
<tr><td>
🔁 <b>任意一轮分叉成分支</b><br>
<sub>任何事件点一下就能 fork 出去。探索另一条路径不污染原会话上下文。</sub>
</td><td>
📜 <b>诚实的流式</b><br>
<sub>Agent SDK 不暴露 delta 粒度，我们也不造假。思考期间三个跳动的点表明请求活着，回复整条落地。</sub>
</td></tr>
<tr><td>
🎬 <b>Routines（定时任务）</b><br>
<sub>cron 驱动的自动化轮次，完整的权限 + 项目信任门控。每天早上跑 lint，每晚出日报。</sub>
</td><td>
📚 <b>Queue（排队模式）</b><br>
<sub>一次批 3、5、10 条 prompt，让 claude 依次消化。可编辑顺序、暂停、取消。</sub>
</td></tr>
<tr><td>
🕳️ <b>/btw 侧边问</b><br>
<sub>不打扰主上下文问一个快问快答。回复在抽屉里流式回来；主会话永不看见。</sub>
</td><td>
🖥️ <b>内置终端</b><br>
<sub>node-pty + xterm.js 直接在 Web UI 里。真 shell，真 vim，真环境。移动端有 Esc / Ctrl / 方向键栏。</sub>
</td></tr>
<tr><td>
🏷️ <b>标签、置顶、筛选、视图模式</b><br>
<sub>怎么想就怎么组织会话。三种视图：normal、verbose（含 thinking 块）、summary（仅用户消息 + 最终回复 + 变更卡）。</sub>
</td><td>
📊 <b>用量与提醒</b><br>
<sub>每会话 token 圈、全局用量面板（按模型分组）、实时 Alerts 标签（"需要你确认"、"出错了"、"你走开时完成了"）。</sub>
</td></tr>
</table>

## 安装

**前置：** Node 20+、pnpm 9+、`claude` CLI 已安装并登录。

```sh
git clone https://github.com/ahaostudy/claudex.git
cd claudex
pnpm install
pnpm init --username=you --password='set-a-strong-one'
```

首次 init 会打印你的 TOTP 密钥（二维码 + 手输字符串）和 **10 个恢复码 —— 只显示一次，之后再也看不到**。请保存。把二维码扫进任意 TOTP 应用（1Password / Authy / Aegis / Google Authenticator 均可）。

## 运行

```sh
pnpm serve        # 构建 Web bundle + 启动服务，监听 127.0.0.1:5179
```

然后打开 `http://127.0.0.1:5179`。本地到此为止。

**远程访问** —— claudex 故意只绑 `127.0.0.1`。请在前面套你自己的隧道：

```sh
# 示例：Cloudflare Tunnel
cloudflared tunnel --url http://127.0.0.1:5179
# 或者 frp、Tailscale Funnel、Caddy 反向代理等
```

## 运维命令

```sh
pnpm claudex:status           # 只读诊断快照（会话、队列、推送设备、服务状态）
pnpm reset-credentials        # 轮换用户名 / 密码，保留 TOTP
pnpm -r typecheck             # shared + server + web
pnpm --filter @claudex/server test
```

运行时状态全在 `~/.claudex/`（SQLite、日志、JWT 密钥）。`~/.claude/` 归 CLI 所有，claudex 不往里写。

## 设计原则

- **不重造 Claude。** 拉起 CLI，所有配置免费继承。
- **拒绝绑 `0.0.0.0`。** 公网暴露由用户自己负责。
- **没有开发模式后门。** 首次启动起认证就是必须的。
- **移动优先，不是移动兼顾。** 每个屏幕先按 390px 设计。
- **诚实 > 聪明。** 不伪造流式、不编造进度条、不上报遥测、不埋分析。

## 状态

claudex 处于活跃开发中，接近个人用 MVP。公开的特性台账在 [`docs/FEATURES.md`](docs/FEATURES.md)，是唯一的事实来源 —— 任何行为变化都与同一次 commit 同步更新。服务端 500+ 测试，三个包 typecheck 零 warning。

## License

MIT。与 Anthropic 无关联。

---

<div align="center">
  <sub><a href="./README.md">English</a> · <b>中文</b></sub>
  <br><br>
  <sub>做这个是因为在「批准哪个 diff」这种事上，手机比笔记本快得多。</sub>
</div>

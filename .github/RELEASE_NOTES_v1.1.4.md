## LinkSwift for Chrome v1.1.4

把 [hmjz100/LinkSwift](https://github.com/hmjz100/LinkSwift) 这个油猴脚本适配成**原生 Chrome 扩展（Manifest V3）**，不需要安装 Tampermonkey / 暴力猴 / 脚本猫。

---

## 安装

### 方式一：加载已解压的扩展（推荐）

1. 下载下方 **`LinkSwift-Chrome-v1.1.4.zip`**
2. 解压到任意目录
3. 打开 Chrome → 地址栏输入 `chrome://extensions/`
4. 右上角开启「**开发者模式**」
5. 点击「**加载已解压的扩展程序**」，选择解压后的目录
6. 打开任一支持的网盘页面，即可看到「下载助手」按钮

### 方式二：从源码加载

```bash
git clone https://github.com/ollpou/LinkSwift_-.git
```

然后用方式一加载仓库根目录（无需构建，产物已随仓库提供）。

---

## 支持的网盘

百度网盘 / 阿里云盘 / 中国移动云盘 / 天翼云盘 / 迅雷云盘 / 光鸭云盘 / 夸克网盘 / UC网盘 / 123云盘

---

## 技术要点

### 双 world 桥接架构

上游脚本重度依赖 `unsafeWindow`（19 处）读取页面内部 JS 变量（百度的 `locals`、夸克的 `factStat` 等），这些只存在于 MAIN world；但 MV3 的 `world: "MAIN"` 内容脚本拿不到任何 `chrome.*` API。因此：

```
MAIN world（页面上下文）
  prelude.js  → 捕获 jQuery/Swal/md5 私有引用，让出全局名
  gm-shim.js  → GM_* API 兼容层
  linkswift.main.js → 上游脚本（逻辑未改）
        ↕ window.postMessage
ISOLATED world（扩展上下文）
  bridge.js → 存储 / 剪贴板 / 跨域 / 资源
        ↕ chrome.runtime port
background.js → 跨域 fetch 代理 + sender 白名单
```

### 关键修复

- **同步存储语义**：`GM_getValue` 是同步调用，启动前全量预取到 `Map`，写入异步落盘
- **跨域流式进度**：bridge↔background 经 port 长连接，`getReader()` 分块转发（100ms 节流），下载进度/速度/ETA 正常
- **abort 贯通**：取消下载时断开 port，background 的 `AbortController` 随之中止（不会"取消后仍后台重下"）
- **库隔离**：构建时把上游 35 处裸 `Swal`、5 处裸 `md5` 改私有引用，避免被页面自身版本覆盖
- **CSP 兜底**：上游末尾的 `new Function` 包 try/catch，防止严格 CSP 站点整个脚本中断

### 安全边界

> **postMessage 通道与页面脚本同权，这是 MAIN world 的固有限制。**

唯一可信的特权边界在 **background 的 `sender.origin` 白名单**：所有来自内容脚本的消息（fetch 代理 / openTab / syncMenus）都校验来源命中上游 `@match` 的网盘域名，任意其它网站的消息一律拒答。`content_scripts` 的 matches 也收敛到同样的域名清单（不再 `<all_urls>`），非网盘页面完全不注入。

残余风险：网盘页面自身的 XSS / 第三方脚本仍可能触达本层——这与 Tampermonkey 等脚本管理器的信任模型一致。

---

## 验证

| 测试 | 项数 | 结果 |
|---|---|---|
| `scripts/verify.cjs` 静态验证 | 45 | ✅ 全部通过 |
| `scripts/real-test.cjs` 实机测试 | 21 | ✅ 全部通过 |

实机测试（Playwright Chromium + CDP）覆盖：扩展加载、**非网盘页不注入**、GM_* 挂载、存储往返 + 持久化、同源/跨域请求、abort 语义、百度与夸克网盘页面无异常。

![实机运行截图](https://raw.githubusercontent.com/ollpou/LinkSwift_-/main/docs/screenshot-quark.png)

CI（GitHub Actions）每次 push 会跑静态验证 + 构建一致性检查 + 打包，每周一定时跑一次以验证上游更新后构建仍能跟上。

---

## 构建

```bash
# 克隆上游到【同级】目录（目录名必须是 LinkSwift）
git clone --depth 1 --branch dev https://github.com/hmjz100/LinkSwift.git ../LinkSwift

npm i -D playwright-core          # 仅测试用
node scripts/fetch-vendor.cjs     # 下载第三方库（含 sweetalert2 head 时序补丁）
node scripts/gen-icons.cjs        # 生成图标
node scripts/build.cjs            # 从上游生成主脚本 + meta + manifest
```

`build.cjs` 是 **fail-fast** 的：上游任何结构变化导致正则失配时直接报错退出，绝不静默产出坏产物。

---

## 许可证与声明

- **AGPL-3.0-or-later**（与上游一致）
- **非官方项目**：上游只发布 userscript，本扩展是第三方适配
- 上游作者：[hmjz100](https://github.com/hmjz100)、油小猴（原作者）
- 本项目**不破解限速**：下载速度取决于你自己账号的权限，非会员仍会被限速
- 所获取的下载链接均基于各大网盘服务商公开的 API 接口

按 AGPL 要求：修改并分发本扩展必须同样以 AGPL 开源并提供完整源码。

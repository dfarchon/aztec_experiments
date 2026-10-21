# DFArchon Billboard

独立的链上公共留言板。任何 Aztec 账号都可以发帖，不要求加入 Dark Forest，
不要求质押或存款。所有人无需连接钱包即可阅读；是否折叠某条内容由读者自己决定。

本文取代原网页「设计与测试」。合约与公开状态是事实来源；界面完成度不代表
生产部署、费用预算或匿名性审计已经完成。

## 产品界面

React 18 + TypeScript + Vite + React Router。视觉沿用 DFArchon 的黑色、
樱花粉、Fira Sans 与细边框，参考 Onchain Reality 和 DF Aztec Bridge。

| 入口 | 用途 |
| --- | --- |
| `/` 留言广场 | 匿名发帖、读取公开留言、搜索已读取内容、按新旧排序、分批展示、展开折叠内容 |
| `/?view=settings` 阅读偏好 | 用户关键词、基础规则、本地 AI 三个独立开关 |
| `/?view=activity` 发布记录 | 本浏览器保存的 L2 → L1 副本任务与 MetaMask 提交进度 |
| 右上角钱包 | MetaMask、Azguard 或浏览器 Aztec 账号；共用同一个留言板与发言框，可用 Switch wallet 切换 |
| 连接详情 | RPC、留言板、Sponsored FPC 地址及运行记录 |

旧 `/reports`、`/df-billboard-report.html` 跳转到主页；`/df-billboard-test.html`
也保留兼容跳转。旧 `/l1-post-lab`、`/fee-lab` 现在也跳回主页。
设计与测试不再作为产品页面加载，README 可从页脚访问。

广场只搜索当前已读取的留言；开启过滤时，折叠内容默认不参与文本搜索，
选择「查看已折叠内容」后才参与。留言没有作者昵称或可靠的发布时间字段，
界面只显示匿名身份和链上帖子 ID，不伪造头像身份、活跃用户或发布时间。
列表分批展示是客户端分页；当前链上读取仍为全量快照，规模化索引尚未实现。

## 合约与发帖流程

实现：`contract/src/main.nr`、`test/src/lib.nr`。

1. 客户端连接 Aztec 钱包并注册留言板及 Sponsored FPC。
2. `post(text, length)` 私有调用验证正文和账号发帖历史。
3. 验证通过后，排队执行仅合约自身可调用的 `_publish`。
4. `_publish` 分配帖子 ID，并公开保存正文和长度。
5. 读者通过 `get_post_count` / `get_post`，或同一区块的公开存储快照读取消息。

| 约束 | 行为 |
| --- | --- |
| 频道 | 由网络和留言板合约地址区分，不绑定 DF 赛季或玩家合约 |
| 资格 | 任意 Aztec 账号；无 DF 玩家证明、人工领取或质押 |
| 配额 | 同一账号在滚动 86,400 秒内最多 10 条，依据 Aztec 锚定区块时间 |
| 历史 | 私有 note 保存发帖历史；初始化 nullifier 防止丢弃历史重置配额 |
| 正文 | 客户端要求 1–512 字节有效 UTF-8；合约检查长度和补零，打包为 17 个 Field |
| 可见性 | 正文公开上链；公开帖子不存作者地址 |
| 费用 | 主流程使用 Sponsored FPC 支付 L2 gas；不足时停止，不自动转成用户支付 |

直接调用合约时，UTF-8 有效性仍依赖客户端；读取端遇到无效编码会跳过内容展示。
每账号配额不等于每人配额。公开记录不存作者地址也不等于网络元数据无法关联。

## Ethereum 副本与费用实验

### 已实现：L2 → L1 副本

`post_to_l1` 与普通发帖共享额度，发布正文并产生 L2 → L1 消息。
`portal/src/BillboardPublisher.sol` 验证 Aztec Outbox 消息来源、正文和一次性消费，
然后在 Ethereum 发布完整正文。

界面在「发布选项」开启副本后，记录任务：
等待证明 → 可提交 → MetaMask 签名 → L1 确认 → 成功。
用户自己支付 L1 gas，L1 提交地址公开。失败时继续原任务，不重新发送 L2 帖子。
这不是从 L1 发起的匿名发帖。

### 已验证的本地实验：MetaMask 按帖支付 gas

主页 Connect wallet 选择 MetaMask，与 Aztec 钱包使用同一份部署及公开留言：

1. 浏览器随机创建 Aztec 账号；不从 MetaMask 签名派生账号密钥。
2. MetaMask 调用 `BillboardInbox.requestPost`，转账金额为零，仅支付 L1 gas。
3. 标准 Aztec Inbox 传递加盐承诺和秘密哈希，不传正文或 Aztec 账号明文。
4. `post_from_l1` 私有调用验证固定 L1 合约来源、正文和账号绑定，并消费一次性消息。
5. 共用 Sponsored FPC 支付 L2 gas，沿用每账号 10 条 / 24 小时配额，公开保存正文。

无需充值、质押或兑换费用资产。进度使用主页 toast，待处理请求在发言框提供
Resume / Recover，交易记录在 Activity 查看。切换钱包不会删除账号或待处理请求。
MetaMask 模式不会再额外开启 L2 → L1 副本，避免混淆两种付费路径。
普通 `post` 和 `post_to_l1` 仍开放，L1 付款不是所有入口的强制门槛。
消息验证和发帖原子执行，失败不消耗授权；已提交交易保存哈希并支持核对恢复，
不自动重复支付 L1 gas。未知交易结果需先核对，不能盲目重发。

新 `deploy:df:harness` 同时部署 L1 Inbox、带 Inbox 初始化参数的 Aztec 留言板和
L1 Publisher。旧 L2-only 留言板不能修改初始化配置，仍可用 Aztec 钱包；
MetaMask 入口会禁用。重新部署会创建新留言板而非删除旧链上数据，
旧独立实验的恢复数据也不删除，但不会混入新留言板。切换部署前备份旧清单和账号。

L1 付款地址公开；正文最终在 Aztec L2，而非原生 L1 发帖。样本中未发现被检查的
付款地址、Aztec 账号和凭证明文出现在公开 L2 交易中，但时间、RPC/IP 等仍可能关联。
本地链使用 synthetic 证明，测试密钥未加密保存；这些检查不构成匿名性或生产安全证明。

## 阅读过滤

三个开关默认关闭、互相独立；任一启用的过滤器命中时折叠内容，
读者仍可展开原文。不删除链上消息、不扣额度、不引入有权处罚用户的审核员。

| 过滤器 | 实现与边界 |
| --- | --- |
| 用户关键词 | 最多 200 个字面词或短语；忽略大小写和全半角差异，可选英文整词匹配。不支持正则，引用或劝阻也可能命中 |
| 基础规则 | `linkifyjs` 提取链接，结合本地上下文规则识别推广、钱包凭证索取、代币领取链接、成人招揽和完全重复的外部招揽 |
| 本地 AI | Transformers.js Worker + Content Safety Guard Small；首次下载约 268 MB 权重、34 MB 分词器及运行库，须用户确认 |

AI 待处理或不可用时保持原文可见；下载错误可重试，也可以关闭并清理模型缓存。
AI 和规则均可能误判、漏判，不是通用的「非法内容」判定器。重复消息合并保留原条目，
可逐条展开。过滤设置只保存在当前浏览器，原文仍可被其他客户端读取。

## 固定样本测试结果

以下为从原设计页迁移的固定诊断结果：共 144 条人工编写中英文样本，
原始集 96 条＋新增集 48 条，另有 22 组重复文本对照。
基础规则统计使用迁移时的代码；AI 使用 **2026-10-14 12:03（Asia/Shanghai）**
记录，迁移网页没有重新运行模型。这些数值不代表真实流量准确率。

| 样本类别 | 总数 | 示例关键词折叠 | 基础规则折叠 | 历史 AI 折叠 |
| --- | ---: | ---: | ---: | ---: |
| 正常聊天／讨论 | 56 | 8 | 0 | 5 |
| 广告／变体引流 | 48 | 11 | 42 | 0 |
| 辱骂／现实威胁 | 24 | 0 | 0 | 23 |
| 边界待定 | 16 | 2 | 0 | 0 |

关键词示例为 `代练`、`微信`、`boosting`、`VPN`，不代表用户的默认词表。
同一条可以命中多列，不能直接相加。基础规则折叠中文广告 22/24、英文广告 20/24；
仍漏掉 6 条广告。AI 在正常样本上误折叠 5/56，风险样本漏折叠 1/24。
成人招揽、凭证索取等类别的样本数量不足，不能从此表推断它们的生产效果。

模型：`Horizon-Labs/content-safety-guard-small`；
revision：`6152f768a82207aab4ae7305b9df235a4a5163d9`；
阈值：`unsafe >= 0.5`。

原始研究资料位于仓库外 `../docs`，或通过 `DF_REPORT_DOCS_DIR` 指定：

| 输入 | SHA-256 |
| --- | --- |
| `moderation-evaluation-2026-10-13/samples.json` | `1dc6dd32216ea94e578b4dadbed4c018a4a63f5abd9df444ac9b4462b7aa7cff` |
| `moderation-evaluation-v3/holdout.json` | `9b88ad152b4238ffec16ac95410709e32969b1ae63dc2ad0b547373f4f6493c0` |
| `moderation-model-comparison-2026-10-14/horizon-browser-results.json` | `7ea8a48e038674bdd0db28e236bebf4b29ce591930b6b277572deef0a936d2aa` |
| `moderation-model-comparison-2026-10-14/horizon-results.json` | `01afd210207556fb717fd2d25cc6b3e9cef1504eaf362fe449fda7de7222bceb` |

运行 `npm run report:df:reading` 可生成 `.local/reading-report/df-test-report.json`，
包含逐条文本、判定、模型来源和来源哈希。该命令重新计算规则，复用历史 AI 判定。
缺少研究资料时明确返回不可用，不填充虚构的零错误结果，也不阻断产品构建。

## 本地开发

在仓库根目录执行，使用 Node `24.12.0`、Aztec `6.0.0-rc.3`、Noir `1.0.0-rc.3`。
SDK 使用 `@aztec-labs`；配套证明库、Noir WASM 和 L1 artifacts 使用 SDK 要求的
`@aztec-foundation` `6.0.0-rc.6`，不是把所有包强行设成同一个版本。以下命令连接本地测试环境；
本地脚本不能直接用于公开测试网。

```sh
npm ci
npm run build:sdk
npm run build:df
npm run build:df:l1
# 终端 1：启动本地链
npm run start:local:df
# 终端 2：部署独立留言板及前端配置
npm run deploy:df:harness
npm run dev:df:site
```

前端默认 `http://127.0.0.1:5001/`。MetaMask 必须在装有扩展的浏览器中使用。
本地部署不会要求真实 ETH；公开网络部署需要单独配置版本、赞助资金和部署地址。
不要为了更新样式重新部署合约或重置本地链。

`npm run check:testnet` 只读检查公共测试网版本、Sepolia 链 ID、真实证明模式及
规范 Sponsored FPC 余额，不部署、不付款。默认检查 `https://aztec-testnet.drpc.org`，
可通过 `AZTEC_TESTNET_URL` 指定 HTTPS 节点；版本不匹配时停止。余额非零不代表已获得代付许可。
版本升级不会迁移旧链数据，必须重新编译并为新网络部署。

若要与旧本地链并行运行，可分别设置启动时的 `ANVIL_PORT`、`L2_PORT`、`ADMIN_PORT`，
以及部署时的 `DF_NODE_URL`、`DF_L1_RPC_URL`。部署会更新本地清单和页面运行产物，
切换前应备份；不会停止旧节点。

## 测试与构建

```sh
npm run format:check:df:site
npm run typecheck:df:site
npm run test:df:ui
npm run test:df:moderation
npm run test:df:message
npm run test:df
npm run test:df:l1
npm run build:df:harness
```

- Noir：无需注册直接发帖、10/11 条配额、滚动时间边界、防重置、长度和补零、
  禁止外部调用 `_publish`、账号和留言板额度隔离。
- Solidity：Outbox 来源及正文验证、重复消费，Inbox 零金额请求及字段校验。
- React/controller：未连接状态、错误保留、正文转义、三个过滤器、折叠恢复及 L1 状态。
- 消息与过滤：UTF-8 边界、关键词、基础规则和报告数据完整性。

已有本地端到端测试命令（要求节点和对应部署就绪）：

```sh
npm run test:df:e2e
npm run test:df:l1:e2e
# MetaMask 请求与普通发帖使用 deploy:df:harness 的同一个留言板
npm run test:df:l1-request
npm run test:df:l1-post-lab:e2e
```

费用路径公开字段检查并非正式安全审计。本地 synthetic 测试也不能替代公共网络
真实证明验证。测试统计应以命令实际输出为准，不把历史通过记录当作本次执行。

## 发布前仍需完成

- 工具链已对齐公共测试网 `6.0.0-rc.3`；仍需公共网部署配置、前端真实证明模式和链上验收，
  不能直接解除本地脚本的安全限制使用公开测试网。
- 落实 Sponsored FPC 的资金、预算和调用限制，防止开放账号消耗全部代付资金。
- 验收主页 MetaMask 钱包真实交互，进一步完善链重组处理。
- 改进账号密钥保存与恢复；当前浏览器账号是本地测试存储，不适合承载真实资产。
- 扩大中英文独立测试集、验证真实网络隐私边界，以及大规模消息读取性能。

参考：[Onchain Reality](https://onchainreality.xyz/) ·
[DF Aztec Bridge](https://github.com/dfarchon/df-aztec-bridge) ·
[Aztec 网络说明](https://docs.aztec.network/networks)。

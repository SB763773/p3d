# p3d · 图片生成 3D 场景

丢一张图进去，几十秒后拿到一个能在浏览器里转着看、能摆进场景、能下载走的 3D 模型。

> **当前状态：M0–M5 完成，已有两条能真生成的后端**
> 默认 `mock` 不生成真实内容（按图片哈希返回一个预置 GLB）。要真生成二选一：
> `npm run dev:local`（本机显卡跑 TripoSR，**不需要任何账号**）或
> `P3D_PROVIDER=hunyuan`（腾讯混元生 3D，需要实名账号与密钥）。
>
> 生成结果是 AI 推测的草稿，不保证还原真实物体的尺寸、结构与细节，不得用于工程、医疗、安全相关用途。

## 快速开始

```bash
npm install
npm run dev          # 同时起 API(8787) 与前端(5173)，打开 http://127.0.0.1:5173
```

打开后点「没有图？用示例图」，就能走完预处理 → 生成 → 3D 查看 → 下载的整条链路。

## 两种界面模式

右上角一键切换，选择记在本机，刷新后保持。

| 模式             | 有什么                                                                          | 适合                     |
| ---------------- | ------------------------------------------------------------------------------- | ------------------------ |
| **简单**（默认） | 选图 → 选档位 → 生成 → 下载。场景里永远只有一个模型，新生成的直接替换旧的       | 只想把一张图变成模型拿走 |
| **完整**         | 上面全部 + 场景对象列表、移动/旋转/缩放 gizmo、网格、线框、PBR 与面数、历史记录 | 要在一个场景里摆多个模型 |

简单模式不是另一套代码，只是把进阶控件收起来 —— 切到完整随时能拿回来。

## 怎么摆（完整模式）

- 点模型（或侧栏「场景对象」里的那一行）选中，脚下出现光圈
- 右上角「移动 / 旋转 / 缩放」切换 gizmo，再点一次同一项就收起、回到纯观察
- 快捷键：`G` 移动、`R` 旋转、`S` 缩放、`Delete` 删除选中、`Esc` 取消选中
- 「再加一个」= 同一个模型再摆一份，自动落到旁边的空位
- 场景状态存在本机 localStorage，刷新还在

## 校验门

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # biome check
npm run test         # vitest run（133 个单测，纯函数为主）
npm run build        # vite build
npm run smoke        # 自动起 preview → 用系统 Edge 跑 mock 全链路 → 自动关掉（需先 npm run build）
```

`npm run gate` 串起前四道；`npm run gate:all` 再加上冒烟。
冒烟测试用系统 Edge（`channel: 'msedge'`），不下载 Playwright 自带浏览器。

> 手动起 `vite preview` 时注意：它在启动时就把 `dist` 扫进了内存索引，
> 之后重新 build 会导致新 chunk 404（页面卡在骨架屏）。要么重启 preview，要么直接用 `npm run smoke`。

## 服务端（/api）

密钥和额度都收在这里，浏览器永远看不到。

```bash
npm run api          # 只起 API：http://127.0.0.1:8787
```

| 接口                | 说明                                                    |
| ------------------- | ------------------------------------------------------- |
| `GET /api/health`   | 存活 + 当前闸门状态（今日已花、剩余额度）               |
| `POST /api/jobs`    | 提交；先过闸门（限流 / 日预算 / 单次上限 / 熔断）再落库 |
| `GET /api/jobs/:id` | 轮询；完成时带回 GLB 地址与结算成本                     |

任务写在 `.data/jobs.json`（原子写入：临时文件 + rename）。
`server/handler.ts` 只写 Web 标准的 `Request → Response`，不 import 任何 `node:*`——
以后要挪进 Cloudflare Pages Functions，业务逻辑一行不用改。

## 目录

```
server/                          BFF：闸门、存储、路由、provider（mock / hunyuan / local）
local-engine/                    本地推理：TripoSR 跑在本机显卡上（Python + FastAPI）
src/
├── app/App.tsx                 页面装配
├── features/upload/            上传 + 预处理（含内置示例图入口）
├── features/job/               任务进度 / 结果 / 历史
├── features/viewer/            R3F 画布、光照、模型、工具栏、场景对象列表、快捷键
├── lib/
│   ├── providers/              Provider 抽象 + http / mock（真实后端加在这里）
│   ├── imagePreprocess.ts      校验 / 缩放 / 去背景 / 裁切 / 哈希
│   ├── normalizeModel.ts       最长边归一化 + 底面贴地
│   ├── fitCamera.ts            自动取景距离计算
│   ├── sceneLayout.ts          摆放空位、等比缩放收敛、变换读回
│   ├── jobMachine.ts           任务状态机 + 进度区间映射
│   └── deviceTier.ts           设备分级与渲染降级
├── store/                      zustand：任务态 / 场景态
└── tests/                      单测在 tests/unit，冒烟在 tests/e2e
```

## 接真实后端（M2）

`server/providers/hunyuan.ts` 已经写好了（TC3 签名、提交、查询、档位映射、错误分类），
**只差密钥**：

```bash
export TENCENTCLOUD_SECRET_ID=...
export TENCENTCLOUD_SECRET_KEY=...
P3D_PROVIDER=hunyuan npm run api
```

没配密钥时不会假装能跑——会退回 mock，并在 `/api/health` 的 `providerReport.reason` 里说明原因。
前端不需要任何改动，它只跟 `/api` 说话。

| 档位     | 上游                | 积分 | 约合 |
| -------- | ------------------- | ---- | ---- |
| draft    | 极速版图生 3D       | 15   | ¥1.5 |
| standard | 专业版 Normal       | 20   | ¥2.0 |
| high     | 专业版 Normal + PBR | 30   | ¥3.0 |

其他环境变量：`P3D_POINT_YUAN`（积分单价，后付费填 0.12）、`P3D_REGION`、`P3D_ENDPOINT`。

## 本地引擎（不需要账号、不需要密钥）

云端那条路要求腾讯云实名认证。走不通的话用这个：**TripoSR 直接跑在本机显卡上**，
模型开源（MIT）、离线、不限次、零成本。

```bash
npm run engine:setup    # 一次性：装 Python 依赖 + 下 1.56 GB 权重（约 4.4 GB 下载）
npm run engine          # 终端 A：起推理引擎 → 127.0.0.1:8188，加载约 30 秒
npm run dev:local       # 终端 B：起 api + 前端，provider=local
```

| 项   | 说明                                                                              |
| ---- | --------------------------------------------------------------------------------- |
| 硬件 | NVIDIA 显卡 ≥6 GB 显存。RTX 50 系（sm_120）必须 CUDA 12.8 的 torch，脚本已固定    |
| 耗时 | 单张 8–20 秒（本机 RTX 5060 实测）                                                |
| 成本 | 0 元，所以 `provider=local` 时闸门的配额与预算自动放宽                            |
| 质量 | 与云端是同一个模型家族的量级，但没有"极速版/专业版"之分，`quality` 档位只影响显示 |
| 细节 | 见 [`local-engine/README.md`](local-engine/README.md)（含完整排障表）             |

前端完全不知道后端换了 —— 它只跟 `/api` 说话，`local` 和 `hunyuan` 在 `/api/health`
的 `providerReport` 里区分。想切回云端，只改 `P3D_PROVIDER` 一个变量。

**密钥绝不能进前端包**（前端直连 = Key 泄露 = 余额被刷光）。

| 变量                | 取值                       | 说明                         |
| ------------------- | -------------------------- | ---------------------------- |
| `VITE_P3D_PROVIDER` | `mock` / `hunyuan` / `fal` | 默认 `mock`                  |
| `P3D_BASE_URL`      | 冒烟测试用                 | 默认 `http://127.0.0.1:4173` |

## 两个实现选择与方案文档不同

- **去背景**用自研的边缘种子泛洪（纯 Canvas，零依赖零下载），没有引 `@imgly/background-removal`。
  原因：那套要首次下载约 40 MB 权重，国内网络经常卡住，失败体验很差。
  泛洪方案对纯色背景产品图效果一样好，且失败时会保护性放弃、不改动原图。
- **自动取景**用 `lib/fitCamera.ts` 自己算距离，没用 drei 的 `<Bounds fit>`。
  原因：模型走 Suspense 异步加载，`Bounds` 在挂载那一刻量的是空盒子，最终取景严重偏小。
- **gizmo 拖拽结束才写 store**：`onObjectChange` 每帧触发，逐帧 persist 会把 localStorage 打爆；
  拖拽期间由 three 直接改对象，`onMouseUp` 再读回落库（`readTransform`）。
- **`?debug=1` 时才暴露调试接口**（gizmo 的 axis / dragging）。它的存在只是为了让自动化能
  确定地验证拖拽 —— 盲点坐标点偏了会变成旋转相机，搜索会自我失效。生产 URL 不带该参数时完全惰性。

详见 `docs/ITERATION.md`。

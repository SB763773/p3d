# 本地推理引擎

TripoSR 直接跑在本机显卡上。**不需要任何账号、任何实名认证、任何密钥**，生成一次的电费忽略不计。

这是为"拿不到腾讯云密钥"这种情况准备的备用后端。它和云端方案并列，不是降级方案 ——
模型一样，输出一样是 GLB，只是算力从别人的机房换成了你自己的显卡。

---

## 为什么不是"再找个免费 API"

免费的 3D 生成 API 只有两类：

| 类型 | 例子 | 为什么不行 |
| --- | --- | --- |
| 国内云厂商 | 混元生 3D、阿里、百度 | 全部要求实名认证，个人认证一般要求满 16 周岁 |
| 海外平台 | fal.ai、Replicate、Meshy | 全部要求国际信用卡；Tripo/Meshy 的免费档还禁止商用 |

而单图转 3D 的模型本身是**开源且许可宽松**的 —— TripoSR 是 **MIT**。
既然模型免费、显卡在手，那就不必绕道任何平台。

---

## 硬件要求

| 项 | 最低 | 本机实测 |
| --- | --- | --- |
| 显卡 | NVIDIA，6 GB 显存 | RTX 5060 Laptop 8 GB（sm_120） |
| 内存 | 16 GB | 15.7 GB |
| 磁盘 | 6 GB 空闲 | 充足 |

**RTX 50 系（Blackwell / sm_120）必须用 CUDA 12.8+ 的 PyTorch 轮子**。
装成 cu126 或更老，会出现"能初始化但一算就炸"，报错是
`no kernel image is available for execution on the device`。

脚本里已经把 wheel 固定在 `cu128`，不要自己改成"最新版"就好。

---

## 安装

```bash
npm run engine:setup
```

它做四件事，可重复执行（已完成的会跳过）：

1. 找系统 Python（3.11 / 3.12），建 `local-engine/.venv`
2. 装 PyTorch `cu128`（约 2.87 GB）
3. 装其余依赖（transformers / trimesh / pymcubes / fastapi…）
4. 下模型权重 `model.ckpt`（1.56 GB）与 `config.yaml`，然后跑自检

> **网络提示**：单连接下载只有 0.4 MB/s 左右，但并行分段能到 3 MB/s。
> 脚本里 torch 是从阿里云 `pytorch-wheels/cu128` 镜像拿的，权重走 `hf-mirror.com`。
> 如果中途断了，重跑同一条命令即可续传。

单独自检：

```bash
npm run engine:check              # 全检（含加载 1.56 GB 模型，约 40 秒）
local-engine/.venv/Scripts/python.exe local-engine/selfcheck.py --quick   # 3 秒版
```

---

## 启动

```bash
npm run engine        # 只起引擎 → http://127.0.0.1:8188
npm run dev:local     # 另开终端：起 api + 前端，且 provider=local
```

首次启动要加载 1.56 GB 权重，约 30 秒。看到 `[engine] 就绪` 再提交任务，
否则前端会收到"引擎加载中"。`GET /v1/health` 随时可以查状态。

单张图生成耗时：**约 8–20 秒**（含 256³ marching cubes）。
质量档位在本地模式下不改变结果 —— 本地没有"极速版/专业版"之分，
`quality` 只影响前端显示的成本估算（本地一律记 0 元）。

---

## 接口

刻意做得很薄，只负责「图片进 → GLB 出」。限流、去重、预算、任务持久化都还在 node BFF 那边，
那些是产品规则，不该因为换了个推理后端就重写一遍。

```
GET    /v1/health          模型与显存状态
POST   /v1/jobs            { image: base64 } → { id }
GET    /v1/jobs/{id}       { status, stage, progress, url, sizeBytes, faceCount, error }
GET    /v1/glb/{id}        下载 GLB
DELETE /v1/jobs/{id}       清理
```

任务串行执行。8 GB 卡没有余量跑两个并发任务，**排队比 OOM 崩溃体面**。

node 那边用 `server/providers/local.ts` 对接，把 `url` 交给 handler 转成
`/api/jobs/:id/model` —— 和混元那条路径完全一致，前端看不出区别。

---

## 和原版 TripoSR 的三处不同

| 改动 | 原因 |
| --- | --- |
| `torchmcubes` → `PyMCubes`（`tsr/models/_mcubes_compat.py`） | 前者要 CMake + MSVC 现场编译，Windows 装不上；后者 PyPI 有预编译包，接口一致 |
| `rembg` 改为函数内延迟导入 | 前端已完成去背景，正常路径不会走到。为用不到的分支装 200 MB 的 onnxruntime 不值得 |
| 只用顶点色，不烘焙纹理 | 烘焙要走 xatlas + moderngl（需要 OpenGL 上下文，无头服务里容易崩）。顶点色对"能转着看"够用，GLB 还小一半 |

`tsr/` 下其余代码是原仓库原样拷贝（MIT），只改了上面两处，都留了注释说明。

---

## 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `DLL load failed while importing _regex`（提示"应用程序控制策略已阻止此文件"） | Windows **Smart App Control** 拦了 `regex` 的 C 扩展 | 锁 `regex==2024.11.6` + `transformers<5`（脚本已如此配置）。新版 regex 装得上但加载不了 |
| `no kernel image is available` | torch 不是 cu128 | 重装：`npm run engine:setup` |
| `CUDA out of memory` | 显存被别的程序占了 | 关掉游戏、安卓模拟器、Wallpaper Engine。引擎会自动把 marching cubes 从 256 降到 160 重试，全失败才报错 |
| `连不上本地推理引擎` | 引擎没起 | 另开终端 `npm run engine` |
| 生成的模型是空的 | 图里没有清晰主体，或全透明 | 换一张主体居中、背景干净的图 |
| 模型糊成一团 | 主体占画面比例太小 | 前端裁切那步没生效；检查是不是跳过了去背景 |
| 启动卡在加载 | 权重没下全 | `npm run engine:check` 看 `model.ckpt` 是否 1.56 GB |
| 端口 8188 被占 | 上次没退干净 | `P3D_ENGINE_PORT=8189 npm run engine`，同时给 api 设 `P3D_ENGINE_URL` |

---

## 许可

- TripoSR 代码与权重：**MIT**（`stabilityai/TripoSR`）
- 本目录下的改动：与原项目一致

生成结果是 AI 推测的草稿，不保证还原真实物体的尺寸、结构与细节，不得用于工程、医疗、安全相关用途。

"""本地推理服务（FastAPI）。

职责边界：只做「图片进 → GLB 出」，不碰业务规则。
限流、预算、去重、任务持久化都还在 node BFF 那边 —— 那些是产品规则，
不该因为换了个推理后端就重写一遍。

所以这里的接口刻意做得很薄：

    GET    /v1/health          模型与显存状态
    POST   /v1/jobs            提交一张图，立刻返回 job_id
    GET    /v1/jobs/{id}       查状态，完成时给 glb 的 url
    GET    /v1/glb/{id}        下载 GLB
    DELETE /v1/jobs/{id}       取消/清理

任务串行执行。TripoSR 在 8 GB 卡上没有余量跑两个并发任务，
排队比 OOM 崩溃体面。
"""

from __future__ import annotations

import base64
import io
import queue
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from PIL import Image
from pydantic import BaseModel

from inference import OomError, TripoEngine, pick_device

ROOT = Path(__file__).parent
MODEL_DIR = ROOT / "models" / "TripoSR"
OUT_DIR = ROOT / "out"
KEEP_GLB = 40  # 只保留最近 N 个 GLB，避免磁盘无限长

MAX_IMAGE_BYTES = 16 * 1024 * 1024

# 阶段 → 进度。TripoSR 内部没有回调，进度只能是阶段性的。
# 不编造平滑曲线：停在 0.8 让用户知道"正在算网格"是诚实的。
STAGE_PROGRESS = {
    "queued": 0.05,
    "preparing": 0.12,
    "encoding": 0.38,
    "meshing": 0.80,
    "done": 1.0,
}

engine: TripoEngine | None = None
engine_error: str | None = None
jobs: dict[str, dict] = {}
tasks: "queue.Queue[str]" = queue.Queue()
lock = threading.Lock()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global engine, engine_error

    def load() -> None:
        global engine, engine_error
        try:
            device = pick_device()
            engine = TripoEngine(MODEL_DIR, device=device)
            print(f"[engine] 就绪 device={device} 用时 {engine.load_seconds}s", flush=True)
        except Exception as error:  # noqa: BLE001 - 启动失败要把原因留在 /health 里
            engine_error = f"{type(error).__name__}: {error}"
            print(f"[engine] 加载失败 {engine_error}", flush=True)

    threading.Thread(target=load, daemon=True).start()
    threading.Thread(target=_worker, daemon=True).start()
    yield


app = FastAPI(title="p3d local engine", lifespan=lifespan)


# ---------------------------------------------------------------- 任务队列


def _worker() -> None:
    while True:
        job_id = tasks.get()
        job = jobs.get(job_id)
        if job is None or job["status"] == "failed":
            continue
        try:
            _run_job(job_id, job)
        except Exception as error:  # noqa: BLE001 - 任何异常都要落到任务状态里
            torch_free()
            with lock:
                job.update(
                    status="failed",
                    stage="failed",
                    error=_explain(error),
                )


def _run_job(job_id: str, job: dict) -> None:
    # 引擎是后台线程加载的，任务可以先排队。但要设上限：
    # 加载卡死时不能让 worker 线程永久阻塞，否则整个队列都不动了。
    deadline = time.time() + 180
    while engine is None:
        if engine_error:
            raise RuntimeError(f"推理引擎没起来：{engine_error}")
        if time.time() > deadline:
            raise RuntimeError("推理引擎加载超过 180 秒，看看 npm run engine 那个终端在报什么")
        time.sleep(0.2)

    _set(job, "preparing", STAGE_PROGRESS["preparing"])
    image = _decode_image(job["image_base64"])

    _set(job, "encoding", STAGE_PROGRESS["encoding"])
    started = time.time()
    mesh = engine.generate(image)

    _set(job, "meshing", STAGE_PROGRESS["meshing"])
    path = OUT_DIR / f"{job_id}.glb"
    size = TripoEngine.export_glb(mesh, path)

    with lock:
        job.update(
            status="succeeded",
            stage="done",
            progress=1.0,
            sizeBytes=size,
            faceCount=int(mesh.faces.shape[0]),
            elapsedSeconds=round(time.time() - started, 2),
            url=f"/v1/glb/{job_id}",
        )
        job.pop("image_base64", None)  # 出图后就不再留原图
    _prune()


def _set(job: dict, stage: str, progress: float) -> None:
    with lock:
        job["stage"] = stage
        job["progress"] = progress
        job["updatedAt"] = time.time()


def _explain(error: Exception) -> dict:
    if isinstance(error, OomError):
        return {
            "code": "OUT_OF_MEMORY",
            "message": "显存不够了。关掉游戏/模拟器后重试，或把图换小一点。",
            "retryable": True,
        }
    if isinstance(error, MemoryError):
        return {"code": "OUT_OF_MEMORY", "message": "内存不足", "retryable": True}
    return {"code": "ENGINE_ERROR", "message": str(error), "retryable": True}


def _decode_image(raw: str) -> Image.Image:
    if raw.startswith("data:"):
        raw = raw.split(",", 1)[-1]
    try:
        payload = base64.b64decode(raw, validate=True)
    except Exception as error:  # noqa: BLE001
        raise ValueError(f"图片不是合法的 base64：{error}") from error
    if len(payload) > MAX_IMAGE_BYTES:
        raise ValueError("图片太大")
    return Image.open(io.BytesIO(payload)).convert("RGBA")


def torch_free() -> None:
    try:
        import torch

        torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def _prune() -> None:
    files = sorted(OUT_DIR.glob("*.glb"), key=lambda p: p.stat().st_mtime, reverse=True)
    for stale in files[KEEP_GLB:]:
        stale.unlink(missing_ok=True)
    alive = {p.stem for p in files[:KEEP_GLB]}
    with lock:
        for job_id in [k for k, v in jobs.items() if v["status"] == "succeeded"]:
            if job_id not in alive:
                jobs.pop(job_id, None)


# ---------------------------------------------------------------- 接口


class NewJob(BaseModel):
    image: str
    mimeType: str | None = None


@app.get("/v1/health")
def health() -> dict:
    info = {
        "ok": engine is not None,
        "error": engine_error,
        "queue": tasks.qsize(),
        "active": sum(1 for j in jobs.values() if j["status"] in ("queued", "running")),
    }
    if engine is not None:
        info.update(engine.describe())
    return info


@app.post("/v1/jobs")
def create_job(payload: NewJob) -> dict:
    if engine is None and engine_error:
        raise HTTPException(503, f"推理引擎不可用：{engine_error}")
    job_id = uuid.uuid4().hex[:16]
    jobs[job_id] = {
        "id": job_id,
        "status": "queued",
        "stage": "queued",
        "progress": STAGE_PROGRESS["queued"],
        "image_base64": payload.image,
        "error": None,
        "createdAt": time.time(),
        "updatedAt": time.time(),
    }
    tasks.put(job_id)
    return {"id": job_id, "status": "queued"}


@app.get("/v1/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "任务不存在或已被清理")
    view = {k: v for k, v in job.items() if k != "image_base64"}
    return view


@app.get("/v1/glb/{job_id}")
def get_glb(job_id: str) -> FileResponse:
    path = OUT_DIR / f"{job_id}.glb"
    if not path.exists():
        raise HTTPException(404, "GLB 不存在")
    return FileResponse(path, media_type="model/gltf-binary", filename=f"{job_id}.glb")


@app.delete("/v1/jobs/{job_id}")
def delete_job(job_id: str) -> dict:
    with lock:
        jobs.pop(job_id, None)
    (OUT_DIR / f"{job_id}.glb").unlink(missing_ok=True)
    return {"deleted": job_id}

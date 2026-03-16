from __future__ import annotations

import base64
import io
import uuid
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from PIL import Image

from app.processing import SpriteObject, image_to_png_bytes, remove_background, split_sprites


@dataclass
class SessionData:
    objects: dict[str, SpriteObject]


class ExportItem(BaseModel):
    id: str
    source_id: str | None = None
    image_data: str | None = None
    x: float = 0
    y: float = 0
    width: float = Field(gt=0)
    height: float = Field(gt=0)


class ExportRequest(BaseModel):
    session_id: str
    canvas_width: int = Field(gt=0)
    canvas_height: int = Field(gt=0)
    origin_x: int = 0
    origin_y: int = 0
    items: list[ExportItem]


app = FastAPI(title="spiriter", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=static_dir), name="static")

sessions: dict[str, SessionData] = {}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(static_dir / "index.html")


@app.post("/api/process")
async def process_image(
    file: UploadFile = File(...),
    tolerance: int = 48,
    min_area: int = 36,
) -> JSONResponse:
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="请上传图片文件")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="上传文件为空")

    tolerance = max(1, min(160, tolerance))
    min_area = max(1, min(5000, min_area))

    try:
        cleaned = remove_background(content, tolerance=tolerance)
        objs = split_sprites(cleaned, min_area=min_area)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"图像处理失败: {exc}") from exc

    if not objs:
        raise HTTPException(
            status_code=400,
            detail="未检测到可用角色对象，请提高容差或降低最小面积后重试",
        )

    max_objects = 240
    if len(objs) > max_objects:
        raise HTTPException(
            status_code=400,
            detail=(
                f"检测到 {len(objs)} 个对象，数量过多会导致页面卡顿。"
                "请提高最小对象面积或降低背景容差后重试。"
            ),
        )

    session_id = uuid.uuid4().hex
    sessions[session_id] = SessionData(objects={o.object_id: o for o in objs})

    payload_objects = []
    for obj in objs:
        png = image_to_png_bytes(obj.image)
        b64 = base64.b64encode(png).decode("ascii")
        x0, y0, x1, y1 = obj.bbox
        payload_objects.append(
            {
                "id": obj.object_id,
                "bbox": {"x0": x0, "y0": y0, "x1": x1, "y1": y1},
                "width": obj.image.width,
                "height": obj.image.height,
                "image_data": f"data:image/png;base64,{b64}",
            }
        )

    return JSONResponse(
        {
            "session_id": session_id,
            "object_count": len(payload_objects),
            "objects": payload_objects,
        }
    )


@app.post("/api/export")
def export_sheet(request: ExportRequest) -> JSONResponse:
    session = sessions.get(request.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在或已过期，请重新上传图片")

    canvas = Image.new("RGBA", (request.canvas_width, request.canvas_height), (0, 0, 0, 0))

    for item in request.items:
        if item.image_data:
            encoded = item.image_data.split(",", 1)[-1]
            sprite_image = Image.open(io.BytesIO(base64.b64decode(encoded))).convert("RGBA")
        else:
            sprite = session.objects.get(item.source_id or item.id)
            if not sprite:
                continue
            sprite_image = sprite.image

        resized = sprite_image.resize((int(item.width), int(item.height)), Image.Resampling.LANCZOS)
        dest_x = int(item.x) - request.origin_x
        dest_y = int(item.y) - request.origin_y
        canvas.paste(resized, (dest_x, dest_y), resized)

    out = io.BytesIO()
    canvas.save(out, format="PNG")
    b64 = base64.b64encode(out.getvalue()).decode("ascii")

    return JSONResponse({"image_data": f"data:image/png;base64,{b64}"})

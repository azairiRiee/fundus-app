from fastapi import APIRouter, UploadFile, File
from PIL import Image

router = APIRouter()


@router.post("/predict")
async def predict(file: UploadFile = File(...)):

    image = Image.open(file.file)

    return {
        "filename": file.filename,
        "format": image.format,
        "mode": image.mode,
        "width": image.width,
        "height": image.height
    }
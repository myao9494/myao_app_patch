import os

os.environ.setdefault("SEARCH_APP_LAUNCHER_AUTOSTART", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("VECLIB_MAXIMUM_THREADS", "1")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

try:
    import torch
    torch.set_num_threads(1)
except ImportError:
    pass

import uvicorn

from app.config import settings


if __name__ == "__main__":
    uvicorn.run("app.main:app", host=settings.bind_host, port=settings.bind_port, reload=False)

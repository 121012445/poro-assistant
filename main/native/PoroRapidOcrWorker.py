import base64
import logging
import sys

logging.disable(logging.CRITICAL)

from rapidocr import RapidOCR


def reply(status, value):
    payload = base64.b64encode(str(value).encode("utf-8")).decode("ascii")
    sys.stdout.write(f"{status}\t{payload}\n")
    sys.stdout.flush()


try:
    engine = RapidOCR()
except Exception as exc:
    sys.stderr.write(f"RAPID_OCR_START_FAILED {exc}\n")
    sys.stderr.flush()
    raise


for encoded_path in sys.stdin:
    encoded_path = encoded_path.strip()
    if not encoded_path:
        continue
    try:
        image_path = base64.b64decode(encoded_path).decode("utf-8")
        result = engine(image_path, use_cls=False, text_score=0.55)
        texts = tuple(getattr(result, "txts", ()) or ())
        reply("OK", "\n".join(str(text).strip() for text in texts if str(text).strip()))
    except Exception as exc:
        reply("ERR", exc)

"""Package the unpacked WebExtension into a reproducible, unsigned XPI."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "extension"


def build():
    out = ROOT / "dist" / "export-zip-unsigned.xpi"
    out.parent.mkdir(exist_ok=True)
    with ZipFile(out, "w") as archive:
        for file in sorted(SOURCE.rglob("*")):
            if file.is_file() and not any(part.startswith(".") for part in file.relative_to(SOURCE).parts):
                entry = ZipInfo(file.relative_to(SOURCE).as_posix(), (2026, 1, 1, 0, 0, 0))
                entry.external_attr = 0o100644 << 16
                archive.writestr(entry, file.read_bytes(), compress_type=ZIP_DEFLATED)
    print(out)


if __name__ == "__main__":
    build()

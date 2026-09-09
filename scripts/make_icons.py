# 从 resources/icon-source.jpg 生成应用图标：icon.png(256) + icon.ico(多尺寸)。
# 用法：D:/MiniConda3/envs/ai_env/python.exe scripts/make_icons.py（Pillow 跑在 ai_env）
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'resources' / 'icon-source.jpg'
OUT = ROOT / 'resources'

# Windows ico 常用尺寸链
ICO_SIZES = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]


def center_square(img: Image.Image) -> Image.Image:
    """非正方形图先居中裁方，避免图标被拉伸变形"""
    w, h = img.size
    side = min(w, h)
    left, top = (w - side) // 2, (h - side) // 2
    return img.crop((left, top, left + side, top + side))


def main() -> None:
    img = Image.open(SRC).convert('RGBA')
    img = center_square(img)
    base = img.resize((256, 256), Image.LANCZOS)

    base.save(OUT / 'icon.png')  # electron-builder 也能吃 png 自动转 ico
    base.save(OUT / 'icon.ico', sizes=ICO_SIZES)
    print('written:', OUT / 'icon.png', 'and', OUT / 'icon.ico')


if __name__ == '__main__':
    main()

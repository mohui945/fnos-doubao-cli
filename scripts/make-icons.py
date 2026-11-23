#!/usr/bin/env python3
"""生成豆包 CLI 的应用图标（256x256 与 64x64）。"""

from PIL import Image, ImageDraw, ImageFont

SIZE = 1024
FONT = "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"

# 与豆包品牌接近的蓝紫渐变
TOP = (61, 90, 254)
BOTTOM = (124, 77, 255)


def gradient(size):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        r = int(TOP[0] + (BOTTOM[0] - TOP[0]) * t)
        g = int(TOP[1] + (BOTTOM[1] - TOP[1]) * t)
        b = int(TOP[2] + (BOTTOM[2] - TOP[2]) * t)
        for x in range(size):
            px[x, y] = (r, g, b)
    return img


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


base = gradient(SIZE)
mask = rounded_mask(SIZE, int(SIZE * 0.235))

icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
icon.paste(base, (0, 0), mask)

draw = ImageDraw.Draw(icon)
font = ImageFont.truetype(FONT, int(SIZE * 0.56))

text = "豆"
box = draw.textbbox((0, 0), text, font=font)
tw, th = box[2] - box[0], box[3] - box[1]
tx = (SIZE - tw) / 2 - box[0]
ty = (SIZE - th) / 2 - box[1] - int(SIZE * 0.045)

# 柔和的投影，让字符在渐变上更立体
shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
ImageDraw.Draw(shadow).text((tx, ty + int(SIZE * 0.012)), text, font=font, fill=(20, 20, 60, 90))
from PIL import ImageFilter

icon = Image.alpha_composite(icon, shadow.filter(ImageFilter.GaussianBlur(int(SIZE * 0.018))))
draw = ImageDraw.Draw(icon)
draw.text((tx, ty), text, font=font, fill=(255, 255, 255, 255))

# 右下角不再叠加终端符号，保持图标在 64px 下也清晰

icon.putalpha(Image.composite(icon.getchannel("A"), Image.new("L", (SIZE, SIZE), 0), mask))

icon.resize((256, 256), Image.LANCZOS).save("ICON_256.PNG")
icon.resize((64, 64), Image.LANCZOS).save("ICON.PNG")
icon.resize((256, 256), Image.LANCZOS).save("app/ui/images/icon_256.png")
icon.resize((64, 64), Image.LANCZOS).save("app/ui/images/icon_64.png")
print("图标已生成")

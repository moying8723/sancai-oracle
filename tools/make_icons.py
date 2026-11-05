from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

OUT = "site/icons"
os.makedirs(OUT, exist_ok=True)
S = 1024
bg = Image.new("RGB", (S, S), "#07090f")
px = bg.load()

# soft radial gold glow
glow = Image.new("L", (S, S), 0)
gd = ImageDraw.Draw(glow)
for r in range(520, 0, -4):
    a = int(26 * (1 - r / 520) ** 1.6)
    gd.ellipse((S/2-r, S*0.42-r, S/2+r, S*0.42+r), fill=a)
glow = glow.filter(ImageFilter.GaussianBlur(26))
gold_layer = Image.new("RGB", (S, S), "#8a6428")
bg = Image.composite(gold_layer, bg, glow.point(lambda v: int(v*1.7)))

d = ImageDraw.Draw(bg, "RGBA")
cx, cy = S//2, S//2

# rings
d.ellipse((cx-392, cy-392, cx+392, cy+392), outline=(216,184,108,105), width=4)
d.ellipse((cx-352, cy-352, cx+352, cy+352), outline=(216,184,108,45), width=2)
d.ellipse((cx-306, cy-306, cx+306, cy+306), outline=(216,184,108,35), width=2)

# corner ticks
for sx, sy, ex, ey in [
    (cx-410, cy-150, cx-410, cy-260),
    (cx+410, cy-150, cx+410, cy-260),
    (cx-410, cy+150, cx-410, cy+260),
    (cx+410, cy+150, cx+410, cy+260),
]:
    d.line((sx, sy, ex, ey), fill=(216,184,108,115), width=3)

# central seal disc
d.ellipse((cx-270, cy-270, cx+270, cy+270), fill=(10,14,22,230), outline=(216,184,108,55), width=2)

# text mask
font = ImageFont.truetype(r"C:\Windows\Fonts\simkai.ttf", 430)
mask = Image.new("L", (S, S), 0)
md = ImageDraw.Draw(mask)
bbox = md.textbbox((0, 0), "天", font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
md.text(((S - tw)//2 - bbox[0], (S - th)//2 - bbox[1] - 10), "天", font=font, fill=255)

# vertical gold gradient for the character
grad = Image.new("RGB", (S, S))
gp = grad.load()
for y in range(S):
    t = y / S
    r = int(255 + (174 - 255) * t)
    g = int(240 + (137 - 240) * t)
    b = int(196 + (63 - 196) * t)
    for x in range(S):
        gp[x, y] = (r, g, b)
bg.paste(grad, (0, 0), mask)

# subtle top shine
d = ImageDraw.Draw(bg, "RGBA")
d.arc((cx-270, cy-270, cx+270, cy+270), 200, 340, fill=(255,255,255,28), width=2)
d.ellipse((cx-12, cy-292, cx+12, cy-268), fill=(216,184,108,190))

# downscale outputs
bg.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon-512.png"), optimize=True)
bg.resize((192, 192), Image.LANCZOS).save(os.path.join(OUT, "icon-192.png"), optimize=True)
bg.resize((180, 180), Image.LANCZOS).save(os.path.join(OUT, "apple-touch-icon.png"), optimize=True)
print("icons generated", os.listdir(OUT))

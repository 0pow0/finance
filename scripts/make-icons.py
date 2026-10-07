"""Generate the app icons in public/. Run: python3 scripts/make-icons.py (needs Pillow)."""
from PIL import Image, ImageDraw

BLUE = (37, 99, 235)
WHITE = (255, 255, 255)
LIGHT = (191, 211, 255)


def icon(size: int) -> Image.Image:
    s = size / 512
    img = Image.new("RGB", (size, size), BLUE)
    d = ImageDraw.Draw(img)
    # A card with ledger lines and a bar chart, kept inside the maskable safe zone.
    d.rounded_rectangle([116 * s, 140 * s, 396 * s, 372 * s], radius=28 * s, fill=WHITE)
    d.rectangle([116 * s, 182 * s, 396 * s, 212 * s], fill=LIGHT)
    for i, h in enumerate([60, 100, 80]):
        x = 156 + i * 60
        d.rounded_rectangle([x * s, (336 - h) * s, (x + 36) * s, 336 * s], radius=6 * s, fill=BLUE)
    return img


for size, name in [(192, "icon-192.png"), (512, "icon-512.png"), (180, "apple-touch-icon.png")]:
    icon(size).save(f"public/{name}", optimize=True)
    print("wrote", name)

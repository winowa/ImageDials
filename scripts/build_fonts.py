#!/usr/bin/env python3
"""Rebuild the bundled WOFF2 fonts from upstream variable fonts.

Requires fonttools and brotli (pinned in frontend/public/fonts/README.md);
they are not project dependencies. Download the upstream files listed there
into --source first, for example:

    uv run --with fonttools==4.68.0 --with brotli==1.2.1 \
        python scripts/build_fonts.py --source <dir> --out frontend/public/fonts
"""

import argparse
import io
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

LATIN = (
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,"
    "U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2190-2193,U+2212,U+2215,"
    "U+FEFF,U+FFFD"
)

# (upstream file under --source, output name, axis limits, rename or None)
FONTS = [
    (
        "BricolageGrotesque[opsz,wdth,wght].ttf",
        "BricolageGrotesque-latin-700.woff2",
        {"wdth": 100, "opsz": 36, "wght": 700},
        ("Bricolage Grotesque", "Bold"),
    ),
    (
        "AtkinsonHyperlegibleNext[wght].ttf",
        "AtkinsonHyperlegibleNext-latin-wght.woff2",
        {"wght": (400, 700)},
        None,
    ),
    (
        "JetBrainsMono[wght].ttf",
        "JetBrainsMono-latin-wght.woff2",
        {"wght": (400, 700)},
        None,
    ),
]


def rename_static_instance(font: TTFont, family: str, style: str) -> None:
    """Name a pinned instance after its family (the font keeps its glyphs)."""
    names = font["name"]
    full = f"{family} {style}"
    postscript = f"{family.replace(' ', '')}-{style}"
    for name_id, value in ((1, family), (2, style), (4, full), (6, postscript)):
        names.setName(value, name_id, 3, 1, 0x409)
        names.setName(value, name_id, 1, 0, 0)
    names.removeNames(nameID=16)
    names.removeNames(nameID=17)
    names.removeNames(nameID=3)


def build(source: Path, target: Path, limits: dict, static_name=None) -> None:
    font = instancer.instantiateVariableFont(TTFont(source), limits)
    if static_name:
        rename_static_instance(font, *static_name)
    # Reload so the subsetter sees fully materialised variation data.
    buffer = io.BytesIO()
    font.save(buffer)
    buffer.seek(0)
    font = TTFont(buffer)
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.hinting = False
    options.notdef_outline = True
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=subset.parse_unicodes(LATIN))
    subsetter.subset(font)
    font.flavor = "woff2"
    font.save(target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for name, output, limits, static_name in FONTS:
        build(args.source / name, args.out / output, limits, static_name)
        print(f"{output}: {(args.out / output).stat().st_size} bytes")


if __name__ == "__main__":
    main()

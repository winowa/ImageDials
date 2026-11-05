"""Shared content validation and active-content fingerprints."""

import copy
import hashlib
import json
import math
import re
from xml.etree import ElementTree

from .watermark_policy import WATERMARK_POLICY

MAX_TEXT_LINES = 4
MAX_TEXT_LINE_CODEPOINTS = 16
MAX_SVG_BYTES = 65536
MAX_SETTINGS_JSON_BYTES = MAX_SVG_BYTES + 1024
MAX_SVG_GEOMETRY_UNITS = 1_000_000
SVG_NAMESPACE = "http://www.w3.org/2000/svg"
SVG_ALLOWED_ELEMENTS = {
    "svg",
    "g",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "defs",
    "linearGradient",
    "radialGradient",
    "stop",
    "clipPath",
    "mask",
    "use",
    "symbol",
    "title",
    "desc",
}
LIMITS = {
    "max_lines": MAX_TEXT_LINES,
    "max_line_length": MAX_TEXT_LINE_CODEPOINTS,
    "max_svg_bytes": MAX_SVG_BYTES,
}
DEFAULT_WATERMARK_SETTINGS = {
    "type": "text",
    "text": "ImageDials",
    "svg_markup": "",
    "svg_recolor": True,
}


def validate_svg(markup):
    if not isinstance(markup, str) or not markup.strip():
        raise ValueError("Provide SVG artwork")
    if len(markup.encode()) > MAX_SVG_BYTES:
        raise ValueError("SVG exceeds the UTF-8 byte limit")
    if re.search(r"<!\s*(DOCTYPE|ENTITY)", markup, re.IGNORECASE):
        raise ValueError("SVG document declarations are not supported")
    try:
        root = ElementTree.fromstring(markup)
    except ElementTree.ParseError as exc:
        raise ValueError("SVG markup is invalid") from exc
    if root.tag not in {"svg", f"{{{SVG_NAMESPACE}}}svg"}:
        raise ValueError("Artwork must have an SVG root")
    viewbox = root.get("viewBox")
    try:
        if viewbox:
            values = [float(value) for value in re.split(r"[\s,]+", viewbox.strip())]
            if (
                len(values) != 4
                or not all(
                    math.isfinite(value) and abs(value) <= MAX_SVG_GEOMETRY_UNITS
                    for value in values
                )
                or min(values[2:]) <= 0
            ):
                raise ValueError()
        else:
            width, height = (
                float(re.sub(r"px$", "", root.get(name, "")))
                for name in ("width", "height")
            )
            if not all(
                math.isfinite(value) and 0 < value <= MAX_SVG_GEOMETRY_UNITS
                for value in (width, height)
            ):
                raise ValueError()
    except ValueError as exc:
        raise ValueError(
            "SVG needs a valid viewBox or numeric width and height"
        ) from exc
    for element in root.iter():
        if element.tag.startswith("{") and not element.tag.startswith(
            f"{{{SVG_NAMESPACE}}}"
        ):
            raise ValueError("Artwork elements must use the SVG namespace")
        tag = element.tag.split("}")[-1]
        if tag not in SVG_ALLOWED_ELEMENTS:
            raise ValueError(f"Unsupported SVG element: {tag}")
        for name, value in element.attrib.items():
            attribute = name.split("}")[-1].lower()
            if attribute == "base" or "\\" in value:
                raise ValueError(
                    "SVG base paths and escaped resource expressions are not allowed"
                )
            if attribute.startswith("on"):
                raise ValueError("SVG event handlers are not allowed")
            if attribute == "href" and not re.fullmatch(
                r"#[A-Za-z_][\w:.-]*", value.strip()
            ):
                raise ValueError("SVG references must stay inside the artwork")
            if re.search(
                r"expression\s*\(|@import|javascript:|data:|https?:|//",
                value,
                re.IGNORECASE,
            ):
                raise ValueError("Active or external SVG content is not allowed")
            for reference in re.findall(r"url\s*\((.*?)\)", value, re.IGNORECASE):
                if not re.fullmatch(
                    r"#[A-Za-z_][\w:.-]*", reference.strip().strip("\"'")
                ):
                    raise ValueError("SVG resources must stay inside the artwork")
    if root.tag == "svg":
        root.set("xmlns", SVG_NAMESPACE)
    normalized = ElementTree.tostring(root, encoding="unicode")
    if len(normalized.encode()) > MAX_SVG_BYTES:
        raise ValueError("Normalized SVG exceeds the UTF-8 byte limit")
    return normalized


def normalize_settings(body):
    if not isinstance(body, dict) or body.get("type") not in {"text", "svg"}:
        raise ValueError("Choose text or SVG watermark content")
    settings = copy.deepcopy(DEFAULT_WATERMARK_SETTINGS)
    settings["type"] = body["type"]
    recolor = body.get("svg_recolor", True)
    if type(recolor) is not bool:
        raise ValueError("SVG recolor must be a boolean")
    settings["svg_recolor"] = recolor
    if settings["type"] == "text":
        if not isinstance(body.get("text"), str):
            raise ValueError("Provide watermark text")
        lines = [line.strip() for line in body["text"].splitlines() if line.strip()]
        if not 1 <= len(lines) <= MAX_TEXT_LINES:
            raise ValueError("Use one to four nonblank text lines")
        if any(len(line) > MAX_TEXT_LINE_CODEPOINTS for line in lines):
            raise ValueError(
                "Each text line may contain at most sixteen Unicode code points"
            )
        settings["text"] = "\n".join(lines)
    else:
        settings["svg_markup"] = validate_svg(body.get("svg_markup"))
        settings["text"] = ""
    return settings


def settings_response(settings):
    active = {"type": settings["type"]}
    if settings["type"] == "text":
        active["text"] = settings["text"]
    else:
        active.update(
            svg_markup=settings["svg_markup"], svg_recolor=settings["svg_recolor"]
        )
    encoded = json.dumps(
        active, sort_keys=True, ensure_ascii=False, separators=(",", ":")
    ).encode()
    return {
        **copy.deepcopy(settings),
        "fingerprint": hashlib.sha256(encoded).hexdigest(),
        "limits": LIMITS.copy(),
        "rendering": copy.deepcopy(WATERMARK_POLICY),
    }


def watermark_settings(store):
    return settings_response(store.setting("watermark", DEFAULT_WATERMARK_SETTINGS))

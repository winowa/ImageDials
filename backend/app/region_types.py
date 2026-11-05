"""Bounded region selections in EXIF-oriented base-image pixel coordinates."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator

REGION_MAX_SHAPES = 64
REGION_MAX_POINTS = 4096
REGION_MAX_EDGE = 32768
REGION_MAX_PIXELS = 32_000_000
REGION_MAX_RADIUS = 2048
REGION_MAX_FEATHER = 32


class RectangleSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["rectangle"]
    x: StrictInt = Field(ge=0, le=REGION_MAX_EDGE)
    y: StrictInt = Field(ge=0, le=REGION_MAX_EDGE)
    width: StrictInt = Field(gt=0, le=REGION_MAX_EDGE)
    height: StrictInt = Field(gt=0, le=REGION_MAX_EDGE)


class BrushSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["brush"]
    radius: StrictInt = Field(gt=0, le=REGION_MAX_RADIUS)
    points: list[tuple[StrictInt, StrictInt]] = Field(
        min_length=1, max_length=REGION_MAX_POINTS
    )


SelectionShape = Annotated[
    RectangleSelection | BrushSelection, Field(discriminator="kind")
]


class RegionSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal[1] = 1
    source_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    width: StrictInt = Field(gt=0, le=REGION_MAX_EDGE)
    height: StrictInt = Field(gt=0, le=REGION_MAX_EDGE)
    shapes: list[SelectionShape] = Field(min_length=1, max_length=REGION_MAX_SHAPES)
    feather: StrictInt = Field(default=0, ge=0, le=REGION_MAX_FEATHER)

    @model_validator(mode="after")
    def bounded_selection(self):
        if self.width * self.height > REGION_MAX_PIXELS:
            raise ValueError("Region editing exceeds the decoded pixel limit")
        points = 0
        for shape in self.shapes:
            if isinstance(shape, RectangleSelection):
                if (
                    shape.x + shape.width > self.width
                    or shape.y + shape.height > self.height
                ):
                    raise ValueError("The selected rectangle is outside the base image")
            else:
                points += len(shape.points)
                if points > REGION_MAX_POINTS:
                    raise ValueError("The region selection has too many brush points")
                if shape.radius > max(self.width, self.height) or any(
                    x < 0 or y < 0 or x >= self.width or y >= self.height
                    for x, y in shape.points
                ):
                    raise ValueError("The brush selection is outside the base image")
        return self


def region_editing_capability(enabled, max_pixels=REGION_MAX_PIXELS):
    return {
        "enabled": bool(enabled),
        "protocol": "region-selection-v1",
        "method": "generated-image-composite",
        "native_mask": False,
        "tools": ["rectangle", "brush"],
        "coordinates": "oriented-base-pixels",
        "output_geometry": "oriented-base",
        "provider_fit": "cover-center",
        "outside_selection": "exact-rgba8",
        "max_shapes": REGION_MAX_SHAPES,
        "max_points": REGION_MAX_POINTS,
        "max_radius": REGION_MAX_RADIUS,
        "max_feather": REGION_MAX_FEATHER,
        "max_edge": REGION_MAX_EDGE,
        "max_pixels": min(max_pixels, REGION_MAX_PIXELS),
    }

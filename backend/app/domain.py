"""Validated generation snapshots and project-owned prompt composition."""

import re
from typing import Any, Literal

from pydantic import (
    BaseModel,
    Field,
    FiniteFloat,
    PrivateAttr,
    StrictBool,
    StrictFloat,
    StrictInt,
    field_validator,
    model_validator,
)

from .control_catalog import ASSET_CATALOG, STANDARD_CATALOG
from .control_context import MAX_CONTEXT_CATEGORIES
from .reference_types import MAX_REFERENCE_SLOTS, ReferenceContext, ReferenceImage
from .region_types import RegionSelection
from .variation_types import MAX_VARIATION_COUNT, VariationRetry

ASSET_IMAGE_INSTRUCTIONS = (
    "Depict exactly one standalone object, fully visible and centered with a clear margin, "
    "as a clean source image for image-to-3D conversion, not a mesh or a scene. "
    "Use a completely blank, uniform solid black, neutral gray, or white background: "
    "choose whichever contrasts most with the object's colors and silhouette. "
    "Use even lighting that reveals the object's shape and surface detail. "
    "No scenery, floor, horizon, gradients, cast shadows, props, text, borders, "
    "extra objects, duplicate views, or cropped parts. "
    "Interpret setting requests as object design details where possible; "
    "the single-object and blank-background requirements take precedence over conflicting scene or background controls."
)


MAX_RANGE_LABEL_CHARACTERS = 40


class Option(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    label: str = Field(min_length=1, max_length=200)


class Category(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    label: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=300)
    type: Literal[
        "single", "multi", "range", "select", "radio", "checkbox", "text", "binary"
    ] = "single"
    origin: Literal["generated", "fixed", "custom"] = "generated"
    value: str | list[str] | StrictBool | StrictFloat | None
    options: list[Option] = Field(default_factory=list, max_length=50)
    min: FiniteFloat = 0
    max: FiniteFloat = 100
    step: FiniteFloat = Field(default=1, gt=0)
    placeholder: str = Field(default="", max_length=200)
    true_label: str = Field(default="Yes", max_length=100)
    false_label: str = Field(default="No", max_length=100)
    # Optional meanings of a range's endpoints. Absent is not an empty label:
    # missing labels stay missing so readers never invent a direction.
    min_label: str | None = Field(
        default=None,
        max_length=MAX_RANGE_LABEL_CHARACTERS,
        exclude_if=lambda value: value is None,
    )
    max_label: str | None = Field(
        default=None,
        max_length=MAX_RANGE_LABEL_CHARACTERS,
        exclude_if=lambda value: value is None,
    )

    @field_validator("min_label", "max_label", mode="before")
    @classmethod
    def blank_endpoint_label_is_absent(cls, value):
        if isinstance(value, str):
            return value.strip() or None
        return value

    @model_validator(mode="after")
    def valid_value(self):
        ids = [o.id for o in self.options]
        if len(ids) != len(set(ids)):
            raise ValueError("Duplicate option IDs")
        if self.type == "range":
            if (
                isinstance(self.value, bool)
                or not isinstance(self.value, (int, float))
                or self.min >= self.max
                or not self.min <= self.value <= self.max
            ):
                raise ValueError("Range value outside bounds")
        elif self.type in {"multi", "checkbox"}:
            if not isinstance(self.value, list) or not set(self.value) <= set(ids):
                raise ValueError("Invalid multiple choice")
        elif self.type == "text":
            if not isinstance(self.value, str) or len(self.value) > 1000:
                raise ValueError(
                    "Text value must be a string of at most 1000 characters"
                )
        elif self.type == "binary":
            if type(self.value) is not bool:
                raise ValueError("Binary value must be a boolean")
        elif self.value is not None and (
            not isinstance(self.value, str) or self.value not in ids
        ):
            raise ValueError("Invalid selected option")
        return self


class Draft(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    mode: Literal["image", "asset-image"] = "image"
    revision: int = Field(default=0, ge=0)
    reference_context: list[ReferenceContext] = Field(
        default_factory=list, max_length=MAX_REFERENCE_SLOTS, exclude=True
    )

    @model_validator(mode="after")
    def not_blank(self):
        self.prompt = self.prompt.strip()
        if not self.prompt:
            raise ValueError("Enter an image idea")
        return self


class PromptDraft(Draft):
    aspect: Literal["3:2", "2:3", "1:1"] = "3:2"
    categories: list[Category] = Field(
        default_factory=list, max_length=MAX_CONTEXT_CATEGORIES
    )

    @model_validator(mode="after")
    def unique_categories(self):
        ids = [c.id for c in self.categories]
        if len(ids) != len(set(ids)):
            raise ValueError("Duplicate category IDs")
        return self


class Generation(PromptDraft):
    idempotency_key: str = Field(min_length=1, max_length=100)
    # Canonical snapshots remain lossless; categories are the legacy renderer adapter.
    selected_controls: list[dict[str, Any]] | None = None
    resolved_controls: list[dict[str, Any]] | None = None
    dynamic_controls_metadata: dict[str, Any] | None = None
    additional_controls_metadata: list[dict[str, Any]] = Field(
        default_factory=list, max_length=MAX_CONTEXT_CATEGORIES
    )
    must_have_terms: list[str] = Field(default_factory=list)
    requested_dimensions: tuple[int, int] | None = None
    reference_images: list[ReferenceImage] = Field(
        default_factory=list,
        max_length=MAX_REFERENCE_SLOTS,
        exclude_if=lambda references: not references,
    )
    variation_count: StrictInt = Field(
        default=1, ge=1, le=MAX_VARIATION_COUNT, exclude_if=lambda count: count == 1
    )
    retry_variations: VariationRetry | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    region_edit: RegionSelection | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    _variation: dict[str, Any] | None = PrivateAttr(default=None)
    _reference_inputs: tuple[dict[str, Any], ...] = PrivateAttr(default=())

    @model_validator(mode="after")
    def retry_count(self):
        if (
            self.retry_variations
            and len(self.retry_variations.indices) != self.variation_count
        ):
            raise ValueError("Variation count must match the retry selection")
        if self.region_edit:
            if not self.reference_images:
                raise ValueError("Region editing needs an attached base reference")
            base = self.reference_images[0]
            if base.sha256 != self.region_edit.source_sha256 or (
                base.dimensions.width,
                base.dimensions.height,
            ) != (self.region_edit.width, self.region_edit.height):
                raise ValueError(
                    "The region selection belongs to a different base image"
                )
        return self


def choices(label, labels, origin="fixed", kind="single"):
    def slug(value):
        return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")

    return Category(
        id=slug(label),
        label=label,
        origin=origin,
        type=kind,
        value=[slug(labels[0])] if kind in {"multi", "checkbox"} else slug(labels[0]),
        options=[Option(id=slug(v), label=v) for v in labels],
    )


def fixed_controls(mode):
    catalog = ASSET_CATALOG if mode == "asset-image" else STANDARD_CATALOG
    controls = []
    for index, (label, options, kind, description) in enumerate(catalog):
        control = choices(label, options, kind=kind)
        control.description = description
        # Preserve the existing four defaults without imposing new constraints
        # merely because more controls are available.
        if index >= 4:
            control.value = [] if kind in {"multi", "checkbox"} else None
        controls.append(control)
    return controls


def resolved_value(category):
    if category.type in {"range", "text", "binary"}:
        return category.value
    selected = category.value if isinstance(category.value, list) else [category.value]
    return [option.label for option in category.options if option.id in selected]


def compose(draft, categories):
    parts = [draft.prompt.rstrip(". ") + "."]
    for category in categories:
        value = resolved_value(category)
        if category.type == "binary":
            text = category.true_label if value else category.false_label
        elif isinstance(value, list):
            text = ", ".join(value)
        else:
            text = str(value) if value is not None else ""
        if text:
            parts.append(f"{category.label}: {text}.")
    references = getattr(draft, "reference_images", None) or getattr(
        draft, "reference_context", None
    )
    if draft.mode == "asset-image" and not references:
        parts.append(ASSET_IMAGE_INSTRUCTIONS)
    return " ".join(parts)

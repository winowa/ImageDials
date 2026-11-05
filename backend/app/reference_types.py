"""Small public reference descriptors; image bytes never enter snapshots."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_serializer

# Absolute request envelope for every reference path. It bounds parsing and
# storage only; it is not a claim that any model accepts this many. The
# effective per-model limit comes from the selected provider's capability.
MAX_REFERENCE_SLOTS = 16
MAX_REFERENCE_BYTES = 32 * 1024 * 1024
MAX_REFERENCE_TOTAL_BYTES = 64 * 1024 * 1024
MAX_REFERENCE_DESCRIPTION_CHARACTERS = 4000
MAX_REFERENCE_REQUEST_BYTES = 1024 * 1024


class ReferenceContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=128)
    description: str = Field(
        default="", max_length=MAX_REFERENCE_DESCRIPTION_CHARACTERS
    )
    role: str = Field(default="reference", min_length=1, max_length=80)


class ReferenceDimensions(BaseModel):
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class ReferenceSource(BaseModel):
    """The uploaded original a smaller model copy was prepared from."""

    model_config = ConfigDict(extra="forbid")

    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    # Captures the measured PNG budget so kept-original recovery can reproduce
    # the exact prepared bytes, independent of a later provider selection.
    max_normalized_bytes: int | None = Field(
        default=None, ge=1024, le=MAX_REFERENCE_BYTES
    )

    @model_serializer(mode="wrap")
    def serialize(self, handler):
        result = handler(self)
        if self.max_normalized_bytes is None:
            result.pop("max_normalized_bytes", None)
        return result


class ReferenceDescriptor(ReferenceContext):
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    # Present only when the sent bytes are a prepared copy of a larger original.
    source: ReferenceSource | None = None


class ReferenceImage(ReferenceDescriptor):
    filename: str = Field(min_length=1, max_length=255)
    index: int = Field(ge=1, le=MAX_REFERENCE_SLOTS)
    dimensions: ReferenceDimensions
    content_type: Literal["image/png", "image/jpeg", "image/webp"]

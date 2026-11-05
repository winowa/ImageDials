"""Bounded explicit variation requests; default single generation stays unchanged."""

from pydantic import BaseModel, Field, StrictInt, model_validator

MAX_VARIATION_COUNT = 4


class VariationRetry(BaseModel):
    group_id: str = Field(min_length=1, max_length=100)
    indices: list[StrictInt] = Field(min_length=1, max_length=MAX_VARIATION_COUNT)

    @model_validator(mode="after")
    def valid_indices(self):
        if len(set(self.indices)) != len(self.indices) or any(
            index < 0 or index >= MAX_VARIATION_COUNT for index in self.indices
        ):
            raise ValueError("Retry only distinct variation indices")
        return self

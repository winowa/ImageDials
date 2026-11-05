"""Model-specific reference prompting rules shared by proposal, composition and UI.

Each strategy owns how ordered reference images are named in an editing prompt
and the concise guidance shown to people writing one. Only strategies that
match an actually supported model contract belong here.
"""

import re
from dataclasses import dataclass

DEFAULT_REFERENCE_PROMPT_STRATEGY = "qwen-image-2.1"
MAX_REFERENCE_LABEL_ATTEMPTS = 2


@dataclass(frozen=True)
class ReferencePromptStrategy:
    id: str
    model: str
    single_label: str
    marker_template: str
    # The model's documented maximum ordered references; None when the model
    # documents no maximum, which leaves editing unavailable rather than guessed.
    max_references: int | None
    max_references_source: str
    guidance: tuple[str, ...]
    guidance_url: str
    example_single: str
    example_multiple: str
    proposal_rules: str
    composition_rules: str
    forbidden_labels: tuple[str, ...] = ()

    def label(self, index, count):
        """Prompt label for 1-based `index` among `count` ordered references."""
        if count <= 1:
            return self.single_label
        return self.marker_template.format(index=index)

    def labels(self, count):
        return [self.label(index, count) for index in range(1, count + 1)]

    def example(self, count):
        """The concrete example with the live labels of `count` references."""
        template = self.example_single if count <= 1 else self.example_multiple
        labels = self.labels(max(count, 1))
        for index in range(len(labels), 0, -1):
            label = labels[index - 1]
            template = template.replace(f"{{{index}}}", label)
        return template

    def label_problem(self, text, count):
        """Why `text` breaks the native reference-label contract, or None.

        Multiple references require every exact marker in actual order range
        and nothing else; natural prose such as "the second image" does not
        bind an input. One reference uses no numbered marker at all.
        """
        found = re.findall(r"<\s*image\s*(\d+)\s*>", text, flags=re.IGNORECASE)
        exact = [int(n) for n in re.findall(r"<image([1-9]\d?)>", text)]
        if len(found) != len(exact):
            return "Use the exact lowercase markers such as <image1>, without spaces."
        for pattern in self.forbidden_labels:
            if re.search(pattern, text, flags=re.IGNORECASE):
                return "Use only the model's own image markers, not other label styles."
        if count <= 1:
            return (
                "Refer to the single image naturally, without numbered markers."
                if exact
                else None
            )
        extra = sorted({n for n in exact if n > count})
        if extra:
            return f"There are only {count} images; remove <image{extra[0]}>."
        missing = [n for n in range(1, count + 1) if n not in exact]
        if missing:
            return "Include every image marker; missing: " + ", ".join(
                f"<image{n}>" for n in missing
            )
        return None

    def marker(self, index, count):
        """Literal marker for multiple references; None for a single image."""
        return None if count <= 1 else self.marker_template.format(index=index)

    def deterministic_proposal(self, prompt, ordered):
        """Model-shaped proposal without a language model (mock or no LLM)."""
        count = len(ordered)
        request = prompt.strip()
        if count == 1:
            description = ordered[0]["description"].strip()
            lead = (
                f"{request.rstrip('.')}, using {self.single_label} as the source."
                if request
                else f"Edit {self.single_label}."
            )
            return (
                f"{lead} It shows: {description} "
                "Keep everything not mentioned unchanged."
            )
        labels = self.labels(count)
        base = labels[0]
        others = ", ".join(labels[1:])
        lead = (
            f"{request.rstrip('.')}. Edit {base} using {others}."
            if request
            else f"Edit {base} using {others}."
        )
        roles = [
            f"{label} ({'base' if index == 0 else item.get('role') or 'reference'}): "
            f"{item['description'].strip()}"
            for index, (label, item) in enumerate(zip(labels, ordered, strict=True))
        ]
        return (
            f"{lead} "
            + " ".join(role.rstrip(".") + "." for role in roles)
            + f" Preserve everything in {base} that is not mentioned."
        )

    def capability(self, count):
        """Prompting help for exactly `count` effective reference slots."""
        return {
            "strategy": self.id,
            "model": self.model,
            "max_references": count,
            "labels": {str(n): self.labels(n) for n in range(1, count + 1)},
            "guidance": list(self.guidance),
            "guidance_url": self.guidance_url,
            "example_single": self.example_single,
            "example_multiple": self.example_multiple,
        }


QWEN_IMAGE_21 = ReferencePromptStrategy(
    id="qwen-image-2.1",
    model="Qwen-Image-2.1",
    single_label="the image",
    marker_template="<image{index}>",
    # Official model card and source README, "Versatile Editing": up to 10
    # reference images (Hugging Face revision d26bb612, read 2026-11-04).
    max_references=10,
    max_references_source="https://huggingface.co/Qwen/Qwen-Image-2.1",
    guidance=(
        "Lead with the change; name the subject or region to edit.",
        "With multiple images, use the displayed tags and say what each supplies.",
        "Specify what must stay unchanged; match the base image's lighting and perspective.",
        "With one image, use natural wording without tags.",
    ),
    guidance_url=(
        "https://github.com/QwenLM/Qwen-Image-2.1/blob/main/"
        "prompt_rewrite/prompts/system_prompt_edit.txt"
    ),
    # {1} and {2} are replaced with the live labels of the first two references.
    example_single="Recolor the jacket in {1} deep green. Keep the face, pose and background.",
    example_multiple=(
        "Place the lamp from {2} on the table in {1}. "
        "Match the room's light on the lamp. Keep everything else in {1}."
    ),
    proposal_rules=(
        "Lead with the edit operation. Treat the first reference as the base image and give every "
        "other reference one clear role, stating which subject, region or style comes from it. "
        "Preserve the base's unmentioned content. Refer to one image naturally as the image, "
        "without numbered labels. For multiple images use only the literal markers <image1>, "
        "<image2>, etc. in the supplied order. Never use <reference_1>, Picture 1 or other label styles."
    ),
    composition_rules=(
        "Write one precise image-editing instruction, beginning with the requested change. "
        "The supplied reference images are connected in the listed order. "
        "Use the first image as the base canvas; use other images only as the user's intent requires, "
        "giving each a clear role for the subject, region or style it supplies. "
        "Preserve unmentioned identity, objects, framing, style, text and background. "
        "Apply the user's idea and selected visual controls as explicit changes, not an unrelated new scene. "
        "For one image refer naturally to the supplied image, without numbered labels. "
        "For multiple images use literal <image1>, <image2>, and so on matching the listed indices. "
        "Never invent references or use Picture 1 or <reference_1> labels."
    ),
    forbidden_labels=(
        r"<\s*reference[ _-]?\d+\s*>",
        r"<\s*picture\s*\d+\s*>",
        r"\bpicture\s+\d+\b",
        r"<\s*subject\s*\d+\s*>",
    ),
)

STRATEGIES = {QWEN_IMAGE_21.id: QWEN_IMAGE_21}


def reference_prompt_strategy(env):
    """The configured strategy; unknown names fail clearly at startup."""
    name = (
        env.get("IMAGE_EDIT_PROMPT_STRATEGY") or DEFAULT_REFERENCE_PROMPT_STRATEGY
    ).strip()
    try:
        return STRATEGIES[name]
    except KeyError:
        raise ValueError(
            "IMAGE_EDIT_PROMPT_STRATEGY must be one of: "
            + ", ".join(sorted(STRATEGIES))
        ) from None

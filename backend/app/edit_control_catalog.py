"""Optional editing instructions, not renderer parameters or preservation guarantees.

Versioned IDs keep this catalog separate from historical text/asset catalogs.
The normal wire resolver and editing composer resolve these choices exactly like
other selected controls. Nothing applies until the person opts in.
"""

from .domain import Category, Option


def edit_controls():
    preservation = (
        (
            "identity",
            "Preserve identity",
            ("Facial features", "Distinctive markings", "Body or object proportions"),
        ),
        ("pose", "Preserve pose", ("Body pose", "Expression", "Gaze direction")),
        (
            "composition",
            "Preserve composition",
            ("Subject placement", "Camera viewpoint", "Crop"),
        ),
    )
    controls = [
        Category(
            id=f"edit-{identifier}-v1",
            label=label,
            description="Choose what the edit should retain from the base image.",
            type="multi",
            origin="fixed",
            value=[],
            options=[
                Option(id=text.lower().replace(" ", "-"), label=text)
                for text in options
            ],
        )
        for identifier, label, options in preservation
    ]
    for identifier, label, placeholder in (
        (
            "background",
            "Background change",
            "Describe the replacement or background change",
        ),
        ("objects", "Object changes", "Name what to add, remove or replace"),
        (
            "appearance",
            "Appearance change",
            "Describe changes to color, materials or lighting",
        ),
    ):
        controls.append(
            Category(
                id=f"edit-{identifier}-v1",
                label=label,
                type="text",
                origin="fixed",
                value="",
                placeholder=placeholder,
                description="An optional change instruction for the image editor.",
            )
        )
    return controls

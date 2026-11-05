"""Oriented sRGB pixels for reference model copies, without source mutation."""

import io

from PIL import Image, ImageCms, ImageOps


def oriented_reference_pixels(data):
    with Image.open(io.BytesIO(data)) as source:
        source.load()
        image = ImageOps.exif_transpose(source)
        profile = source.info.get("icc_profile")
        # PNG 16-bit greyscale loads as I or I;16. Conversion to RGB alone
        # clips everything above 255; scale its full range before conversion.
        if image.mode in {"I", "I;16", "I;16B", "I;16L"}:
            image = (
                image.convert("I")
                .point(lambda value: value * (255 / 65535) + 0.5)
                .convert("L")
            )
        if profile:
            try:
                alpha = image.convert("RGBA").getchannel("A")
                color = (
                    image.convert("RGB") if image.mode in {"RGBA", "P", "PA"} else image
                )
                image = ImageCms.profileToProfile(
                    color,
                    ImageCms.ImageCmsProfile(io.BytesIO(profile)),
                    ImageCms.createProfile("sRGB"),
                    outputMode="RGB",
                ).convert("RGBA")
                image.putalpha(alpha)
            except (OSError, ValueError, ImageCms.PyCMSError):
                # Broken/unsupported embedded profiles cannot be applied.
                # Pillow's native conversion still handles untagged CMYK.
                image = image.convert("RGBA")
        else:
            image = image.convert("RGBA")
    image.info.clear()
    image.getexif().clear()
    return image

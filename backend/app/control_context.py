"""Small category descriptors for inference context, never other option lists."""

MAX_CONTEXT_CATEGORIES = 30
CONTEXT_FIELDS = {"id": 200, "label": 200, "kind": 80, "description": 1000}


def category_summaries(categories):
    if not isinstance(categories, list) or len(categories) > MAX_CONTEXT_CATEGORIES:
        raise ValueError("Provide at most 30 category descriptors")
    result = []
    seen = set()
    for category in categories:
        if not isinstance(category, dict):
            raise ValueError("Each category descriptor must be an object")
        summary = {}
        for field, maximum in CONTEXT_FIELDS.items():
            value = category.get(field)
            if value is None and field in {"id", "description"}:
                continue
            if not isinstance(value, str) or len(value) > maximum:
                raise ValueError("Invalid category descriptor")
            if field in {"label", "kind"} and not value.strip():
                raise ValueError("Category label and kind must be nonempty")
            summary[field] = value
        identity = (summary.get("id"), summary["label"].casefold(), summary["kind"])
        if identity not in seen:
            result.append(summary)
            seen.add(identity)
    return result

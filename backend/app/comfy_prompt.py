"""Read the positive prompt text from ComfyUI PNG workflow metadata.

The graph is treated strictly as bounded data: nothing is executed, no file or
URL in it is followed, and only text reached from a sampler's positive
conditioning is returned. Negative conditioning is never followed.
"""

import json

MAX_GRAPH_TEXT_BYTES = 1024 * 1024
MAX_GRAPH_NODES = 1000
MAX_LINKS = 4000
MAX_TRACE_DEPTH = 32
MAX_PROMPT_CHARACTERS = 4000

# Inputs that carry the positive branch from a sampler or guider.
SAMPLER_POSITIVE_INPUTS = ("positive",)
GUIDER_INPUTS = ("guider",)
GUIDER_POSITIVE_INPUTS = ("positive", "conditioning", "cond1", "cond2")
# Inputs that pass conditioning through modifier nodes (never "negative").
CONDITIONING_INPUTS = (
    "conditioning",
    "positive",
    "conditioning_1",
    "conditioning_2",
    "conditioning_to",
    "conditioning_from",
    "cond",
)
# Text widgets of text-encoder nodes, in preference order.
TEXT_INPUTS = ("text", "prompt", "text_g", "t5xxl", "clip_l", "text_l")
# Inputs of plain string nodes a text widget may be linked to.
STRING_INPUTS = ("value", "text", "string", "prompt")


def _is_sampler(class_type):
    return isinstance(class_type, str) and (
        class_type.startswith("KSampler") or class_type.startswith("SamplerCustom")
    )


def _is_text_encoder(class_type):
    return isinstance(class_type, str) and "TextEncode" in class_type


def _bounded_json(raw):
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_GRAPH_TEXT_BYTES:
        return None
    try:
        value = json.loads(raw)
    except (TypeError, ValueError, RecursionError):
        return None
    return value


class _Graph:
    """Uniform view: node id -> (class_type, {input name: str | link node id})."""

    def __init__(self, nodes):
        self.nodes = nodes
        self.visited = set()

    def text_from(self, node_id, depth=0):
        """Positive prompt text reachable from a conditioning output."""
        # Each conditioning node is visited at most once, so shared branches and
        # cycles cannot multiply the work.
        if (
            depth > MAX_TRACE_DEPTH
            or node_id not in self.nodes
            or node_id in self.visited
        ):
            return None
        self.visited.add(node_id)
        class_type, inputs = self.nodes[node_id]
        if _is_text_encoder(class_type):
            for name in TEXT_INPUTS:
                text = self.string_from(inputs.get(name), depth + 1)
                if text:
                    return text
            return None
        names = (
            GUIDER_POSITIVE_INPUTS
            if "Guider" in str(class_type)
            else CONDITIONING_INPUTS
        )
        for name in names:
            link = inputs.get(name)
            if isinstance(link, _Link):
                text = self.text_from(link.node, depth + 1)
                if text:
                    return text
        return None

    def string_from(self, value, depth):
        if isinstance(value, str):
            return value.strip() or None
        if not isinstance(value, _Link) or depth > MAX_TRACE_DEPTH:
            return None
        node = self.nodes.get(value.node)
        key = ("string", value.node)
        if node is None or _is_text_encoder(node[0]) or key in self.visited:
            return None
        self.visited.add(key)
        for name in STRING_INPUTS:
            text = self.string_from(node[1].get(name), depth + 1)
            if text:
                return text
        return None

    def positive_prompt(self):
        def order(key):
            text = str(key)
            # Numeric ids in numeric order without converting unbounded digits.
            return (0, len(text), text) if text.isdecimal() else (1, 0, text)

        for node_id in sorted(self.nodes, key=order):
            class_type, inputs = self.nodes[node_id]
            if not _is_sampler(class_type):
                continue
            self.visited = set()
            for name in SAMPLER_POSITIVE_INPUTS:
                link = inputs.get(name)
                if isinstance(link, _Link):
                    text = self.text_from(link.node)
                    if text:
                        return text
            for name in GUIDER_INPUTS:
                link = inputs.get(name)
                if isinstance(link, _Link):
                    text = self.text_from(link.node)
                    if text:
                        return text
        return None


class _Link:
    __slots__ = ("node",)

    def __init__(self, node):
        self.node = node


def _api_graph(value):
    """ComfyUI API prompt: {"id": {"class_type": str, "inputs": {...}}}."""
    if not isinstance(value, dict) or len(value) > MAX_GRAPH_NODES:
        return None
    nodes = {}
    for node_id, node in value.items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type")
        raw_inputs = node.get("inputs")
        if not isinstance(class_type, str) or not isinstance(raw_inputs, dict):
            continue
        inputs = {}
        for name, item in raw_inputs.items():
            if isinstance(item, str):
                inputs[name] = item
            elif (
                isinstance(item, list)
                and len(item) == 2
                and isinstance(item[0], (str, int))
                and not isinstance(item[0], bool)
            ):
                inputs[name] = _Link(str(item[0]))
        nodes[str(node_id)] = (class_type, inputs)
    return _Graph(nodes) if nodes else None


def _ui_graph(value):
    """ComfyUI UI workflow: {"nodes": [...], "links": [[id, from, slot, to, slot, type]]}."""
    if not isinstance(value, dict):
        return None
    raw_nodes, raw_links = value.get("nodes"), value.get("links")
    if (
        not isinstance(raw_nodes, list)
        or len(raw_nodes) > MAX_GRAPH_NODES
        or not isinstance(raw_links, list)
        or len(raw_links) > MAX_LINKS
    ):
        return None
    sources = {}
    for link in raw_links:
        if (
            isinstance(link, list)
            and len(link) >= 4
            and all(
                isinstance(part, int) and not isinstance(part, bool)
                for part in link[:4]
            )
        ):
            sources[link[0]] = str(link[1])
    nodes = {}
    for node in raw_nodes:
        if not isinstance(node, dict):
            continue
        node_id, class_type = node.get("id"), node.get("type")
        if not isinstance(node_id, (int, str)) or not isinstance(class_type, str):
            continue
        inputs = {}
        raw_inputs = node.get("inputs")
        for slot in raw_inputs if isinstance(raw_inputs, list) else []:
            if (
                isinstance(slot, dict)
                and isinstance(slot.get("name"), str)
                and isinstance(slot.get("link"), int)
                and not isinstance(slot["link"], bool)
                and slot.get("link") in sources
            ):
                inputs[slot["name"]] = _Link(sources[slot["link"]])
        widgets = node.get("widgets_values")
        if (
            isinstance(widgets, list)
            and widgets
            and isinstance(widgets[0], str)
            and (
                _is_text_encoder(class_type)
                or "String" in class_type
                or "Text" in class_type
            )
        ):
            name = "text" if _is_text_encoder(class_type) else "value"
            inputs.setdefault(name, widgets[0])
        nodes[str(node_id)] = (class_type, inputs)
    return _Graph(nodes) if nodes else None


def comfyui_positive_prompt(info):
    """Positive prompt text from PNG text chunks, or None when none is safe to use."""
    for key, parse in (("prompt", _api_graph), ("workflow", _ui_graph)):
        value = _bounded_json(info.get(key))
        graph = parse(value) if value is not None else None
        text = graph.positive_prompt() if graph else None
        if text and len(text) <= MAX_PROMPT_CHARACTERS:
            return text
    return None

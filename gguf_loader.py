"""Dedicated GGUF UNET loader using the installed GGUF extension's native path."""

import sys

import folder_paths


def _loader_class():
    # Use the same metadata-aware implementation as the installed `GGUF Loader`
    # node. Do not fall back to a different GGUF integration here.
    for module in tuple(sys.modules.values()):
        mappings = getattr(module, "NODE_CLASS_MAPPINGS", None) if module is not None else None
        loader = mappings.get("LoaderGGUF") if isinstance(mappings, dict) else None
        if loader is not None and getattr(loader, "__module__", "").endswith("pig"):
            return loader
    return None


def _gguf_names():
    names = []
    for category in ("model_gguf", "unet_gguf"):
        try:
            names.extend(folder_paths.get_filename_list(category))
        except Exception:
            continue
    return list(dict.fromkeys(name for name in names if name.lower().endswith(".gguf")))


class TimeGGUFLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"gguf_name": (_gguf_names(),)}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "load_gguf"
    CATEGORY = "Time AI/模型加载"
    DESCRIPTION = "Load a GGUF UNET with the installed metadata-aware GGUF Loader extension."
    SEARCH_ALIASES = ["gguf loader", "gguf unet", "GGUF加载器", "GGUF模型加载"]

    def load_gguf(self, gguf_name):
        loader = _loader_class()
        if loader is None:
            raise RuntimeError(
                "Time GGUF Loader requires the installed GGUF extension that provides LoaderGGUF."
            )
        return loader().load_model(gguf_name)
